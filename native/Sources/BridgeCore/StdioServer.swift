import Foundation
import Darwin

/// Settles at most once. The first `complete` wins; a later `complete` (a duplicate callback, or one that
/// arrives after `wait` gave up) is rejected and its value is dropped. `wait` seals the cell when it times
/// out, so a callback racing the deadline resolves to exactly one outcome.
final class OneShot<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private let arrived = DispatchSemaphore(value: 0)
    private var value: Value?
    private var sealed = false

    /// Returns `true` only for the call that settled the cell.
    @discardableResult
    func complete(_ newValue: Value) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard !sealed else { return false }
        sealed = true
        value = newValue
        arrived.signal()
        return true
    }

    /// Returns the settled value, or `nil` if nothing arrived in time (the cell is then sealed against late values).
    func wait(timeout: TimeInterval) -> Value? {
        if arrived.wait(timeout: .now() + timeout) == .timedOut {
            lock.lock(); defer { lock.unlock() }
            if !sealed { sealed = true; return nil }
            // A completion won the race against the deadline; its value is already stored.
        }
        lock.lock(); defer { lock.unlock() }
        return value
    }
}

/// Private inherited pipes only; never opens a socket or installs a daemon.
///
/// Every request ends in exactly one of: one response, one timeout error then close, or close. Handler
/// callbacks only settle the request's `OneShot`; the single transport loop is the only writer, so
/// duplicate or late callbacks can never produce output. Any encoding or write failure closes the
/// transport: nothing is dispatched afterwards and no further write is attempted.
///
/// Response ceiling: one frame (the encoded response plus its newline) is at most `maximumResponseBytes`,
/// the same 1 MiB the TypeScript client enforces on its input buffer. The check runs on the encoded bytes
/// immediately before the write, so it bounds what is emitted; it does not bound the transient memory
/// used to encode (that is bounded indirectly by the at-most-256 allowlisted accessories and the safe
/// scalar filters). An oversize response is replaced by a small `response_too_large` error for the same
/// request id and the session continues; if even that replacement cannot be encoded within the ceiling
/// or written, the transport fails closed.
public final class StdioServer: Sendable {
    /// Largest frame that may be written, newline included. Matches the TypeScript client's 1 MiB limit.
    static let maximumResponseBytes = 1_048_576

    private let input: @Sendable () throws -> Data?
    private let output: @Sendable (Data) throws -> Void
    private let encode: @Sendable (BridgeResponse) throws -> Data
    private let requestTimeout: TimeInterval
    private let responseLimit: Int

    public convenience init() {
        self.init(input: { try StdioServer.readStandardInput() }, output: { try StdioServer.writeStandardOutput($0) },
                  encode: { try JSONEncoder().encode($0) }, requestTimeout: 30)
    }

    /// Injection point for deterministic tests: scripted input, recorded or failing output, a failing encoder, short
    /// timeouts and a smaller response ceiling.
    init(input: @escaping @Sendable () throws -> Data?, output: @escaping @Sendable (Data) throws -> Void,
         encode: @escaping @Sendable (BridgeResponse) throws -> Data, requestTimeout: TimeInterval,
         maximumResponseBytes: Int = StdioServer.maximumResponseBytes) {
        self.input = input; self.output = output; self.encode = encode; self.requestTimeout = requestTimeout
        self.responseLimit = maximumResponseBytes
    }

    public func start(handler: @escaping @Sendable (BridgeRequest, @escaping @Sendable (BridgeResponse) -> Void) -> Void,
                      onClose: @escaping @Sendable () -> Void) {
        // A vanished reader must surface as a write error (fail closed, orderly onClose), not kill the process.
        signal(SIGPIPE, SIG_IGN)
        DispatchQueue.global(qos: .userInitiated).async { self.run(handler: handler, onClose: onClose) }
    }

    /// Blocking loop; `onClose` runs exactly once, on the single exit path below.
    func run(handler: @Sendable (BridgeRequest, @escaping @Sendable (BridgeResponse) -> Void) -> Void,
             onClose: @Sendable () -> Void) {
        var failed = false
        func send(_ response: BridgeResponse) {
            guard !failed else { return }
            do {
                var data = try encode(response)
                if data.count + 1 > responseLimit {
                    // Never emit an oversize frame. The replacement is tiny and keeps the request correlation.
                    data = try encode(.failure(response.id, BridgeError("response_too_large", "Native response exceeds the response size limit.")))
                    guard data.count + 1 <= responseLimit else { throw BridgeError("response_too_large", "Replacement exceeds the limit.") }
                }
                data.append(10)
                try output(data)
            } catch { failed = true }
        }

        var framer = LineFramer()
        reading: while !failed {
            let chunk: Data?
            do { chunk = try input() }
            catch { send(.failure("", BridgeError("transport_closed", "Input could not be read or exceeded the frame limit."))); break }
            guard let chunk else {
                if framer.hasPartialFrame {
                    send(.failure("", BridgeError("invalid_request", "Input ended before the final newline.")))
                }
                break
            }
            let lines: [Data]
            do { lines = try framer.append(chunk) }
            catch { send(.failure("", BridgeError("transport_closed", "Input could not be read or exceeded the frame limit."))); break }
            for line in lines {
                guard !failed else { break reading }
                let request: BridgeRequest
                do { request = try BridgeRequest.decode(line) }
                catch {
                    send(.failure("", BridgeError("invalid_request", "Expected one valid request object per line.")))
                    continue
                }
                // One request at a time bounds queue growth and prevents interleaved responses.
                let settlement = OneShot<BridgeResponse>()
                handler(request) { _ = settlement.complete($0) }
                guard let response = settlement.wait(timeout: requestTimeout) else {
                    send(.failure(request.id, BridgeError("bridge_timeout", "Native request timed out.")))
                    break reading
                }
                send(response)
            }
        }
        onClose()
    }

    /// Darwin read returns available pipe bytes immediately. Foundation's read(upToCount:) can wait for
    /// the requested count or EOF on this host, deadlocking an interactive client with stdin open.
    static func readStandardInput() throws -> Data? {
        var bytes = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = bytes.withUnsafeMutableBytes { Darwin.read(STDIN_FILENO, $0.baseAddress, $0.count) }
            if count > 0 { return Data(bytes.prefix(count)) }
            if count == 0 { return nil }
            if errno == EINTR { continue }
            throw BridgeError("transport_closed", "Unable to read the inherited input pipe.")
        }
    }

    static func writeStandardOutput(_ data: Data) throws {
        try writeAll(data) { Darwin.write(STDOUT_FILENO, $0, $1) }
    }

    /// Writes every byte or throws. Short writes advance and continue; an interrupted write (`EINTR`) is
    /// retried; a zero-byte result (no progress) or any other error is a failure, never a spin. `write`
    /// follows `write(2)`: bytes written, or -1 with `errno` set.
    static func writeAll(_ data: Data, using write: (UnsafeRawPointer, Int) -> Int) throws {
        try data.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let written = write(raw.baseAddress! + offset, raw.count - offset)
                if written > 0 { offset += written; continue }
                if written < 0 && errno == EINTR { continue }
                throw BridgeError("transport_closed", "Unable to write the inherited output pipe.")
            }
        }
    }
}
