import Foundation
import Darwin

/// Private inherited pipes only; never opens a socket or installs a daemon.
public final class StdioServer: @unchecked Sendable {
    private let outputLock = NSLock()
    public init() {}

    public func start(handler: @escaping @Sendable (BridgeRequest, @escaping @Sendable (BridgeResponse) -> Void) -> Void,
                      onClose: @escaping @Sendable () -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            var framer = LineFramer()
            do {
                var bytes = [UInt8](repeating: 0, count: 4096)
                while true {
                    // Darwin read returns available pipe bytes immediately. Foundation's
                    // read(upToCount:) can wait for the requested count or EOF on this host,
                    // deadlocking an interactive request/response client with stdin open.
                    let count = bytes.withUnsafeMutableBytes {
                        Darwin.read(STDIN_FILENO, $0.baseAddress, $0.count)
                    }
                    if count == 0 { break }
                    if count < 0 {
                        if errno == EINTR { continue }
                        throw BridgeError("transport_closed", "Unable to read the inherited input pipe.")
                    }
                    let chunk = Data(bytes.prefix(count))
                    for line in try framer.append(chunk) {
                        let request: BridgeRequest
                        do { request = try BridgeRequest.decode(line) }
                        catch {
                            self.write(.failure("", BridgeError("invalid_request", "Expected one valid request object per line.")))
                            continue
                        }
                        // One request at a time bounds queue growth and prevents interleaved responses.
                        let completed = DispatchSemaphore(value: 0)
                        handler(request) { response in self.write(response); completed.signal() }
                        guard completed.wait(timeout: .now() + 30) == .success else {
                            self.write(.failure(request.id, BridgeError("bridge_timeout", "Native request timed out.")))
                            onClose(); return
                        }
                    }
                }
                if framer.hasPartialFrame {
                    self.write(.failure("", BridgeError("invalid_request", "Input ended before the final newline.")))
                }
            } catch {
                self.write(.failure("", BridgeError("transport_closed", "Input could not be read or exceeded the frame limit.")))
            }
            onClose()
        }
    }

    private func write(_ response: BridgeResponse) {
        outputLock.lock(); defer { outputLock.unlock() }
        guard var data = try? JSONEncoder().encode(response) else { return }
        data.append(10)
        try? FileHandle.standardOutput.write(contentsOf: data)
    }
}
