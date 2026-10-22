import XCTest
import Foundation
import Darwin
@testable import BridgeCore

/// This fixture links Foundation and BridgeCore only. Never launches the HomeKit app.
final class StdioTransportTests: XCTestCase {
    func testRepliesBeforeStdinCloses() throws {
        let products = Bundle(for: StdioTransportTests.self).bundleURL.deletingLastPathComponent()
        let fixture = products.appendingPathComponent("BridgeFixture")
        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: fixture.path), "Build the Foundation-only fixture alongside the tests.")
        let process = Process()
        let input = Pipe()
        let output = Pipe()
        let errors = Pipe()
        process.executableURL = fixture
        process.standardInput = input
        process.standardOutput = output
        process.standardError = errors
        try process.run()
        defer {
            try? input.fileHandleForWriting.close()
            if process.isRunning { process.terminate() }
            process.waitUntilExit()
        }

        // Keep stdin open across two request/response cycles. An EOF-only smoke hides buffering bugs.
        for requestID in ["open-pipe-1", "open-pipe-2"] {
            try input.fileHandleForWriting.write(contentsOf: Data("{\"id\":\"\(requestID)\",\"command\":\"status\"}\n".utf8))
            var descriptor = pollfd(fd: output.fileHandleForReading.fileDescriptor, events: Int16(POLLIN), revents: 0)
            let ready = Darwin.poll(&descriptor, 1, 2_000)
            guard ready > 0, descriptor.revents & Int16(POLLIN) != 0 else {
                XCTFail("The bridge must reply within two seconds while stdin remains open.")
                return
            }
            var bytes = [UInt8](repeating: 0, count: 4096)
            let count = bytes.withUnsafeMutableBytes { Darwin.read(descriptor.fd, $0.baseAddress, $0.count) }
            XCTAssertGreaterThan(count, 0)
            guard count > 0 else { return }
            let response = try JSONDecoder().decode(BridgeResponse.self, from: Data(bytes.prefix(count)))
            XCTAssertEqual(response.id, requestID)
            XCTAssertTrue(response.ok)
            XCTAssertTrue(process.isRunning, "The bridge must remain available for the next request.")
        }
        try input.fileHandleForWriting.close()
        process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 0)
        XCTAssertTrue(errors.fileHandleForReading.readDataToEndOfFile().isEmpty)
    }

    // MARK: - Framing and error replies through the Foundation-only fixture (no HomeKit, no app launch)

    private func fixtureURL() throws -> URL {
        let products = Bundle(for: StdioTransportTests.self).bundleURL.deletingLastPathComponent()
        let fixture = products.appendingPathComponent("BridgeFixture")
        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: fixture.path), "Build the Foundation-only fixture alongside the tests.")
        return fixture
    }

    /// Writes `input`, closes stdin and returns every response line plus the exit status.
    private func runFixture(_ input: Data) throws -> (responses: [BridgeResponse], status: Int32, stderr: Data) {
        signal(SIGPIPE, SIG_IGN)
        let process = Process()
        let stdin = Pipe(), stdout = Pipe(), stderr = Pipe()
        process.executableURL = try fixtureURL()
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = stderr
        try process.run()
        try stdin.fileHandleForWriting.write(contentsOf: input)
        try stdin.fileHandleForWriting.close()
        let output = stdout.fileHandleForReading.readDataToEndOfFile()
        let errors = stderr.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let responses = try output.split(separator: 10).map { try JSONDecoder().decode(BridgeResponse.self, from: Data($0)) }
        return (responses, process.terminationStatus, errors)
    }

    func testMalformedLinesGetAnonymousErrorsAndTheStreamKeepsWorking() throws {
        let input = Data("not json\n{\"id\":\"\",\"command\":\"status\"}\n{\"id\":\"x\",\"command\":\"status\",\"write\":true}\n{\"id\":\"ok-1\",\"command\":\"status\"}\n".utf8)
        let run = try runFixture(input)
        XCTAssertEqual(run.responses.count, 4)
        for rejected in run.responses.prefix(3) {
            XCTAssertFalse(rejected.ok)
            XCTAssertEqual(rejected.id, "", "an unparseable request cannot be correlated, so no id is echoed")
            XCTAssertEqual(rejected.error?.code, "invalid_request")
        }
        XCTAssertTrue(run.responses[3].ok)
        XCTAssertEqual(run.responses[3].id, "ok-1")
        XCTAssertEqual(run.status, 0)
        XCTAssertTrue(run.stderr.isEmpty, "the bridge never writes diagnostics to stderr")
    }

    func testUnsupportedAndDeniedCommandsKeepTheirRequestIdAndRevealNothing() throws {
        let input = Data("{\"id\":\"w\",\"command\":\"set_characteristic\"}\n{\"id\":\"r\",\"command\":\"read_accessory\",\"accessoryId\":\"11111111-1111-4111-8111-111111111111\"}\n".utf8)
        let run = try runFixture(input)
        XCTAssertEqual(run.responses.map(\.id), ["w", "r"])
        XCTAssertEqual(run.responses[0].error?.code, "unsupported_command")
        // Without a configuration file the fixture is deny-all, so even a known id is refused.
        XCTAssertEqual(run.responses[1].error?.code, "accessory_not_allowed")
        XCTAssertNil(run.responses[1].result)
    }

    func testInputEndingMidFrameReportsATruncatedRequest() throws {
        let run = try runFixture(Data("{\"id\":\"a\",\"command\":\"status\"}\n{\"id\":\"b\",\"comm".utf8))
        XCTAssertEqual(run.responses.count, 2)
        XCTAssertTrue(run.responses[0].ok)
        XCTAssertEqual(run.responses[1].error?.code, "invalid_request")
        XCTAssertEqual(run.responses[1].id, "")
        XCTAssertEqual(run.status, 0)
    }

    func testOversizeFrameClosesTheTransportWithoutProcessingIt() throws {
        let run = try runFixture(Data(repeating: 97, count: 65_537))
        XCTAssertEqual(run.responses.count, 1)
        XCTAssertEqual(run.responses[0].error?.code, "transport_closed")
        XCTAssertEqual(run.status, 0)
        // A frame exactly at the limit is accepted as a frame and rejected only as an invalid request.
        let atLimit = try runFixture(Data(repeating: 97, count: 65_536) + Data([10]))
        XCTAssertEqual(atLimit.responses.first?.error?.code, "invalid_request")
    }

    /// stdin stays open, so the only way the bridge can exit on its own is by failing closed on the broken output pipe.
    func testBrokenOutputPipeClosesTheBridgeInsteadOfWaitingForMoreInput() throws {
        signal(SIGPIPE, SIG_IGN)
        let process = Process()
        let stdin = Pipe(), stdout = Pipe(), stderr = Pipe()
        process.executableURL = try fixtureURL()
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = stderr
        try process.run()
        defer {
            try? stdin.fileHandleForWriting.close()
            if process.isRunning { process.terminate() }
            process.waitUntilExit()
        }
        try stdout.fileHandleForReading.close() // the reader of the bridge's responses is gone
        try stdin.fileHandleForWriting.write(contentsOf: Data("{\"id\":\"unreadable\",\"command\":\"status\"}\n".utf8))
        let deadline = Date().addingTimeInterval(5)
        while process.isRunning && Date() < deadline { usleep(20_000) }
        XCTAssertFalse(process.isRunning, "a failed response write must close the bridge even though stdin is still open")
        XCTAssertEqual(process.terminationStatus, 0)
        XCTAssertTrue(stderr.fileHandleForReading.readDataToEndOfFile().isEmpty)
    }
}
