import Foundation
import HomeKit
import UIKit

/// HomeKit objects are confined to the UI thread. Initializing this controller is safe:
/// HMHomeManager is constructed only by the user's visible Enable button action.
@MainActor final class HomeKitController: NSObject, @preconcurrency HMHomeManagerDelegate {
    private var manager: HMHomeManager?
    private(set) var session = ReadOnlySession()
    private var valueCache: [UUID: (JSONValue, String)] = [:]
    private var generation: UInt64 = 0
    private var hasLoadedHomes = false
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
        generation &+= 1
        // A failed reload revokes all previously allowed accessories immediately.
        session.configuration = .denyAll
        configurationError = nil
        guard let configURL else { configurationError = "No --config path supplied. All accessories are denied."; changed?(); return }
        do { session.configuration = try BridgeConfiguration.load(from: configURL) }
        catch { configurationError = "Invalid or unreadable configuration. All accessories are denied." }
        valueCache.removeAll()
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
        generation &+= 1
        guard manager == nil else { session.enabled = true; updateAuthorization(); return }
        hasLoadedHomes = false
        session.enabled = true
        session.authorization = .unknown
        let newManager = HMHomeManager() // The sole HomeKit authorization-triggering line.
        manager = newManager
        newManager.delegate = self
        updateAuthorization()
    }

    func disableFromUserAction() {
        generation &+= 1
        hasLoadedHomes = false
        session.enabled = false
        session.homesReady = false
        manager?.delegate = nil
        manager = nil
        valueCache.removeAll()
        changed?()
    }

    func homeManagerDidUpdateHomes(_ manager: HMHomeManager) {
        guard manager === self.manager, session.enabled else { return }
        generation &+= 1
        hasLoadedHomes = true
        valueCache.removeAll()
        updateAuthorization()
    }

    func homeManager(_ manager: HMHomeManager, didUpdate status: HMHomeManagerAuthorizationStatus) {
        guard manager === self.manager, session.enabled else { return }
        updateAuthorization()
    }

    private func updateAuthorization() {
        guard let manager else { session.authorization = .notRequested; changed?(); return }
        let previous = session.authorization
        let status = manager.authorizationStatus
        if status.contains(.restricted) { session.authorization = .restricted }
        else if status.contains(.authorized) { session.authorization = .authorized }
        else if status.contains(.determined) { session.authorization = .denied }
        else { session.authorization = .notRequested }
        session.homesReady = hasLoadedHomes && session.authorization == .authorized
        if session.authorization != .authorized {
            valueCache.removeAll()
            if previous == .authorized {
                generation &+= 1
                session.enabled = false
                session.homesReady = false
                hasLoadedHomes = false
                manager.delegate = nil
                self.manager = nil
            }
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
        let requestGeneration = generation
        refresh(accessory, generation: requestGeneration) { [weak self] in
            guard let self else { return }
            // Recheck authorization/allowlist after asynchronous reads (revocation can occur mid-flight).
            self.updateAuthorization()
            guard requestGeneration == self.generation else {
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

    private func refresh(_ accessory: HMAccessory, generation requestGeneration: UInt64, completion: @escaping () -> Void) {
        let characteristics = accessory.services.filter { SafeReadPolicy.allowsService($0.serviceType) }.flatMap(\.characteristics).filter {
            $0.properties.contains(HMCharacteristicPropertyReadable) && SafeReadPolicy.allowsCharacteristic($0.characteristicType)
        }
        for characteristic in characteristics { valueCache.removeValue(forKey: characteristic.uniqueIdentifier) }
        guard characteristics.count <= 256 else { completion(); return }
        var remaining = characteristics.count
        guard remaining > 0 else { completion(); return }
        var finished = false
        let finish = {
            guard !finished else { return }
            finished = true
            completion()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { finish() }
        for characteristic in characteristics {
            characteristic.readValue { [weak self] error in
                DispatchQueue.main.async {
                    guard let self, !finished else { return }
                    if error == nil, self.generation == requestGeneration, self.session.enabled, self.session.authorization == .authorized,
                       self.session.configuration.allows(accessory.uniqueIdentifier.uuidString),
                       let value = Self.scalarValue(characteristic.value) {
                        self.valueCache[characteristic.uniqueIdentifier] = (value, timestamp())
                    }
                    remaining -= 1
                    if remaining == 0 { finish() }
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
                    let cached = valueCache[characteristic.uniqueIdentifier]
                    return CharacteristicSnapshot(id: characteristic.uniqueIdentifier.uuidString, type: characteristic.characteristicType,
                        value: cached?.0, readable: true, observedAt: cached?.1 ?? now)
                })
            }, containsCamera: isCamera(accessory))
    }
}
