import XCTest
import Darwin
@testable import BridgeCore

final class BridgeCoreTests: XCTestCase {
    let allowedID = "11111111-1111-4111-8111-111111111111"
    let deniedID = "22222222-2222-4222-8222-222222222222"
    let now = "2026-10-18T00:00:00Z"
    let temperature = "00000011-0000-1000-8000-0026BB765291"

    func session(_ ids: [String]? = nil) throws -> ReadOnlySession {
        var session = ReadOnlySession(configuration: try .init(version: 1, allowedAccessoryIds: ids ?? [allowedID], mode: "read-only"))
        session.enabled = true; session.authorization = .authorized; session.homesReady = true
        return session
    }
    func accessory(_ id: String? = nil, camera: Bool = false, services: [ServiceSnapshot]? = nil) -> AccessorySnapshot {
        .init(id: id ?? allowedID, name: "Synthetic room sensor", reachable: true, observedAt: now,
              services: services ?? [.init(id: "service", type: "0000008A-0000-1000-8000-0026BB765291", name: nil,
                characteristics: [.init(id: "char", type: temperature, value: .number(21.5), readable: true, observedAt: now)])], containsCamera: camera)
    }
    func decodedAccessory(_ response: BridgeResponse) throws -> AccessorySnapshot {
        try JSONDecoder().decode(AccessorySnapshot.self, from: JSONEncoder().encode(XCTUnwrap(response.result)))
    }

    func testDenyAllByDefaultAndStatusNeedsNoHomeKit() throws {
        let initial = ReadOnlySession()
        let status = initial.process(.init(id: "s", command: "status"))
        XCTAssertTrue(status.ok)
        XCTAssertEqual(status.result, .object(["protocolVersion": .number(1), "platform": .string("mac-catalyst"), "authorization": .string("not_requested"), "enabled": .bool(false), "readOnly": .bool(true), "allowlistedAccessoryCount": .number(0)]))
        XCTAssertEqual(initial.process(.init(id: "l", command: "list_accessories"), accessories: [accessory()]).error?.code, "access_disabled")
    }
    func testInvalidConfigurationFailsClosed() throws {
        for ids in [["*"], ["not-a-uuid"], [allowedID, allowedID]] {
            XCTAssertThrowsError(try BridgeConfiguration(version: 1, allowedAccessoryIds: ids, mode: "read-only"))
        }
        XCTAssertThrowsError(try BridgeConfiguration(version: 1, allowedAccessoryIds: [], mode: "write"))
        XCTAssertThrowsError(try BridgeConfiguration(version: 2, allowedAccessoryIds: [], mode: "read-only"))
        let extra = Data("{\"version\":1,\"mode\":\"read-only\",\"allowedAccessoryIds\":[],\"enable\":true}".utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(BridgeConfiguration.self, from: extra))
    }
    func testUUIDNormalizationIsExact() throws {
        let id = "ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF"
        let config = try BridgeConfiguration(version: 1, allowedAccessoryIds: [id.lowercased()], mode: "read-only")
        XCTAssertTrue(config.allows(id)); XCTAssertFalse(config.allows("*")); XCTAssertFalse(config.allows(id + " "))
    }
    func testConfigurationFileBoundaries() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("homekit-config-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("config.json")
        let valid = Data("{\"version\":1,\"mode\":\"read-only\",\"allowedAccessoryIds\":[]}".utf8)
        let limit = valid + Data(repeating: 32, count: 65_536 - valid.count)
        try limit.write(to: url)
        XCTAssertEqual(try BridgeConfiguration.load(from: url).allowedAccessoryIds, [])
        try (limit + Data([32])).write(to: url)
        XCTAssertThrowsError(try BridgeConfiguration.load(from: url)) { error in
            XCTAssertEqual((error as? BridgeError)?.code, "invalid_config")
        }
    }
    func testConfigurationRejectsNonregularFilesWithoutBlocking() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("homekit-config-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        XCTAssertThrowsError(try BridgeConfiguration.load(from: directory))
        let fifo = directory.appendingPathComponent("config-fifo")
        XCTAssertEqual(fifo.path.withCString { Darwin.mkfifo($0, 0o600) }, 0)
        XCTAssertThrowsError(try BridgeConfiguration.load(from: fifo)) { error in
            XCTAssertEqual((error as? BridgeError)?.code, "invalid_config")
        }
    }
    func testTruncatedConfigurationFailsClosed() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("homekit-partial-config-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        try Data("{\"version\":1,\"mode\":\"read-only\",\"allowedAccessoryIds\":[".utf8).write(to: url)
        XCTAssertThrowsError(try BridgeConfiguration.load(from: url))
    }
    func testAuthorizationAndReadyGates() throws {
        for auth in [Authorization.denied, .restricted, .notRequested, .unknown] {
            var state = try session(); state.authorization = auth
            XCTAssertEqual(state.process(.init(id: "r", command: "read_accessory", accessoryId: allowedID), accessories: [accessory()]).error?.code, "homekit_unauthorized")
        }
        var state = try session(); state.homesReady = false
        XCTAssertEqual(state.process(.init(id: "l", command: "list_accessories")).error?.code, "homekit_not_ready")
    }
    func testEveryWriteOrAuthorizationCommandRejected() throws {
        for command in ["write", "set_characteristic", "execute_scene", "unlock", "open_garage", "enable", "authorize", "subscribe", "camera_snapshot"] {
            XCTAssertEqual(try session().process(.init(id: "r", command: command)).error?.code, "unsupported_command")
        }
    }
    func testAllowlistRejectsBeforeReturningDiscovery() throws {
        let response = try session().process(.init(id: "r", command: "read_accessory", accessoryId: deniedID), accessories: [accessory(deniedID)])
        XCTAssertEqual(response.error?.code, "accessory_not_allowed")
        XCTAssertNil(response.result)
    }
    func testListDropsDisallowedAndCameraAccessories() throws {
        let state = try session([allowedID, deniedID])
        let response = state.process(.init(id: "l", command: "list_accessories"), accessories: [accessory(), accessory(deniedID, camera: true), accessory("33333333-3333-4333-8333-333333333333")], now: now)
        guard case .object(let object) = response.result, case .array(let list) = object["accessories"] else { return XCTFail("Missing list") }
        XCTAssertEqual(list.count, 1)
    }
    func testReadExcludesCameraEvenWhenAllowlisted() throws {
        XCTAssertEqual(try session().process(.init(id: "r", command: "read_accessory", accessoryId: allowedID), accessories: [accessory(camera: true)]).error?.code, "accessory_unavailable")
    }
    func testSafeCharacteristicAndServicePolicy() throws {
        let chars: [CharacteristicSnapshot] = [
            .init(id: "safe", type: temperature, value: .number(22), readable: true, observedAt: now),
            .init(id: "write-only", type: temperature, value: .number(2), readable: false, observedAt: now),
            .init(id: "pairing-secret", type: "0000004C-0000-1000-8000-0026BB765291", value: .string("secret"), readable: true, observedAt: now)
        ]
        let services: [ServiceSnapshot] = [
            .init(id: "sensor", type: "0000008A-0000-1000-8000-0026BB765291", name: nil, characteristics: chars),
            .init(id: "lock", type: "00000040-0000-1000-8000-0026BB765291", name: nil, characteristics: chars),
            .init(id: "garage", type: "00000041-0000-1000-8000-0026BB765291", name: nil, characteristics: chars)
        ]
        let result = try decodedAccessory(session().process(.init(id: "r", command: "read_accessory", accessoryId: allowedID), accessories: [accessory(services: services)]))
        XCTAssertEqual(result.services.map(\.id), ["sensor"])
        XCTAssertEqual(result.services.first?.characteristics.map(\.id), ["safe"])
        XCTAssertEqual(result.services.first?.characteristics.first?.value, .number(22))
    }
    func testStringAndStructuredValuesAreSuppressed() {
        XCTAssertNil(SafeReadPolicy.scalar(.string("private")))
        XCTAssertNil(SafeReadPolicy.scalar(.object(["key": .string("private")])))
        XCTAssertNil(SafeReadPolicy.scalar(.array([.number(1)])))
        XCTAssertNil(SafeReadPolicy.scalar(.number(.infinity)))
        XCTAssertEqual(SafeReadPolicy.scalar(.bool(true)), .bool(true))
    }
    func testRequestParsingAndCorrelation() throws {
        let request = try BridgeRequest.decode(Data("{\"id\":\"client-42\",\"command\":\"status\"}".utf8))
        XCTAssertEqual(ReadOnlySession().process(request).id, "client-42")
        for input in ["{}", "{\"id\":2,\"command\":\"status\"}", "{\"id\":\"\",\"command\":\"status\"}", "{\"id\":\"a\",\"command\":\"status\",\"write\":true}"] {
            XCTAssertThrowsError(try BridgeRequest.decode(Data(input.utf8)))
        }
    }
    func testLineFramingHandlesChunksAndRejectsOversize() throws {
        var framer = LineFramer(maximumBytes: 8)
        XCTAssertEqual(try framer.append(Data("abc".utf8)), [])
        XCTAssertTrue(framer.hasPartialFrame)
        XCTAssertEqual(try framer.append(Data("d\nxy\n".utf8)), [Data("abcd".utf8), Data("xy".utf8)])
        XCTAssertFalse(framer.hasPartialFrame)
        XCTAssertThrowsError(try framer.append(Data("123456789".utf8)))
    }
}
