import Foundation

/// One successfully read scalar and when it was read.
public struct Observation: Equatable, Sendable {
    public let value: JSONValue
    public let observedAt: String
    public init(value: JSONValue, observedAt: String) { self.value = value; self.observedAt = observedAt }
}

/// Pure session lifecycle state shared by the Catalyst helper. It holds no HomeKit objects, delegates or
/// consent UI: the adapter reports facts (an observed authorization, a home update, a reload result) and
/// this type decides what they mean. Every state change that could affect an in-flight read bumps
/// `generation`, so a stale read can never publish data into a newer session.
public struct SessionCoordinator: Sendable {
    public enum AuthorizationEffect: Equatable, Sendable {
        case none
        /// Authorization was lost while enabled. The session is disabled; the adapter must drop its manager.
        case releaseManager
    }

    public private(set) var session: ReadOnlySession
    public private(set) var generation: UInt64 = 0
    public private(set) var hasLoadedHomes = false
    private var observations: [UUID: Observation] = [:]

    /// Every launch starts disabled, unauthorized and deny-all.
    public init(configuration: BridgeConfiguration = .denyAll) {
        session = ReadOnlySession(configuration: configuration)
    }

    /// A failed or absent configuration (`nil`) revokes every previously allowed accessory immediately.
    public mutating func reloadConfiguration(_ loaded: BridgeConfiguration?) {
        generation &+= 1
        session.configuration = loaded ?? .denyAll
        observations.removeAll()
    }

    /// `managerExists` is whether the adapter already holds a home manager from an earlier enable.
    public mutating func enable(managerExists: Bool) {
        generation &+= 1
        if !managerExists {
            hasLoadedHomes = false
            session.homesReady = false
            session.authorization = .unknown
        }
        session.enabled = true
    }

    public mutating func disable() {
        generation &+= 1
        hasLoadedHomes = false
        session.enabled = false
        session.homesReady = false
        observations.removeAll()
    }

    /// Returns `false` (and changes nothing) unless this session is enabled; the adapter then ignores the update.
    @discardableResult
    public mutating func homesDidUpdate() -> Bool {
        guard session.enabled else { return false }
        generation &+= 1
        hasLoadedHomes = true
        observations.removeAll()
        return true
    }

    /// `observed == nil` means the adapter holds no manager. Losing authorization while enabled disables the session.
    @discardableResult
    public mutating func applyAuthorization(_ observed: Authorization?) -> AuthorizationEffect {
        guard let observed else { session.authorization = .notRequested; return .none }
        let previous = session.authorization
        session.authorization = observed
        session.homesReady = hasLoadedHomes && observed == .authorized
        guard observed != .authorized else { return .none }
        observations.removeAll()
        guard previous == .authorized else { return .none }
        generation &+= 1
        session.enabled = false
        session.homesReady = false
        hasLoadedHomes = false
        return .releaseManager
    }

    /// The token a read carries from start to finish.
    public var readToken: UInt64 { generation }
    public func isCurrent(_ token: UInt64) -> Bool { token == generation }

    public func observation(for characteristic: UUID) -> Observation? { observations[characteristic] }

    /// Old values are cleared before a refresh so a failed or timed-out read leaves no stale value behind.
    public mutating func invalidateObservations(for characteristics: [UUID]) {
        for characteristic in characteristics { observations.removeValue(forKey: characteristic) }
    }

    /// Stores a read result only if the session is unchanged, enabled, authorized and the accessory is still allowed.
    @discardableResult
    public mutating func record(_ value: JSONValue, observedAt: String, for characteristic: UUID,
                                accessoryId: String, token: UInt64) -> Bool {
        guard isCurrent(token), session.enabled, session.authorization == .authorized,
              session.configuration.allows(accessoryId) else { return false }
        observations[characteristic] = Observation(value: value, observedAt: observedAt)
        return true
    }
}

/// Exact-once completion for one bounded batch of characteristic reads. A completion arrives from the
/// last expected read or from the deadline, whichever comes first; duplicate, unknown and late reads are
/// ignored so they can neither finish the batch early nor reach the cache.
public struct RefreshTracker: Sendable {
    public static let maximumCharacteristics = 256

    public enum Step: Equatable, Sendable {
        /// Duplicate, unknown or late: do nothing with this event.
        case ignored
        /// Accepted; more reads are expected.
        case pending
        /// Accepted and the batch is finished: call the completion exactly now, once.
        case complete
    }

    private var pending: Set<UUID>
    public private(set) var isFinished: Bool

    /// An empty or over-limit batch is finished immediately: nothing is read and the caller completes at once.
    public init(expecting characteristics: [UUID]) {
        let oversized = characteristics.count > Self.maximumCharacteristics
        pending = oversized ? [] : Set(characteristics)
        isFinished = pending.isEmpty
    }

    public mutating func characteristicRead(_ characteristic: UUID) -> Step {
        guard !isFinished, pending.remove(characteristic) != nil else { return .ignored }
        guard pending.isEmpty else { return .pending }
        isFinished = true
        return .complete
    }

    public mutating func expire() -> Step {
        guard !isFinished else { return .ignored }
        isFinished = true
        pending.removeAll()
        return .complete
    }
}
