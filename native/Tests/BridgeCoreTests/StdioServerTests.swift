import XCTest
import Foundation
@testable import BridgeCore

// In-process transport tests with injected input, output, encoder and timeouts. Synthetic data only:
// no HomeKit import, no app launch, no device. Timeouts only run where the handler deliberately never replies.

private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    @discardableResult func increment() -> Int { lock.lock(); defer { lock.unlock() }; count += 1; return count }
    var value: Int { lock.lock(); defer { lock.unlock() }; return count }
}

private final class Box<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value?
    var value: Value? {
        get { lock.lock(); defer { lock.unlock() }; return stored }
        set { lock.lock(); defer { lock.unlock() }; stored = newValue }
    }
}

private final class ScriptedInput: @unchecked Sendable {
    enum Item { case data(Data), failure }
    private let lock = NSLock()
    private var items: [Item]
    init(_ items: [Item]) { self.items = items }
    convenience init(_ text: String...) { self.init(text.map { .data(Data($0.utf8)) }) }
    func next() throws -> Data? {
        lock.lock(); defer { lock.unlock() }
        guard !items.isEmpty else { return nil }
        switch items.removeFirst() {
        case .data(let data): return data
        case .failure: throw BridgeError("transport_closed", "scripted-input-detail")
        }
    }
}

private final class RecordedOutput: @unchecked Sendable {
    private let lock = NSLock()
    private var written: [Data] = []
    private var attemptCount = 0
    private let failAt: Int?
    init(failAtAttempt: Int? = nil) { failAt = failAtAttempt }
    func write(_ data: Data) throws {
        lock.lock(); defer { lock.unlock() }
        attemptCount += 1
        if attemptCount == failAt { throw BridgeError("transport_closed", "scripted-output-failure") }
        written.append(data)
    }
    var writes: [Data] { lock.lock(); defer { lock.unlock() }; return written }
    var attempts: Int { lock.lock(); defer { lock.unlock() }; return attemptCount }
    var responses: [BridgeResponse] {
        writes.map { try! JSONDecoder().decode(BridgeResponse.self, from: $0.dropLast()) }
    }
}

private typealias Reply = @Sendable (BridgeResponse) -> Void
private typealias Handler = @Sendable (BridgeRequest, @escaping Reply) -> Void

private func request(_ id: String) -> String { "{\"id\":\"\(id)\",\"command\":\"status\"}\n" }
private func ok(_ id: String, _ text: String = "ok") -> BridgeResponse { .success(id, .string(text)) }
private let defaultEncoder: @Sendable (BridgeResponse) throws -> Data = { try JSONEncoder().encode($0) }

/// Runs the loop on the calling thread and returns how many times `onClose` ran.
@discardableResult
private func runServer(input: ScriptedInput, output: RecordedOutput, timeout: TimeInterval = 5,
                       encode: @escaping @Sendable (BridgeResponse) throws -> Data = defaultEncoder,
                       maximumResponseBytes: Int = StdioServer.maximumResponseBytes,
                       handler: @escaping Handler) -> Int {
    let closes = Counter()
    let server = StdioServer(input: { try input.next() }, output: { try output.write($0) }, encode: encode, requestTimeout: timeout,
                             maximumResponseBytes: maximumResponseBytes)
    server.run(handler: handler, onClose: { closes.increment() })
    return closes.value
}

final class OneShotTests: XCTestCase {
    func testFirstCompletionWinsAndLaterOnesAreRejected() {
        let cell = OneShot<Int>()
        XCTAssertTrue(cell.complete(1))
        XCTAssertFalse(cell.complete(2))
        XCTAssertEqual(cell.wait(timeout: 1), 1)
        XCTAssertEqual(cell.wait(timeout: 0), 1, "an already settled cell never reports a timeout")
    }

    func testTimeoutSealsTheCellAgainstLateCompletion() {
        let cell = OneShot<Int>()
        XCTAssertNil(cell.wait(timeout: 0.01))
        XCTAssertFalse(cell.complete(7), "a value that arrives after the deadline is dropped")
        XCTAssertNil(cell.wait(timeout: 0))
    }

    func testConcurrentCompletionsSettleExactlyOnce() {
        for _ in 0..<50 {
            let cell = OneShot<Int>()
            let winners = Counter()
            DispatchQueue.concurrentPerform(iterations: 8) { index in
                if cell.complete(index) { winners.increment() }
            }
            XCTAssertEqual(winners.value, 1)
            XCTAssertNotNil(cell.wait(timeout: 0))
        }
    }
}

final class StdioServerTests: XCTestCase {
    // MARK: Normal flow

    func testEachRequestGetsExactlyOneNewlineTerminatedResponseInOrder() {
        let output = RecordedOutput()
        let closes = runServer(input: ScriptedInput(request("a") + request("b") + request("c")), output: output) { req, reply in reply(ok(req.id)) }
        XCTAssertEqual(output.responses.map(\.id), ["a", "b", "c"])
        for line in output.writes {
            XCTAssertEqual(line.last, 10)
            XCTAssertEqual(line.filter { $0 == 10 }.count, 1, "each response is a single complete NDJSON line")
        }
        XCTAssertEqual(closes, 1)
    }

    func testRequestSplitAcrossChunksIsReassembled() {
        let output = RecordedOutput()
        runServer(input: ScriptedInput("{\"id\":\"split\",\"comm", "and\":\"status\"}\n"), output: output) { req, reply in reply(ok(req.id)) }
        XCTAssertEqual(output.responses.map(\.id), ["split"])
    }

    func testEndOfInputWithNothingPendingClosesQuietlyOnce() {
        let output = RecordedOutput()
        let handled = Counter()
        let closes = runServer(input: ScriptedInput(), output: output) { _, _ in handled.increment() }
        XCTAssertEqual(output.attempts, 0)
        XCTAssertEqual(handled.value, 0)
        XCTAssertEqual(closes, 1)
    }

    func testTruncatedFinalFrameIsReportedAnonymously() {
        let output = RecordedOutput()
        runServer(input: ScriptedInput(request("a") + "{\"id\":\"b\""), output: output) { req, reply in reply(ok(req.id)) }
        XCTAssertEqual(output.responses.map(\.id), ["a", ""])
        XCTAssertEqual(output.responses[1].error?.code, "invalid_request")
    }

    func testOversizeFrameClosesWithoutDispatch() {
        let output = RecordedOutput()
        let handled = Counter()
        let closes = runServer(input: ScriptedInput([.data(Data(repeating: 97, count: 65_537))]), output: output) { _, _ in handled.increment() }
        XCTAssertEqual(output.responses.map(\.error?.code), ["transport_closed"])
        XCTAssertEqual(handled.value, 0)
        XCTAssertEqual(closes, 1)
    }

    // MARK: Exactly-once settlement

    func testDuplicateSynchronousCallbackIsIgnored() {
        let output = RecordedOutput()
        let handled = Counter()
        runServer(input: ScriptedInput(request("a") + request("b")), output: output) { req, reply in
            handled.increment()
            reply(ok(req.id, "first"))
            reply(.failure(req.id, BridgeError("duplicate", "must never be written")))
        }
        XCTAssertEqual(handled.value, 2)
        XCTAssertEqual(output.responses.map(\.id), ["a", "b"])
        XCTAssertEqual(output.responses.map(\.result), [.string("first"), .string("first")])
        XCTAssertTrue(output.responses.allSatisfy { $0.error == nil })
    }

    func testDuplicateAsynchronousCallbacksProduceOneResponsePerRequest() {
        let output = RecordedOutput()
        let group = DispatchGroup()
        runServer(input: ScriptedInput(request("a") + request("b") + request("c")), output: output) { req, reply in
            group.enter()
            DispatchQueue.global().async {
                reply(ok(req.id, "first"))
                reply(ok(req.id, "second"))
                reply(.failure(req.id, BridgeError("duplicate", "must never be written")))
                group.leave()
            }
        }
        XCTAssertEqual(group.wait(timeout: .now() + 5), .success)
        XCTAssertEqual(output.responses.map(\.id), ["a", "b", "c"], "one response per request, never interleaved or repeated")
        XCTAssertTrue(output.responses.allSatisfy { $0.ok && $0.result == .string("first") })
    }

    func testLateCallbackAfterTimeoutNeverWrites() {
        let output = RecordedOutput()
        let handled = Counter()
        let captured = Box<Reply>()
        let closes = runServer(input: ScriptedInput(request("slow") + request("never-dispatched")), output: output, timeout: 0.05) { _, reply in
            handled.increment()
            captured.value = reply
        }
        XCTAssertEqual(output.responses.map(\.id), ["slow"])
        XCTAssertEqual(output.responses[0].error?.code, "bridge_timeout")
        XCTAssertEqual(handled.value, 1, "the transport closes at the timeout and never dispatches later input")
        XCTAssertEqual(closes, 1)

        captured.value?(ok("slow", "too late"))
        captured.value?(ok("slow", "also too late"))
        XCTAssertEqual(output.attempts, 1, "late callbacks after close are discarded")
    }

    func testTimeoutAppliesPerRequest() {
        let output = RecordedOutput()
        runServer(input: ScriptedInput(request("fast") + request("stuck")), output: output, timeout: 0.05) { req, reply in
            if req.id == "fast" { reply(ok(req.id)) }
        }
        XCTAssertEqual(output.responses.map(\.id), ["fast", "stuck"])
        XCTAssertEqual(output.responses.map(\.ok), [true, false])
        XCTAssertEqual(output.responses[1].error?.code, "bridge_timeout")
    }

    func testCallbackRacingTheDeadlineResolvesToExactlyOneOutcome() {
        for iteration in 0..<100 {
            let output = RecordedOutput()
            let captured = Box<Reply>()
            let closes = runServer(input: ScriptedInput(request("race")), output: output, timeout: 0.001) { req, reply in
                captured.value = reply
                DispatchQueue.global().async { reply(ok(req.id)) }
            }
            XCTAssertEqual(output.attempts, 1, "iteration \(iteration): exactly one outcome, whichever side won")
            let response = output.responses[0]
            XCTAssertEqual(response.id, "race")
            XCTAssertTrue(response.ok || response.error?.code == "bridge_timeout")
            XCTAssertEqual(closes, 1)
            captured.value?(ok("race", "after close"))
            XCTAssertEqual(output.attempts, 1)
        }
    }

    // MARK: Fail-closed encoding and output

    func testEncodingFailureClosesWithoutFurtherDispatchOrWrites() {
        let output = RecordedOutput()
        let handled = Counter()
        let closes = runServer(input: ScriptedInput(request("a") + request("bad") + request("c")), output: output,
                               encode: { response in
            if response.id == "bad" { throw BridgeError("encoding_failed", "scripted") }
            return try JSONEncoder().encode(response)
        }) { req, reply in handled.increment(); reply(ok(req.id)) }
        XCTAssertEqual(output.responses.map(\.id), ["a"])
        XCTAssertEqual(output.attempts, 1, "no error reply is attempted once the response channel cannot be trusted")
        XCTAssertEqual(handled.value, 2, "the request after the failure is never dispatched")
        XCTAssertEqual(closes, 1)
    }

    func testNonFiniteResultThatCannotBeEncodedFailsClosed() {
        let output = RecordedOutput()
        let handled = Counter()
        let closes = runServer(input: ScriptedInput(request("inf") + request("after")), output: output) { req, reply in
            handled.increment()
            reply(.success(req.id, .number(.infinity)))
        }
        XCTAssertEqual(output.attempts, 0)
        XCTAssertEqual(handled.value, 1)
        XCTAssertEqual(closes, 1)
    }

    func testOutputFailureOnFirstResponseStopsEverything() {
        let output = RecordedOutput(failAtAttempt: 1)
        let handled = Counter()
        let closes = runServer(input: ScriptedInput(request("a") + request("b")), output: output) { req, reply in handled.increment(); reply(ok(req.id)) }
        XCTAssertEqual(handled.value, 1)
        XCTAssertEqual(output.attempts, 1, "no retry and no second write after the output failed")
        XCTAssertTrue(output.writes.isEmpty)
        XCTAssertEqual(closes, 1)
    }

    func testOutputFailureMidStreamStopsDispatch() {
        let output = RecordedOutput(failAtAttempt: 2)
        let handled = Counter()
        let closes = runServer(input: ScriptedInput(request("a") + request("b") + request("c")), output: output) { req, reply in handled.increment(); reply(ok(req.id)) }
        XCTAssertEqual(output.responses.map(\.id), ["a"])
        XCTAssertEqual(output.attempts, 2)
        XCTAssertEqual(handled.value, 2)
        XCTAssertEqual(closes, 1)
    }

    func testOutputFailureAcrossChunksStopsReading() {
        let output = RecordedOutput(failAtAttempt: 1)
        let handled = Counter()
        let closes = runServer(input: ScriptedInput(request("a"), request("b"), request("c")), output: output) { req, reply in handled.increment(); reply(ok(req.id)) }
        XCTAssertEqual(handled.value, 1)
        XCTAssertEqual(output.attempts, 1)
        XCTAssertEqual(closes, 1)
    }

    func testRejectionWriteFailureStopsBeforeTheNextRequestInTheSameChunk() {
        let output = RecordedOutput(failAtAttempt: 1)
        let handled = Counter()
        let closes = runServer(input: ScriptedInput("not json\n" + request("valid")), output: output) { req, reply in handled.increment(); reply(ok(req.id)) }
        XCTAssertEqual(handled.value, 0, "no dispatch after a failed output")
        XCTAssertEqual(output.attempts, 1)
        XCTAssertEqual(closes, 1)
    }

    func testTimeoutResponseWriteFailureStillClosesOnce() {
        let output = RecordedOutput(failAtAttempt: 1)
        let closes = runServer(input: ScriptedInput(request("stuck")), output: output, timeout: 0.05) { _, _ in }
        XCTAssertEqual(output.attempts, 1)
        XCTAssertEqual(closes, 1)
    }

    func testTruncatedFrameReplyWriteFailureStillClosesOnce() {
        let output = RecordedOutput(failAtAttempt: 1)
        let closes = runServer(input: ScriptedInput("{\"id\":\"b\""), output: output) { _, _ in }
        XCTAssertEqual(output.attempts, 1)
        XCTAssertEqual(closes, 1)
    }

    // MARK: Input failure

    func testInputFailureSendsOneGenericErrorWithoutLeakingDetailAndClosesOnce() {
        let output = RecordedOutput()
        let closes = runServer(input: ScriptedInput([.data(Data(request("a").utf8)), .failure]), output: output) { req, reply in reply(ok(req.id)) }
        XCTAssertEqual(output.responses.map(\.id), ["a", ""])
        XCTAssertEqual(output.responses[1].error?.code, "transport_closed")
        XCTAssertFalse(output.responses[1].error?.message.contains("scripted") ?? true)
        XCTAssertEqual(closes, 1)
    }

    func testInputFailureWithBrokenOutputMakesOneAttemptAndClosesOnce() {
        let output = RecordedOutput(failAtAttempt: 1)
        let closes = runServer(input: ScriptedInput([.failure]), output: output) { _, _ in }
        XCTAssertEqual(output.attempts, 1)
        XCTAssertEqual(closes, 1)
    }

    // MARK: Entry point

    func testStartRunsTheLoopOffThreadAndClosesExactlyOnce() {
        let output = RecordedOutput()
        let input = ScriptedInput(request("started"))
        let closed = expectation(description: "onClose")
        closed.assertForOverFulfill = true
        let server = StdioServer(input: { try input.next() }, output: { try output.write($0) }, encode: defaultEncoder, requestTimeout: 5)
        server.start(handler: { req, reply in reply(ok(req.id)) }, onClose: { closed.fulfill() })
        wait(for: [closed], timeout: 5)
        XCTAssertEqual(output.responses.map(\.id), ["started"])
    }
}

/// The response ceiling is enforced on the encoded bytes before anything is written. Synthetic payloads only.
final class StdioResponseLimitTests: XCTestCase {
    /// Frame size of a response (encoded bytes plus the newline), measured with the production encoder.
    private func frameSize(_ response: BridgeResponse) throws -> Int { try JSONEncoder().encode(response).count + 1 }

    private func padded(_ id: String, toFrameBytes target: Int) throws -> BridgeResponse {
        let base = try frameSize(.success(id, .string("")))
        XCTAssertGreaterThanOrEqual(target, base)
        return .success(id, .string(String(repeating: "a", count: target - base)))
    }

    func testTheCeilingMatchesTheTypeScriptClientLimit() {
        XCTAssertEqual(StdioServer.maximumResponseBytes, 1_048_576)
    }

    func testFrameExactlyAtTheCeilingIsWrittenAndOneByteMoreIsReplaced() throws {
        let exact = try padded("exact", toFrameBytes: StdioServer.maximumResponseBytes)
        let over = try padded("over", toFrameBytes: StdioServer.maximumResponseBytes + 1)
        XCTAssertEqual(try frameSize(exact), StdioServer.maximumResponseBytes)
        XCTAssertEqual(try frameSize(over), StdioServer.maximumResponseBytes + 1)

        let output = RecordedOutput()
        let closes = runServer(input: ScriptedInput(request("exact") + request("over") + request("after")), output: output) { req, reply in
            switch req.id {
            case "exact": reply(exact)
            case "over": reply(over)
            default: reply(ok(req.id))
            }
        }
        XCTAssertEqual(output.attempts, 3)
        XCTAssertEqual(output.writes[0].count, StdioServer.maximumResponseBytes, "the largest allowed frame is emitted whole, newline included")
        XCTAssertEqual(output.writes[0].last, 10)
        XCTAssertLessThanOrEqual(output.writes.map(\.count).max() ?? 0, StdioServer.maximumResponseBytes, "nothing larger is ever written")
        let responses = output.responses
        XCTAssertEqual(responses.map(\.id), ["exact", "over", "after"], "the oversize reply keeps its correlation and the session continues")
        XCTAssertTrue(responses[0].ok)
        XCTAssertEqual(responses[1].error?.code, "response_too_large")
        XCTAssertNil(responses[1].result, "no part of the oversize payload leaks into the replacement")
        XCTAssertTrue(responses[2].ok)
        XCTAssertEqual(closes, 1)
    }

    func testBoundaryWithASmallInjectedCeiling() throws {
        // Larger than the replacement error, so at `size - 1` the replacement itself still fits.
        let response = ok("a", String(repeating: "p", count: 300))
        let size = try frameSize(response)
        let replacement = try frameSize(.failure("a", BridgeError("response_too_large", "Native response exceeds the response size limit.")))
        XCTAssertLessThan(replacement, size - 1)
        for (limit, expectReplaced) in [(size, false), (size - 1, true)] {
            let output = RecordedOutput()
            runServer(input: ScriptedInput(request("a")), output: output, maximumResponseBytes: limit) { _, reply in reply(response) }
            XCTAssertEqual(output.attempts, 1)
            XCTAssertEqual(output.responses[0].error?.code, expectReplaced ? "response_too_large" : nil, "limit \(limit)")
            XCTAssertEqual(output.responses[0].ok, !expectReplaced)
        }
    }

    func testReplacementTextRevealsNeitherSizeNorContent() throws {
        let output = RecordedOutput()
        runServer(input: ScriptedInput(request("a")), output: output, maximumResponseBytes: 200) { _, reply in reply(ok("a", String(repeating: "secret-", count: 100))) }
        let message = output.responses[0].error?.message ?? ""
        XCTAssertEqual(output.responses[0].error?.code, "response_too_large")
        XCTAssertFalse(message.contains("secret"))
        XCTAssertFalse(message.contains(where: \.isNumber), "the generic message carries no byte counts")
    }

    func testFailureAndTimeoutErrorsAreNeverBlockedByTheCeiling() {
        let output = RecordedOutput()
        runServer(input: ScriptedInput("not json\n" + request("stuck")), output: output, timeout: 0.05, maximumResponseBytes: 160) { _, _ in }
        XCTAssertEqual(output.responses.map(\.error?.code), ["invalid_request", "bridge_timeout"])
    }

    func testWhenEvenTheReplacementDoesNotFitTheTransportFailsClosed() {
        let output = RecordedOutput()
        let handled = Counter()
        let closes = runServer(input: ScriptedInput(request("a") + request("b")), output: output, maximumResponseBytes: 10) { req, reply in
            handled.increment(); reply(ok(req.id))
        }
        XCTAssertEqual(output.attempts, 0, "nothing oversize and no unbounded fallback is written")
        XCTAssertEqual(handled.value, 1, "no later request is dispatched")
        XCTAssertEqual(closes, 1)
    }

    func testWhenTheReplacementCannotBeEncodedTheTransportFailsClosed() {
        let output = RecordedOutput()
        let encodes = Counter()
        let handled = Counter()
        let closes = runServer(input: ScriptedInput(request("a") + request("b")), output: output, encode: { response in
            if encodes.increment() == 2 { throw BridgeError("encoding_failed", "scripted") }
            return try JSONEncoder().encode(response)
        }, maximumResponseBytes: 20) { req, reply in handled.increment(); reply(ok(req.id)) }
        XCTAssertEqual(encodes.value, 2)
        XCTAssertEqual(output.attempts, 0)
        XCTAssertEqual(handled.value, 1)
        XCTAssertEqual(closes, 1)
    }

    func testFailedWriteOfTheReplacementStillClosesOnce() {
        let output = RecordedOutput(failAtAttempt: 1)
        let handled = Counter()
        let closes = runServer(input: ScriptedInput(request("a") + request("b")), output: output, maximumResponseBytes: 150) { req, reply in
            handled.increment(); reply(ok(req.id, String(repeating: "x", count: 300)))
        }
        XCTAssertEqual(output.attempts, 1)
        XCTAssertEqual(handled.value, 1)
        XCTAssertEqual(closes, 1)
    }
}

/// `writeAll` is the production write loop; the system call is injected so its exact behavior is observable.
final class StdioWriteAllTests: XCTestCase {
    private final class Script: @unchecked Sendable {
        var calls: [(offset: Int, count: Int)] = []
        var written = Data()
    }

    private func assertTransportClosed(_ body: () throws -> Void, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try body(), file: file, line: line) {
            XCTAssertEqual(($0 as? BridgeError)?.code, "transport_closed", file: file, line: line)
        }
    }

    func testShortWritesAdvanceAndDeliverEveryByteInOrder() throws {
        let data = Data("0123456789".utf8)
        let script = Script()
        var steps = [3, 1, 4, 100].makeIterator()
        try StdioServer.writeAll(data) { pointer, count in
            script.calls.append((script.written.count, count))
            let take = min(steps.next()!, count)
            script.written.append(Data(bytes: pointer, count: take))
            return take
        }
        XCTAssertEqual(script.written, data)
        XCTAssertEqual(script.calls.map(\.count), [10, 7, 6, 2], "each retry offers exactly the unwritten remainder")
        XCTAssertEqual(script.calls.map(\.offset), [0, 3, 4, 8])
    }

    func testInterruptedWriteIsRetriedWithoutLosingBytes() throws {
        let data = Data("abcdef".utf8)
        let script = Script()
        var interruptions = 2
        try StdioServer.writeAll(data) { pointer, count in
            if interruptions > 0 { interruptions -= 1; errno = EINTR; return -1 }
            script.calls.append((script.written.count, count))
            script.written.append(Data(bytes: pointer, count: count))
            return count
        }
        XCTAssertEqual(script.written, data)
        XCTAssertEqual(script.calls.count, 1)
    }

    func testZeroProgressWriteFailsImmediatelyInsteadOfSpinning() {
        var attempts = 0
        assertTransportClosed {
            try StdioServer.writeAll(Data("abc".utf8)) { _, _ in attempts += 1; return 0 }
        }
        XCTAssertEqual(attempts, 1, "a zero-byte result is a failure on the first occurrence, not retried")
    }

    func testZeroProgressAfterPartialProgressFailsAndStops() {
        var attempts = 0
        assertTransportClosed {
            try StdioServer.writeAll(Data("abcdef".utf8)) { _, count in
                attempts += 1
                return attempts == 1 ? 2 : 0
            }
        }
        XCTAssertEqual(attempts, 2)
    }

    func testWriteErrorsAreFailuresAndNotRetried() {
        for code in [EPIPE, EIO, EBADF, EAGAIN] {
            var attempts = 0
            assertTransportClosed {
                try StdioServer.writeAll(Data("abc".utf8)) { _, _ in attempts += 1; errno = code; return -1 }
            }
            XCTAssertEqual(attempts, 1, "errno \(code)")
        }
    }

    func testEmptyDataNeverCallsWrite() throws {
        var attempts = 0
        try StdioServer.writeAll(Data()) { _, _ in attempts += 1; return 0 }
        XCTAssertEqual(attempts, 0)
    }
}
