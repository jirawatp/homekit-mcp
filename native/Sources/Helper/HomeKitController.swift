import Foundation
import HomeKit
import UIKit

/// HomeKit objects are confined to the UI thread. Initializing this controller is safe:
/// HMHomeManager is constructed only by the user's visible Enable button action.
@MainActor final class HomeKitController: NSObject, @preconcurrency HMHomeManagerDelegate {
    private var manager: HMHomeManager?
    /// Lifecycle, generation and cache rules live in the Foundation-only (tested) coordinator; this class
    /// only owns the HomeKit objects and reports facts to it.
    private var coordinator = SessionCoordinator()
    var session: ReadOnlySession { coordinator.session }
    private(set) var configURL: URL?
    private var securityScopedURL: URL?
    var changed: (() -> Void)?
    private(set) var configurationError: String?

    init(configURL: URL?) {
        self.configURL = configURL
        super.init()
        reloadConfiguration()
    }

    func reloadConfiguration() {
        configurationError = nil
        var loaded: BridgeConfiguration?
        if let configURL {
            do { loaded = try BridgeConfiguration.load(from: configURL) }
            catch { configurationError = "Invalid or unreadable configuration. All accessories are denied." }
        } else {
            configurationError = "No --config path supplied. All accessories are denied."
        }
        // A failed reload (nil) revokes all previously allowed accessories immediately.
        coordinator.reloadConfiguration(loaded)
        changed?()
    }

    /// The standard picker gives the sandbox read-only access for this process, without bookmarks.
    func selectConfigurationFromUserAction(_ url: URL) {
        securityScopedURL?.stopAccessingSecurityScopedResource()
        securityScopedURL = url.startAccessingSecurityScopedResource() ? url : nil
        configURL = url
        reloadConfiguration()
    }

    /// This method is never exposed over stdio.
    func enableFromUserAction() {
        let managerExists = manager != nil
        coordinator.enable(managerExists: managerExists)
        if !managerExists {
            let newManager = HMHomeManager() // The sole HomeKit authorization-triggering line.
            manager = newManager
            newManager.delegate = self
        }
        updateAuthorization()
    }

    func disableFromUserAction() {
        coordinator.disable()
        manager?.delegate = nil
        manager = nil
        changed?()
    }

    func homeManagerDidUpdateHomes(_ manager: HMHomeManager) {
        guard manager === self.manager, coordinator.homesDidUpdate() else { return }
        updateAuthorization()
    }

    func homeManager(_ manager: HMHomeManager, didUpdate status: HMHomeManagerAuthorizationStatus) {
        guard manager === self.manager, session.enabled else { return }
        updateAuthorization()
    }

    private func updateAuthorization() {
        guard let manager else { coordinator.applyAuthorization(nil); changed?(); return }
        let status = manager.authorizationStatus
        let observed: Authorization
        if status.contains(.restricted) { observed = .restricted }
        else if status.contains(.authorized) { observed = .authorized }
        else if status.contains(.determined) { observed = .denied }
        else { observed = .notRequested }
        if coordinator.applyAuthorization(observed) == .releaseManager {
            manager.delegate = nil
            self.manager = nil
        }
        changed?()
    }

    /// Names and UUIDs appear only in the user's local foreground UI after authorization.
    func localInventoryDescription() -> String {
        guard session.enabled, session.authorization == .authorized, session.homesReady, let manager else { return "No HomeKit inventory has been loaded." }
        return manager.homes.flatMap(\.accessories).filter { !isCamera($0) }.map { accessory in
            "\(accessory.name)\n\(accessory.uniqueIdentifier.uuidString)"
        }.joined(separator: "\n\n")
    }

    private func isCamera(_ accessory: HMAccessory) -> Bool {
        accessory.category.categoryType == HMAccessoryCategoryTypeIPCamera ||
        accessory.category.categoryType == HMAccessoryCategoryTypeVideoDoorbell ||
        accessory.profiles.contains { $0 is HMCameraProfile } ||
        accessory.services.contains { [HMServiceTypeCameraRTPStreamManagement, HMServiceTypeCameraControl, HMServiceTypeMicrophone, HMServiceTypeDoorbell].contains($0.serviceType) }
    }

    func handle(_ request: BridgeRequest, reply: @escaping (BridgeResponse) -> Void) {
        if manager != nil { updateAuthorization() }
        do { try session.authorize(request) }
        catch let error as BridgeError { reply(.failure(request.id, error)); return }
        catch { reply(.failure(request.id, BridgeError("internal_error", "Request validation failed."))); return }
        guard request.command != "status", let manager else { reply(session.process(request)); return }

        let allowed = manager.homes.flatMap(\.accessories).filter {
            session.configuration.allows($0.uniqueIdentifier.uuidString) && !isCamera($0) &&
            (request.command != "read_accessory" || $0.uniqueIdentifier == UUID(uuidString: request.accessoryId ?? ""))
        }
        // list_accessories uses only successfully observed values from previous explicit reads.
        // read_accessory refreshes characteristics without subscribing or actuating a device.
        guard request.command == "read_accessory", let accessory = allowed.first else {
            reply(session.process(request, accessories: allowed.map(snapshot))); return
        }
        let requestToken = coordinator.readToken
        refresh(accessory, token: requestToken) { [weak self] in
            guard let self else { return }
            // Recheck authorization/allowlist after asynchronous reads (revocation can occur mid-flight).
            self.updateAuthorization()
            guard self.coordinator.isCurrent(requestToken) else {
                reply(.failure(request.id, BridgeError("session_changed", "Session, home data or allowlist changed during the read.")))
                return
            }
            let current = self.manager?.homes.flatMap(\.accessories).filter {
                self.session.configuration.allows($0.uniqueIdentifier.uuidString) && !self.isCamera($0) &&
                $0.uniqueIdentifier == UUID(uuidString: request.accessoryId ?? "")
            } ?? []
            reply(self.session.process(request, accessories: current.map(self.snapshot)))
        }
    }

    private func refresh(_ accessory: HMAccessory, token: UInt64, completion: @escaping () -> Void) {
        let characteristics = accessory.services.filter { SafeReadPolicy.allowsService($0.serviceType) }.flatMap(\.characteristics).filter {
            $0.properties.contains(HMCharacteristicPropertyReadable) && SafeReadPolicy.allowsCharacteristic($0.characteristicType)
        }
        let identifiers = characteristics.map(\.uniqueIdentifier)
        coordinator.invalidateObservations(for: identifiers)
        // The tracker guarantees `completion` runs exactly once: from the last expected read or the deadline.
        var tracker = RefreshTracker(expecting: identifiers)
        guard !tracker.isFinished else { completion(); return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
            if tracker.expire() == .complete { completion() }
        }
        for characteristic in characteristics {
            characteristic.readValue { [weak self] error in
                DispatchQueue.main.async {
                    guard let self else { return }
                    let step = tracker.characteristicRead(characteristic.uniqueIdentifier)
                    guard step != .ignored else { return }
                    if error == nil, let value = Self.scalarValue(characteristic.value) {
                        self.coordinator.record(value, observedAt: timestamp(), for: characteristic.uniqueIdentifier,
                                                accessoryId: accessory.uniqueIdentifier.uuidString, token: token)
                    }
                    if step == .complete { completion() }
                }
            }
        }
    }

    /// Binary/TLV, strings, arrays, images and arbitrary object descriptions never cross the pipe.
    private static func scalarValue(_ value: Any?) -> JSONValue? {
        if let number = value as? NSNumber {
            if CFGetTypeID(number) == CFBooleanGetTypeID() { return .bool(number.boolValue) }
            return number.doubleValue.isFinite ? .number(number.doubleValue) : nil
        }
        return nil
    }

    private func snapshot(_ accessory: HMAccessory) -> AccessorySnapshot {
        let now = timestamp()
        return AccessorySnapshot(
            id: accessory.uniqueIdentifier.uuidString, name: accessory.name, room: accessory.room?.name, roomId: accessory.room?.uniqueIdentifier.uuidString,
            category: accessory.category.categoryType, reachable: accessory.isReachable, observedAt: now,
            services: accessory.services.filter { SafeReadPolicy.allowsService($0.serviceType) }.compactMap { service in
                let characteristics = service.characteristics.filter {
                    $0.properties.contains(HMCharacteristicPropertyReadable) && SafeReadPolicy.allowsCharacteristic($0.characteristicType)
                }
                guard !characteristics.isEmpty else { return nil }
                return ServiceSnapshot(id: service.uniqueIdentifier.uuidString, type: service.serviceType, name: service.name,
                    characteristics: characteristics.map { characteristic in
                    let cached = coordinator.observation(for: characteristic.uniqueIdentifier)
                    return CharacteristicSnapshot(id: characteristic.uniqueIdentifier.uuidString, type: characteristic.characteristicType,
                        value: cached?.value, readable: true, observedAt: cached?.observedAt ?? now)
                })
            }, containsCamera: isCamera(accessory))
    }
}
