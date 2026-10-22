import XCTest
import Foundation
@testable import BridgeCore

/// Pure lifecycle rules, with synthetic identifiers only. These prove the Foundation coordination logic;
/// they do not exercise HMHomeManager, its delegate ordering, or any real authorization prompt.
final class SessionCoordinatorTests: XCTestCase {
    let allowedID = "11111111-1111-4111-8111-111111111111"
    let otherID = "22222222-2222-4222-8222-222222222222"
    let characteristic = UUID(uuidString: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA")!
    let observedAt = "2026-10-22T00:00:00Z"

    func config(_ ids: [String]? = nil) throws -> BridgeConfiguration {
        try BridgeConfiguration(version: 1, allowedAccessoryIds: ids ?? [allowedID], mode: "read-only")
    }

    /// Enabled, authorized, homes loaded and allowlisted: the only state in which reads are accepted.
    func readyCoordinator() throws -> SessionCoordinator {
        var coordinator = SessionCoordinator()
        coordinator.reloadConfiguration(try config())
        coordinator.enable(managerExists: false)
        XCTAssertEqual(coordinator.applyAuthorization(.authorized), .none)
        XCTAssertTrue(coordinator.homesDidUpdate())
        XCTAssertEqual(coordinator.applyAuthorization(.authorized), .none)
        XCTAssertTrue(coordinator.session.homesReady)
        return coordinator
    }

    func readCommand(_ coordinator: SessionCoordinator) -> BridgeResponse {
        coordinator.session.process(.init(id: "r", command: "list_accessories"))
    }

    // MARK: Deny-all start and enable

    func testStartsDisabledUnauthorizedAndDenyAll() {
        let coordinator = SessionCoordinator()
        XCTAssertFalse(coordinator.session.enabled)
        XCTAssertEqual(coordinator.session.authorization, .notRequested)
        XCTAssertFalse(coordinator.session.homesReady)
        XCTAssertTrue(coordinator.session.configuration.allowedAccessoryIds.isEmpty)
        XCTAssertEqual(readCommand(coordinator).error?.code, "access_disabled")
        XCTAssertTrue(coordinator.session.process(.init(id: "s", command: "status")).ok)
    }

    func testReadinessNeedsEnableAuthorizationAndAHomeUpdateInOrder() throws {
        var coordinator = SessionCoordinator()
        coordinator.reloadConfiguration(try config())
        XCTAssertEqual(readCommand(coordinator).error?.code, "access_disabled", "an allowlist alone grants nothing")
        coordinator.enable(managerExists: false)
        XCTAssertTrue(coordinator.session.enabled)
        XCTAssertEqual(coordinator.session.authorization, .unknown)
        XCTAssertEqual(readCommand(coordinator).error?.code, "homekit_unauthorized")
        coordinator.applyAuthorization(.authorized)
        XCTAssertFalse(coordinator.session.homesReady, "authorized but no home data yet")
        XCTAssertEqual(readCommand(coordinator).error?.code, "homekit_not_ready")
        XCTAssertTrue(coordinator.homesDidUpdate())
        coordinator.applyAuthorization(.authorized)
        XCTAssertTrue(readCommand(coordinator).ok)
    }

    func testHomeUpdateIsIgnoredWhileDisabled() {
        var coordinator = SessionCoordinator()
        let before = coordinator.generation
        XCTAssertFalse(coordinator.homesDidUpdate())
        XCTAssertEqual(coordinator.generation, before)
        XCTAssertFalse(coordinator.hasLoadedHomes)
    }

    func testEnablingWithAnExistingManagerKeepsAuthorizationButInvalidatesReads() throws {
        var coordinator = try readyCoordinator()
        let token = coordinator.readToken
        coordinator.enable(managerExists: true)
        XCTAssertFalse(coordinator.isCurrent(token))
        XCTAssertEqual(coordinator.session.authorization, .authorized)
        XCTAssertTrue(coordinator.hasLoadedHomes)
    }

    // MARK: Disable and revocation

    func testDisableRevokesAccessClearsValuesAndNeedsAFreshEnable() throws {
        var coordinator = try readyCoordinator()
        XCTAssertTrue(coordinator.record(.number(21), observedAt: observedAt, for: characteristic, accessoryId: allowedID, token: coordinator.readToken))
        let generation = coordinator.generation
        coordinator.disable()
        XCTAssertGreaterThan(coordinator.generation, generation)
        XCTAssertFalse(coordinator.session.enabled)
        XCTAssertFalse(coordinator.session.homesReady)
        XCTAssertFalse(coordinator.hasLoadedHomes)
        XCTAssertNil(coordinator.observation(for: characteristic))
        XCTAssertEqual(readCommand(coordinator).error?.code, "access_disabled")

        coordinator.enable(managerExists: false)
        XCTAssertEqual(coordinator.session.authorization, .unknown, "a new session does not inherit the old authorization")
        coordinator.applyAuthorization(.authorized)
        XCTAssertFalse(coordinator.session.homesReady, "home data from before the disable is not reused")
        XCTAssertEqual(readCommand(coordinator).error?.code, "homekit_not_ready")
    }

    func testLosingAuthorizationWhileEnabledDisablesTheSessionAndReleasesTheManager() throws {
        for lost in [Authorization.denied, .restricted, .notRequested] {
            var coordinator = try readyCoordinator()
            coordinator.record(.bool(true), observedAt: observedAt, for: characteristic, accessoryId: allowedID, token: coordinator.readToken)
            let token = coordinator.readToken
            XCTAssertEqual(coordinator.applyAuthorization(lost), .releaseManager, "\(lost)")
            XCTAssertEqual(coordinator.session.authorization, lost)
            XCTAssertFalse(coordinator.session.enabled)
            XCTAssertFalse(coordinator.session.homesReady)
            XCTAssertFalse(coordinator.hasLoadedHomes)
            XCTAssertNil(coordinator.observation(for: characteristic))
            XCTAssertFalse(coordinator.isCurrent(token))
            XCTAssertEqual(readCommand(coordinator).error?.code, "access_disabled")
        }
    }

    func testDenialBeforeAnyAuthorizationKeepsTheSessionEnabledAndStillDeniesReads() {
        var coordinator = SessionCoordinator()
        coordinator.enable(managerExists: false)
        XCTAssertEqual(coordinator.applyAuthorization(.denied), .none)
        XCTAssertTrue(coordinator.session.enabled)
        XCTAssertEqual(coordinator.session.authorization, .denied)
        XCTAssertEqual(readCommand(coordinator).error?.code, "homekit_unauthorized")
        XCTAssertEqual(coordinator.applyAuthorization(.authorized), .none, "a later grant is still honored")
    }

    func testNoManagerReportsNotRequestedWithoutChangingTheGeneration() throws {
        var coordinator = try readyCoordinator()
        let generation = coordinator.generation
        XCTAssertEqual(coordinator.applyAuthorization(nil), .none)
        XCTAssertEqual(coordinator.session.authorization, .notRequested)
        XCTAssertEqual(coordinator.generation, generation)
    }

    // MARK: Configuration reload

    func testFailedReloadRevokesThePreviousAllowlistAndValues() throws {
        var coordinator = try readyCoordinator()
        coordinator.record(.number(1), observedAt: observedAt, for: characteristic, accessoryId: allowedID, token: coordinator.readToken)
        let token = coordinator.readToken
        coordinator.reloadConfiguration(nil)
        XCTAssertTrue(coordinator.session.configuration.allowedAccessoryIds.isEmpty)
        XCTAssertFalse(coordinator.session.configuration.allows(allowedID))
        XCTAssertNil(coordinator.observation(for: characteristic))
        XCTAssertFalse(coordinator.isCurrent(token))
        let read = coordinator.session.process(.init(id: "r", command: "read_accessory", accessoryId: allowedID))
        XCTAssertEqual(read.error?.code, "accessory_not_allowed")
    }

    func testSuccessfulReloadReplacesTheAllowlistAndInvalidatesInFlightReads() throws {
        var coordinator = try readyCoordinator()
        let token = coordinator.readToken
        coordinator.reloadConfiguration(try config([otherID]))
        XCTAssertFalse(coordinator.isCurrent(token))
        XCTAssertTrue(coordinator.session.configuration.allows(otherID))
        XCTAssertFalse(coordinator.session.configuration.allows(allowedID))
        XCTAssertTrue(coordinator.session.enabled, "reloading the allowlist does not itself change the enabled state")
    }

    // MARK: Session changes during a read

    func testEverySessionChangeInvalidatesAnInFlightRead() throws {
        let changes: [(String, (inout SessionCoordinator) -> Void)] = [
            ("reload failure", { $0.reloadConfiguration(nil) }),
            ("reload success", { $0.reloadConfiguration(try! BridgeConfiguration(version: 1, allowedAccessoryIds: [self.allowedID], mode: "read-only")) }),
            ("disable", { $0.disable() }),
            ("enable again", { $0.enable(managerExists: true) }),
            ("home update", { _ = $0.homesDidUpdate() }),
            ("revocation", { _ = $0.applyAuthorization(.denied) }),
        ]
        for (name, change) in changes {
            var coordinator = try readyCoordinator()
            let token = coordinator.readToken
            XCTAssertTrue(coordinator.isCurrent(token), name)
            change(&coordinator)
            XCTAssertFalse(coordinator.isCurrent(token), name)
        }
    }

    func testUnrelatedAuthorizationRefreshDoesNotInvalidateARead() throws {
        var coordinator = try readyCoordinator()
        let token = coordinator.readToken
        coordinator.applyAuthorization(.authorized)
        XCTAssertTrue(coordinator.isCurrent(token))
    }

    // MARK: Cache admission

    func testRecordRequiresACurrentEnabledAuthorizedAllowlistedRead() throws {
        var coordinator = try readyCoordinator()
        let token = coordinator.readToken
        XCTAssertFalse(coordinator.record(.number(1), observedAt: observedAt, for: characteristic, accessoryId: otherID, token: token), "not allowlisted")
        XCTAssertNil(coordinator.observation(for: characteristic))
        XCTAssertFalse(coordinator.record(.number(1), observedAt: observedAt, for: characteristic, accessoryId: "not-a-uuid", token: token))
        XCTAssertFalse(coordinator.record(.number(1), observedAt: observedAt, for: characteristic, accessoryId: allowedID, token: token &+ 1), "stale token")
        XCTAssertTrue(coordinator.record(.number(1), observedAt: observedAt, for: characteristic, accessoryId: allowedID, token: token))
        XCTAssertEqual(coordinator.observation(for: characteristic), Observation(value: .number(1), observedAt: observedAt))

        var unauthorized = SessionCoordinator()
        unauthorized.reloadConfiguration(try config())
        unauthorized.enable(managerExists: false)
        XCTAssertFalse(unauthorized.record(.number(1), observedAt: observedAt, for: characteristic, accessoryId: allowedID, token: unauthorized.readToken), "unknown authorization")
        var disabled = SessionCoordinator()
        disabled.reloadConfiguration(try config())
        XCTAssertFalse(disabled.record(.number(1), observedAt: observedAt, for: characteristic, accessoryId: allowedID, token: disabled.readToken), "session not enabled")
    }

    func testLateResultAfterASessionChangeNeverReachesTheCache() throws {
        var coordinator = try readyCoordinator()
        let token = coordinator.readToken
        coordinator.disable()
        coordinator.enable(managerExists: false)
        coordinator.applyAuthorization(.authorized)
        _ = coordinator.homesDidUpdate()
        coordinator.applyAuthorization(.authorized)
        XCTAssertTrue(coordinator.session.homesReady, "the new session is fully ready, yet the old read is still refused")
        XCTAssertFalse(coordinator.record(.number(99), observedAt: observedAt, for: characteristic, accessoryId: allowedID, token: token))
        XCTAssertNil(coordinator.observation(for: characteristic))
    }

    func testRefreshClearsOnlyTheNamedCharacteristicsBeforeReading() throws {
        var coordinator = try readyCoordinator()
        let other = UUID(uuidString: "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB")!
        coordinator.record(.number(1), observedAt: observedAt, for: characteristic, accessoryId: allowedID, token: coordinator.readToken)
        coordinator.record(.number(2), observedAt: observedAt, for: other, accessoryId: allowedID, token: coordinator.readToken)
        coordinator.invalidateObservations(for: [characteristic])
        XCTAssertNil(coordinator.observation(for: characteristic), "a failed or timed-out refresh must not leave the old value behind")
        XCTAssertEqual(coordinator.observation(for: other)?.value, .number(2))
    }

    func testHomeUpdateClearsCachedValues() throws {
        var coordinator = try readyCoordinator()
        coordinator.record(.number(1), observedAt: observedAt, for: characteristic, accessoryId: allowedID, token: coordinator.readToken)
        XCTAssertTrue(coordinator.homesDidUpdate())
        XCTAssertNil(coordinator.observation(for: characteristic))
    }
}

final class RefreshTrackerTests: XCTestCase {
    func ids(_ count: Int) -> [UUID] { (0..<count).map { _ in UUID() } }

    func testCompletesExactlyOnceWhenTheLastExpectedReadArrives() {
        let batch = ids(3)
        var tracker = RefreshTracker(expecting: batch)
        XCTAssertFalse(tracker.isFinished)
        XCTAssertEqual(tracker.characteristicRead(batch[0]), .pending)
        XCTAssertEqual(tracker.characteristicRead(batch[2]), .pending)
        XCTAssertEqual(tracker.characteristicRead(batch[1]), .complete)
        XCTAssertTrue(tracker.isFinished)
    }

    func testDuplicateCallbackCannotFinishTheBatchEarly() {
        let batch = ids(2)
        var tracker = RefreshTracker(expecting: batch)
        XCTAssertEqual(tracker.characteristicRead(batch[0]), .pending)
        XCTAssertEqual(tracker.characteristicRead(batch[0]), .ignored, "the same read counted twice must not stand in for the missing one")
        XCTAssertFalse(tracker.isFinished)
        XCTAssertEqual(tracker.characteristicRead(batch[1]), .complete)
    }

    func testUnknownCharacteristicIsIgnored() {
        let batch = ids(1)
        var tracker = RefreshTracker(expecting: batch)
        XCTAssertEqual(tracker.characteristicRead(UUID()), .ignored)
        XCTAssertFalse(tracker.isFinished)
    }

    func testReadsAfterCompletionAreIgnored() {
        let batch = ids(1)
        var tracker = RefreshTracker(expecting: batch)
        XCTAssertEqual(tracker.characteristicRead(batch[0]), .complete)
        XCTAssertEqual(tracker.characteristicRead(batch[0]), .ignored)
        XCTAssertEqual(tracker.expire(), .ignored, "the deadline cannot complete a finished batch a second time")
    }

    func testDeadlineCompletesOnceAndLateReadsAreDiscarded() {
        let batch = ids(3)
        var tracker = RefreshTracker(expecting: batch)
        XCTAssertEqual(tracker.characteristicRead(batch[0]), .pending)
        XCTAssertEqual(tracker.expire(), .complete)
        XCTAssertTrue(tracker.isFinished)
        XCTAssertEqual(tracker.expire(), .ignored)
        XCTAssertEqual(tracker.characteristicRead(batch[1]), .ignored, "a value arriving after the deadline must not be recorded")
        XCTAssertEqual(tracker.characteristicRead(batch[2]), .ignored)
    }

    func testEmptyBatchIsFinishedImmediately() {
        var tracker = RefreshTracker(expecting: [])
        XCTAssertTrue(tracker.isFinished)
        XCTAssertEqual(tracker.expire(), .ignored)
    }

    func testBatchSizeLimitIsExactlyTheDocumentedMaximum() {
        XCTAssertEqual(RefreshTracker.maximumCharacteristics, 256)
        XCTAssertFalse(RefreshTracker(expecting: ids(256)).isFinished)
        var oversized = RefreshTracker(expecting: ids(257))
        XCTAssertTrue(oversized.isFinished, "an over-limit batch reads nothing and completes at once")
        XCTAssertEqual(oversized.characteristicRead(UUID()), .ignored)
    }
}
