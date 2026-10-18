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
}
