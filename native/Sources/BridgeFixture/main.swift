// Synthetic protocol fixture. This executable cannot import or initialize HomeKit.
import Foundation
import BridgeCore

let arguments = CommandLine.arguments
let index = arguments.firstIndex(of: "--config")
let configURL = index.flatMap { $0 + 1 < arguments.count ? URL(fileURLWithPath: arguments[$0 + 1]) : nil }
var fixtureSession = ReadOnlySession(configuration: configURL.flatMap { try? BridgeConfiguration.load(from: $0) } ?? .denyAll)
fixtureSession.enabled = true
fixtureSession.authorization = .authorized
fixtureSession.homesReady = true
fixtureSession.platform = "synthetic-fixture"
let frozenSession = fixtureSession
let observed = "2026-10-18T00:00:00Z"
let fixtures = [AccessorySnapshot(
    id: "11111111-1111-4111-8111-111111111111", name: "Synthetic temperature sensor", room: "Synthetic room",
    roomId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", category: "10", reachable: true, observedAt: observed,
    services: [.init(id: "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB", type: "0000008A-0000-1000-8000-0026BB765291", name: "Temperature",
        characteristics: [.init(id: "CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC", type: "00000011-0000-1000-8000-0026BB765291", value: .number(21.5), readable: true, observedAt: observed)])]
)]
let closed = DispatchSemaphore(value: 0)
let transport = StdioServer()
transport.start(handler: { request, reply in
    reply(frozenSession.process(request, accessories: fixtures, now: observed))
}, onClose: { closed.signal() })
closed.wait()
