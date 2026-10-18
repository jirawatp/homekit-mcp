import Foundation
import Darwin

public enum JSONValue: Codable, Equatable, Sendable {
    case null, bool(Bool), number(Double), string(String), array([JSONValue]), object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let bool = try? value.decode(Bool.self) { self = .bool(bool) }
        else if let number = try? value.decode(Double.self), number.isFinite { self = .number(number) }
        else if let string = try? value.decode(String.self) { self = .string(string) }
        else if let array = try? value.decode([JSONValue].self) { self = .array(array) }
        else { self = .object(try value.decode([String: JSONValue].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .null: try value.encodeNil()
        case .bool(let bool): try value.encode(bool)
        case .number(let number): try value.encode(number)
        case .string(let string): try value.encode(string)
        case .array(let array): try value.encode(array)
        case .object(let object): try value.encode(object)
        }
    }

    public static func encoded<T: Encodable>(_ value: T) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value))
    }
}

public struct BridgeError: Error, Codable, Equatable, Sendable {
    public let code: String
    public let message: String
    public init(_ code: String, _ message: String) { self.code = code; self.message = message }
}

private struct AnyKey: CodingKey {
    let stringValue: String
    let intValue: Int? = nil
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}

public struct BridgeConfiguration: Decodable, Sendable {
    public let version: Int
    public let allowedAccessoryIds: [String]
    public let mode: String
    public static let denyAll = try! BridgeConfiguration(version: 1, allowedAccessoryIds: [], mode: "read-only")

    public init(version: Int, allowedAccessoryIds: [String], mode: String) throws {
        guard version == 1, mode == "read-only", allowedAccessoryIds.count <= 256 else {
            throw BridgeError("invalid_config", "Require version 1, mode read-only and at most 256 accessory UUIDs.")
        }
        let ids = try allowedAccessoryIds.map { value -> String in
            guard let uuid = UUID(uuidString: value), value.count == 36 else {
                throw BridgeError("invalid_config", "Every allowlist entry must be an explicit accessory UUID.")
            }
            return uuid.uuidString
        }
        guard Set(ids).count == ids.count else { throw BridgeError("invalid_config", "Duplicate accessory UUIDs are not allowed.") }
        self.version = version; self.allowedAccessoryIds = ids; self.mode = mode
    }

    public init(from decoder: Decoder) throws {
        let all = try decoder.container(keyedBy: AnyKey.self)
        guard Set(all.allKeys.map(\.stringValue)) == ["version", "allowedAccessoryIds", "mode"] else {
            throw BridgeError("invalid_config", "Configuration must contain only version, allowedAccessoryIds and mode.")
        }
        let values = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(version: values.decode(Int.self, forKey: .version),
                      allowedAccessoryIds: values.decode([String].self, forKey: .allowedAccessoryIds),
                      mode: values.decode(String.self, forKey: .mode))
    }
    private enum CodingKeys: CodingKey { case version, allowedAccessoryIds, mode }

    public static func load(from url: URL) throws -> BridgeConfiguration {
        guard url.isFileURL else { throw BridgeError("invalid_config", "Configuration must be a local regular file.") }
        // Open once, then inspect that exact descriptor. NONBLOCK prevents a FIFO/device
        // path from hanging before the regular-file check; regular files ignore it.
        let descriptor = url.path.withCString { Darwin.open($0, O_RDONLY | O_NONBLOCK | O_CLOEXEC) }
        guard descriptor >= 0 else { throw BridgeError("invalid_config", "Unable to open the configuration file.") }
        let file = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? file.close() }
        var metadata = stat()
        guard Darwin.fstat(descriptor, &metadata) == 0,
              (metadata.st_mode & mode_t(S_IFMT)) == mode_t(S_IFREG),
              metadata.st_size >= 0, metadata.st_size <= 65_536 else {
            throw BridgeError("invalid_config", "Configuration must be a regular file no larger than 64 KiB.")
        }
        // Still bounded if the same file grows after fstat. Incomplete reads fail JSON
        // decoding; no unbounded Data(contentsOf:) allocation is used.
        guard let data = try file.read(upToCount: 65_537), data.count <= 65_536 else {
            throw BridgeError("invalid_config", "Configuration exceeds 64 KiB or is unreadable.")
        }
        return try JSONDecoder().decode(Self.self, from: data)
    }
    public func allows(_ id: String) -> Bool {
        guard let uuid = UUID(uuidString: id) else { return false }
        return allowedAccessoryIds.contains(uuid.uuidString)
    }
}

public struct BridgeRequest: Codable, Sendable {
    public let id: String
    public let command: String
    public let accessoryId: String?
    public init(id: String, command: String, accessoryId: String? = nil) {
        self.id = id; self.command = command; self.accessoryId = accessoryId
    }
    public static func decode(_ data: Data) throws -> BridgeRequest {
        let raw = try JSONDecoder().decode([String: JSONValue].self, from: data)
        guard Set(raw.keys).isSubset(of: ["id", "command", "accessoryId"]) else {
            throw BridgeError("invalid_request", "Unexpected request fields.")
        }
        let request = try JSONDecoder().decode(Self.self, from: data)
        guard !request.id.isEmpty, request.id.utf8.count <= 128 else {
            throw BridgeError("invalid_request", "Request id must be 1 to 128 UTF-8 bytes.")
        }
        return request
    }
}

public struct BridgeResponse: Codable, Sendable {
    public let id: String
    public let ok: Bool
    public let result: JSONValue?
    public let error: BridgeError?
    public static func success(_ id: String, _ value: JSONValue) -> Self { .init(id: id, ok: true, result: value, error: nil) }
    public static func failure(_ id: String, _ error: BridgeError) -> Self { .init(id: id, ok: false, result: nil, error: error) }
}

public struct CharacteristicSnapshot: Codable, Equatable, Sendable {
    public let id: String
    public let type: String
    public let value: JSONValue?
    public let readable: Bool
    public let observedAt: String
    public init(id: String, type: String, value: JSONValue?, readable: Bool, observedAt: String) {
        self.id = id; self.type = type; self.value = value; self.readable = readable; self.observedAt = observedAt
    }
}
public struct ServiceSnapshot: Codable, Equatable, Sendable {
    public let id: String
    public let type: String
    public let name: String?
    public let characteristics: [CharacteristicSnapshot]
    public init(id: String, type: String, name: String?, characteristics: [CharacteristicSnapshot]) {
        self.id = id; self.type = type; self.name = name; self.characteristics = characteristics
    }
}
public struct AccessorySnapshot: Codable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let room: String?
    public let roomId: String?
    public let category: String?
    public let reachable: Bool
    public let observedAt: String
    public let services: [ServiceSnapshot]
    // Internal policy metadata is deliberately excluded from the wire response.
    public let containsCamera: Bool
    public init(id: String, name: String, room: String? = nil, roomId: String? = nil, category: String? = nil, reachable: Bool,
                observedAt: String, services: [ServiceSnapshot], containsCamera: Bool = false) {
        self.id = id; self.name = name; self.room = room; self.roomId = roomId; self.category = category; self.reachable = reachable
        self.observedAt = observedAt; self.services = services; self.containsCamera = containsCamera
    }
    private enum CodingKeys: String, CodingKey { case id, name, room, roomId, category, reachable, observedAt, services }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: try c.decode(String.self, forKey: .id), name: try c.decode(String.self, forKey: .name),
                  room: try c.decodeIfPresent(String.self, forKey: .room), roomId: try c.decodeIfPresent(String.self, forKey: .roomId), category: try c.decodeIfPresent(String.self, forKey: .category),
                  reachable: try c.decode(Bool.self, forKey: .reachable), observedAt: try c.decode(String.self, forKey: .observedAt),
                  services: try c.decode([ServiceSnapshot].self, forKey: .services))
    }
}

public enum Authorization: String, Codable, Sendable { case notRequested = "not_requested", authorized, denied, restricted, unknown }

public enum SafeReadPolicy {
    /// Reviewed public HAP sensor/state fields; no pairing, PIN, TLV, identifier or vendor fields.
    public static let characteristicTypes: Set<String> = Set([
        "11", "10", "71", "22", "6A", "68", "76", "69", "70", "6B", "95", "75", "25"
    ].map { String(repeating: "0", count: 8 - $0.count) + $0 + "-0000-1000-8000-0026BB765291" })
    public static let excludedServiceTypes: Set<String> = Set([
        "40", "44", "41", "7E", "110", "111", "112", "113", "121", "129"
    ].map { String(repeating: "0", count: 8 - $0.count) + $0 + "-0000-1000-8000-0026BB765291" })
    public static func allowsCharacteristic(_ type: String) -> Bool { characteristicTypes.contains(type.uppercased()) }
    public static func allowsService(_ type: String) -> Bool { !excludedServiceTypes.contains(type.uppercased()) }
    public static func scalar(_ value: JSONValue?) -> JSONValue? {
        switch value {
        case .bool: return value
        case .number(let number): return number.isFinite ? value : nil
        default: return nil
        }
    }
}

public struct ReadOnlySession: Sendable {
    public var configuration: BridgeConfiguration
    public var enabled = false
    public var authorization: Authorization = .notRequested
    public var homesReady = false
    public var platform = "mac-catalyst"
    public init(configuration: BridgeConfiguration = .denyAll) { self.configuration = configuration }

    public func authorize(_ request: BridgeRequest) throws {
        guard ["status", "list_accessories", "read_accessory"].contains(request.command) else {
            throw BridgeError("unsupported_command", "Only status, list_accessories and read_accessory are supported.")
        }
        guard request.command != "status" else { return }
        guard enabled else { throw BridgeError("access_disabled", "Enable this session in the helper app first.") }
        guard authorization == .authorized else { throw BridgeError("homekit_unauthorized", "HomeKit access is not authorized.") }
        guard homesReady else { throw BridgeError("homekit_not_ready", "Waiting for HomeKit home data.") }
        if request.command == "read_accessory" {
            guard let id = request.accessoryId, configuration.allows(id) else {
                throw BridgeError("accessory_not_allowed", "Accessory is absent from the explicit allowlist.")
            }
        }
    }

    public func process(_ request: BridgeRequest, accessories: [AccessorySnapshot] = [], now: String = timestamp()) -> BridgeResponse {
        do {
            try authorize(request)
            if request.command == "status" {
                return .success(request.id, .object([
                    "protocolVersion": .number(1), "platform": .string(platform),
                    "authorization": .string(authorization.rawValue), "enabled": .bool(enabled),
                    "readOnly": .bool(true), "allowlistedAccessoryCount": .number(Double(configuration.allowedAccessoryIds.count))
                ]))
            }
            let allowed = accessories.filter { configuration.allows($0.id) && !$0.containsCamera }.map { accessory in
                AccessorySnapshot(id: accessory.id, name: accessory.name, room: accessory.room, roomId: accessory.roomId, category: accessory.category,
                                  reachable: accessory.reachable, observedAt: accessory.observedAt,
                                  services: accessory.services.filter { SafeReadPolicy.allowsService($0.type) }.compactMap { service in
                    let safe = service.characteristics.filter { $0.readable && SafeReadPolicy.allowsCharacteristic($0.type) }.map { characteristic in
                        CharacteristicSnapshot(id: characteristic.id, type: characteristic.type,
                                               value: SafeReadPolicy.scalar(characteristic.value), readable: true, observedAt: characteristic.observedAt)
                    }
                    guard !safe.isEmpty else { return nil }
                    return ServiceSnapshot(id: service.id, type: service.type, name: service.name, characteristics: safe)
                })
            }
            if request.command == "list_accessories" {
                return .success(request.id, .object(["accessories": try .encoded(allowed), "observedAt": .string(now)]))
            }
            guard let accessory = allowed.first(where: { UUID(uuidString: $0.id) == UUID(uuidString: request.accessoryId ?? "") }) else {
                throw BridgeError("accessory_unavailable", "Allowed accessory is unavailable or excluded by camera policy.")
            }
            return .success(request.id, try .encoded(accessory))
        } catch let error as BridgeError { return .failure(request.id, error) }
        catch { return .failure(request.id, BridgeError("encoding_failed", "Unable to encode bridge result.")) }
    }
}

public func timestamp() -> String { ISO8601DateFormatter().string(from: Date()) }

/// Bounded NDJSON framing. A single oversized frame is fatal; callers close stdin processing.
public struct LineFramer {
    public let maximumBytes: Int
    private var buffer = Data()
    public init(maximumBytes: Int = 65_536) { self.maximumBytes = maximumBytes }
    public mutating func append(_ chunk: Data) throws -> [Data] {
        var lines: [Data] = []
        for byte in chunk {
            if byte == 10 {
                if !buffer.isEmpty { lines.append(buffer) }
                buffer.removeAll(keepingCapacity: true)
            } else {
                guard buffer.count < maximumBytes else { throw BridgeError("frame_too_large", "NDJSON frame exceeds the byte limit.") }
                buffer.append(byte)
            }
        }
        return lines
    }
    public var hasPartialFrame: Bool { !buffer.isEmpty }
}
