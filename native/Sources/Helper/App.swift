import UIKit
import Foundation
import UniformTypeIdentifiers

@main final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    var transport: StdioServer?
    var controller: HomeKitController?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let args = CommandLine.arguments
        let configIndex = args.firstIndex(of: "--config")
        let config = configIndex.flatMap { $0 + 1 < args.count ? URL(fileURLWithPath: args[$0 + 1]) : nil }
        let controller = HomeKitController(configURL: config)
        self.controller = controller
        let view = SetupViewController(controller: controller)
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = view
        window.makeKeyAndVisible()
        self.window = window
        if args.contains("--stdio") {
            let transport = StdioServer()
            self.transport = transport
            transport.start(handler: { request, reply in
                DispatchQueue.main.async { controller.handle(request, reply: reply) }
            }, onClose: {
                // No daemon or persistent access survives the MCP client's inherited pipe.
                DispatchQueue.main.async { controller.disableFromUserAction(); exit(0) }
            })
        }
        return true
    }
}

@MainActor final class SetupViewController: UIViewController, UIDocumentPickerDelegate {
    private let controller: HomeKitController
    private let text = UITextView()
    init(controller: HomeKitController) { self.controller = controller; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        let enable = UIButton(type: .system)
        enable.setTitle("Enable HomeKit access for this session…", for: .normal)
        enable.addTarget(self, action: #selector(confirmEnable), for: .touchUpInside)
        let disable = UIButton(type: .system)
        disable.setTitle("Disable this session", for: .normal)
        disable.addTarget(self, action: #selector(disableSession), for: .touchUpInside)
        let reload = UIButton(type: .system)
        reload.setTitle("Reload explicit accessory allowlist", for: .normal)
        reload.addTarget(self, action: #selector(reloadConfig), for: .touchUpInside)
        let choose = UIButton(type: .system)
        choose.setTitle("Choose allowlist JSON file…", for: .normal)
        choose.addTarget(self, action: #selector(chooseConfig), for: .touchUpInside)
        text.isEditable = false
        text.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        let stack = UIStackView(arrangedSubviews: [enable, disable, choose, reload, text])
        stack.axis = .vertical; stack.spacing = 12; stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -24)
        ])
        controller.changed = { [weak self] in self?.render() }
        render()
    }
    private func render() {
        text.text = """
        HomeKit MCP — local read-only bridge

        Access is disabled at every launch until you enable this session. Apple may ask for HomeKit permission. Only you can approve that system prompt. No permission is requested by MCP tools.

        Only UUIDs in your configuration can cross the private local stdio pipe. Cameras and video doorbells are excluded. No writes, scenes, automations, recordings, subscriptions, lock or garage commands are implemented.

        Authorization: \(controller.session.authorization.rawValue)
        Session enabled: \(controller.session.enabled)
        Allowlisted accessories: \(controller.session.configuration.allowedAccessoryIds.count)
        Configuration: \(controller.configURL?.path ?? "none")
        \(controller.configurationError ?? "Configuration valid.")

        After granting access, copy selected accessory UUIDs into allowedAccessoryIds in your config, then click Reload. Also restart the local MCP profile so its server reloads the same config, then choose the config and enable the new app session again. Leave the list empty to deny every accessory. This local list is never sent through stdio:

        \(controller.localInventoryDescription())
        """
    }
    @objc private func confirmEnable() {
        let alert = UIAlertController(title: "Request access to Apple Home?", message: "This initializes HomeKit and may show Apple's permission dialog. Apple remembers your answer. The bridge reads only your explicit allowlist; camera data is excluded. Continue only when you are ready to grant access.", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        alert.addAction(UIAlertAction(title: "Request HomeKit access", style: .default) { [weak self] _ in self?.controller.enableFromUserAction() })
        present(alert, animated: true)
    }
    @objc private func disableSession() { controller.disableFromUserAction() }
    @objc private func reloadConfig() { controller.reloadConfiguration() }
    @objc private func chooseConfig() {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.json], asCopy: false)
        picker.delegate = self
        present(picker, animated: true)
    }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let url = urls.first else { return }
        self.controller.selectConfigurationFromUserAction(url)
    }
}
