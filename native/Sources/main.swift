import AppKit
import WebKit
import Darwin
import Carbon
import AVFoundation

// Decode each effect once; all nodes use the same continuously running audio clock.
final class StationAudio {
    // harddrive.mp3 сопровождает весь старт терминала: текстовую диагностику и
    // построчную развёртку DHARMA. Как и остальные эффекты, он декодируется один
    // раз и играет через общий AVAudioEngine без перепадов громкости WebKit.
    let keys = ["alarm", "beep", "discharge", "harddrive", "keypress", "reset", "spinup", "systemfailure", "thud", "tick", "timeout"]
    let engine = AVAudioEngine()
    var nodes: [String: AVAudioPlayerNode] = [:]
    var buffers: [String: AVAudioPCMBuffer] = [:]
    var pending: [String: [String: Any]] = [:]
    var activeUntil: [String: UInt64] = [:]
    var flushTask: DispatchWorkItem?
    var configurationObserver: NSObjectProtocol?
    var events: [[String: Any]] = []
    var enabled = true
    init() {
        let root = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("assets/sounds")
        for key in keys {
            do {
                let file = try AVAudioFile(forReading: root.appendingPathComponent(key + ".mp3"))
                guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)) else { continue }
                try file.read(into: buffer)
                let node = AVAudioPlayerNode(); engine.attach(node)
                engine.connect(node, to: engine.mainMixerNode, format: buffer.format)
                node.volume = 1
                nodes[key] = node; buffers[key] = buffer
            } catch { record(["event": "load-error", "key": key, "error": error.localizedDescription]) }
        }
        engine.mainMixerNode.outputVolume = 1
        start()
        configurationObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            self?.stopAll(); self?.start()
        }
    }
    deinit { if let observer = configurationObserver { NotificationCenter.default.removeObserver(observer) } }
    func start() {
        guard !engine.isRunning else { return }
        do { engine.prepare(); try engine.start() }
        catch { record(["event": "engine-error", "error": error.localizedDescription]) }
    }
    func record(_ value: [String: Any]) {
        var event = value; event["at"] = Date().timeIntervalSince1970
        events.append(event); if events.count > 1200 { events.removeFirst(events.count - 1200) }
    }
    func receive(_ command: [String: Any]) {
        guard let op = command["op"] as? String else { return }
        if op == "mode", let mode = command["mode"] as? String, ["speakers", "monitor", "off"].contains(mode) {
            enabled = mode != "off"; if !enabled { stopAll() }; return
        }
        if op == "stopAll" { stopAll(); return }
        guard let key = command["key"] as? String, let node = nodes[key] else { return }
        if op == "stop" { pending.removeValue(forKey: key); activeUntil.removeValue(forKey: key); node.stop(); return }
        guard op == "play", enabled else { return }
        pending[key] = command
        if flushTask == nil {
            let task = DispatchWorkItem { [weak self] in self?.flush() }
            flushTask = task
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.003, execute: task)
        }
    }
    func flush() {
        flushTask = nil
        let batch = pending; pending.removeAll()
        guard enabled, !batch.isEmpty else { return }
        start(); guard engine.isRunning else { return }
        let now = mach_absolute_time()
        // HTMLMediaElement.play() in the original did not restart a playing clip.
        // In particular systemfailure.mp3 is ~1.35s, so 1s requests play it every 2s.
        let ordered = batch.keys.sorted().filter { key in
            if let until = activeUntil[key], until > now {
                record(["event": "already-playing", "key": key, "left": batch[key]?["left"] ?? -1])
                return false
            }
            return true
        }
        for key in ordered {
            guard let node = nodes[key], let buffer = buffers[key] else { continue }
            node.stop(); node.scheduleBuffer(buffer, at: nil)
        }
        let host = mach_absolute_time() + AVAudioTime.hostTime(forSeconds: 0.050)
        let startTime = AVAudioTime(hostTime: host)
        for key in ordered {
            guard let node = nodes[key] else { continue }
            // isRunning can still be true while Core Audio is rebuilding the graph
            // (another process starting voice processing on this output). The
            // configuration-change notification arrives later; until then play raises.
            if let failure = LOSTCatchException({ node.play(at: startTime) }) {
                record(["event": "play-error", "key": key, "error": failure])
                stopAll(); engine.stop(); start()
                return
            }
            if let buffer = buffers[key] {
                let duration = Double(buffer.frameLength) / buffer.format.sampleRate
                activeUntil[key] = host + AVAudioTime.hostTime(forSeconds: duration)
            }
            record(["event": "scheduled", "key": key, "hostStart": host,
                    "requestedAt": batch[key]?["requestedAt"] ?? 0, "left": batch[key]?["left"] ?? -1,
                    "volume": node.volume, "leadMs": (AVAudioTime.seconds(forHostTime: host) - AVAudioTime.seconds(forHostTime: mach_absolute_time())) * 1000])
        }
    }
    func stopAll() {
        flushTask?.cancel(); flushTask = nil; pending.removeAll(); activeUntil.removeAll()
        for node in nodes.values { node.stop() }
    }
    func status() -> [String: Any] {
        ["engine": "AVAudioEngine", "running": engine.isRunning, "enabled": enabled, "events": events,
         "players": nodes.mapValues { ["playing": $0.isPlaying, "volume": $0.volume] as [String: Any] },
         "decoded": buffers.keys.sorted(), "mixerVolume": engine.mainMixerNode.outputVolume]
    }
}

// macOS 12 / Intel: no SwiftUI, private WebKit API or recent-only API.
final class StationWindow: NSWindow {
    var acceptsKeys = false
    override var canBecomeKey: Bool { acceptsKeys }
    override var canBecomeMain: Bool { acceptsKeys }
}

final class WeakStationHandler: NSObject, WKScriptMessageHandler {
    weak var app: StationApp?
    init(_ app: StationApp) { self.app = app }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let app = app,
              app.pages.values.contains(where: { message.webView === $0.web }) else { return }
        if message.body as? String == "desktop", message.webView === app.pages["console"]?.web { app.showDesktop(); return }
        if let command = message.body as? [String: Any] {
            if command["type"] as? String == "audio" { app.audio.receive(command) }
            if command["type"] as? String == "microphone", message.webView === app.pages["console"]?.web { app.microphone.command(command) }
        }
    }
}

final class StationPage: NSObject, WKNavigationDelegate {
    let role: String
    let window: StationWindow
    let web: WKWebView
    let base: URL
    weak var app: StationApp?
    var lastFailure: Date?
    var retryScheduled = false
    var shuttingDown = false
    init(role: String, screen: NSScreen, base: URL, app: StationApp) {
        self.role = role
        self.base = base
        self.app = app
        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = []
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.userContentController.add(WeakStationHandler(app), name: "station")
        config.userContentController.addUserScript(WKUserScript(source: "window.LostStation={desktop:function(){window.webkit.messageHandlers.station.postMessage('desktop')},audio:function(command){command.type='audio';window.webkit.messageHandlers.station.postMessage(command)},microphone:function(command){command.type='microphone';window.webkit.messageHandlers.station.postMessage(command)}};", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let errors = "window.__LOST_NATIVE_PLAY=HTMLMediaElement.prototype.play;window.__LOST_NATIVE_ERRORS=[];window.addEventListener('error',function(e){if(window.__LOST_NATIVE_ERRORS.length<100)window.__LOST_NATIVE_ERRORS.push(e.message)});window.addEventListener('unhandledrejection',function(e){if(window.__LOST_NATIVE_ERRORS.length<100)window.__LOST_NATIVE_ERRORS.push(String(e.reason))});"
        config.userContentController.addUserScript(WKUserScript(source: errors, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        web = WKWebView(frame: NSRect(origin: .zero, size: screen.frame.size), configuration: config)
        window = StationWindow(contentRect: screen.frame, styleMask: app.preview ? [.titled,.closable,.miniaturizable,.resizable] : [.borderless], backing: .buffered, defer: false)
        super.init()
        window.acceptsKeys = role == "console"
        window.title = role == "tv" ? "LOST — TIMER" : "LOST — TERMINAL"
        window.backgroundColor = .black
        window.isOpaque = true
        window.isReleasedWhenClosed = false
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.contentView = web
        web.autoresizingMask = [.width, .height]
        web.navigationDelegate = self
        window.setFrame(screen.frame, display: true)
        if app.stationShown { window.orderFrontRegardless() }
        load()
    }
    func load() {
        guard !shuttingDown else { return }
        // Missing ?mode is intentional: the core restores the persisted Live/Dev mode.
        let target = base.appendingPathComponent(role == "tv" ? "index.html" : "console.html")
        web.load(URLRequest(url: target))
    }
    func recover() {
        guard !retryScheduled && !shuttingDown else { return }
        retryScheduled = true
        lastFailure = Date()
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
            guard let self = self else { return }
            self.retryScheduled = false
            self.load()
        }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { if role == "tv" { app?.audio.stopAll() }; recover() }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { if role == "tv" { app?.audio.stopAll() } }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { recover() }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { recover() }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url,
              url.scheme == base.scheme, url.host == base.host, url.port == base.port,
              navigationAction.targetFrame?.isMainFrame != false else {
            decisionHandler(.cancel); return
        }
        decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if role == "console" {
            app?.publishInputSource(force: true)
            if app?.stationShown == true { window.makeKeyAndOrderFront(nil); window.makeFirstResponder(web) }
        }
    }
    func close() { if role == "tv" { app?.audio.stopAll() }; shuttingDown = true; web.configuration.userContentController.removeScriptMessageHandler(forName: "station"); web.stopLoading(); window.close() }
}

final class StationApp: NSObject, NSApplicationDelegate {
    var pages: [String: StationPage] = [:]
    lazy var audio = StationAudio()
    lazy var microphone = StationMicrophone(baseURL: base) { [weak self] value in
        guard let self = self, let data = try? JSONSerialization.data(withJSONObject: value), let json = String(data: data, encoding: .utf8) else { return }
        self.pages["console"]?.web.evaluateJavaScript("window.dispatchEvent(new CustomEvent('lost-muse-microphone',{detail:\(json)}));", completionHandler: nil)
    }
    var watchdog: Timer?
    var snapshotTimer: Timer?
    var ending = false
    var terminationReplied = false
    var lastLayout = ""
    var lastInputSourceID = ""
    let args = CommandLine.arguments
    var owner: pid_t = 0
    var ownerToken = ""
    var ownerLease: URL?
    var base = URL(string: "http://localhost:8765")!
    var displayName = "Waveshare-625"
    var localTimer = true
    var statusURL: URL?
    var diagnostics = false
    var preview = false
    var desktopMode = false
    var desktopKeyDown = false
    var hotKey: EventHotKeyRef?
    var hotKeyHandler: EventHandlerRef?
    var localKeyMonitor: Any?
    var activity: NSObjectProtocol?
    func argument(_ flag: String) -> String? {
        guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
        return args[i + 1]
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSLog("LOST: GUI launch callback")
        guard args.contains("--managed") else {
            let task = Process()
            task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
            task.arguments = ["kickstart", "gui/\(getuid())/com.exrector.lost"]
            do {
                try task.run(); task.waitUntilExit()
                if task.terminationStatus != 0 {
                    let root = Bundle.main.bundleURL.deletingLastPathComponent()
                    let launcher = root.appendingPathComponent("cast-app/start.command")
                    if FileManager.default.isExecutableFile(atPath: launcher.path) {
                        let portable = Process(); portable.executableURL = URL(fileURLWithPath: "/bin/bash")
                        portable.arguments = [launcher.path]; portable.standardOutput = FileHandle.nullDevice; portable.standardError = FileHandle.nullDevice
                        try portable.run()
                    }
                }
            } catch { NSLog("LOST: launchctl: %@", error.localizedDescription) }
            DistributedNotificationCenter.default().postNotificationName(Notification.Name("com.exrector.lost.activate"), object: nil, userInfo: nil, deliverImmediately: true)
            NSApp.terminate(nil); return
        }
        guard let parent = argument("--owner-pid").flatMap(Int32.init), parent > 1, kill(parent, 0) == 0,
              let address = argument("--url"), let url = URL(string: address),
              url.scheme == "http", ["localhost", "127.0.0.1"].contains(url.host ?? "") else {
            exit(2)
        }
        owner = parent; base = url
        ownerToken = argument("--owner-token") ?? ""
        if let path = argument("--owner-lease") { ownerLease = URL(fileURLWithPath:path) }
        guard ownerAlive() else { NSLog("LOST: owner lease rejected"); exit(2) }
        NSLog("LOST: owner lease accepted")
        _ = audio
        NSLog("LOST: output audio initialized")
        displayName = argument("--display") ?? displayName
        localTimer = !args.contains("--no-timer")
        if let path = argument("--status") { statusURL = URL(fileURLWithPath: path) }
        diagnostics = args.contains("--diagnostics")
        preview = args.contains("--preview")
        NSApp.setActivationPolicy(.regular)
        NSApp.presentationOptions = preview ? [] : [.hideDock, .hideMenuBar]
        let menu = NSMenu()
        let appItem = NSMenuItem(); menu.addItem(appItem)
        let appMenu = NSMenu(); appItem.submenu = appMenu
        appMenu.addItem(withTitle: "Рабочий стол — PF6", action: #selector(showDesktop), keyEquivalent: "h").target = self
        appMenu.addItem(withTitle: "Вернуть станцию", action: #selector(activateStation), keyEquivalent: "").target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Завершить LOST", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        // Without an Edit menu AppKit has no ⌘C/⌘V/⌘X/⌘A/⌘Z key equivalents: WKWebView never gets them and the system beeps.
        let editItem = NSMenuItem(); menu.addItem(editItem)
        let editMenu = NSMenu(title: "Правка"); editItem.submenu = editMenu
        editMenu.addItem(withTitle: "Отменить", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Повторить", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Вырезать", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Скопировать", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Вставить", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Выделить всё", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        NSApp.mainMenu = menu
        installDesktopKey()
        activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated, .latencyCritical], reason: "LOST countdown and telemetry continue while the desktop is in use")
        NotificationCenter.default.addObserver(self, selector: #selector(screensChanged), name: NSApplication.didChangeScreenParametersNotification, object: nil)
        DistributedNotificationCenter.default().addObserver(self, selector: #selector(activateStation), name: Notification.Name("com.exrector.lost.activate"), object: nil)
        DistributedNotificationCenter.default().addObserver(self, selector: #selector(showDesktop), name: Notification.Name("com.exrector.lost.desktop"), object: nil)
        DistributedNotificationCenter.default().addObserver(self, selector: #selector(snapshot), name: Notification.Name("com.exrector.lost.diagnostics"), object: nil)
        layout()
        NSApp.activate(ignoringOtherApps: true)
        pages["console"]?.window.makeKeyAndOrderFront(nil)
        watchdog = Timer(timeInterval: 2, repeats: true) { [weak self] _ in self?.tick() }
        RunLoop.main.add(watchdog!, forMode: .common)
        tick()
        // Ask once on the first managed launch, before the voice UI is opened.
        // Existing grants and denials remain untouched.
        if !preview && AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
            DispatchQueue.main.async { [weak self] in
                self?.microphone.command(["op": "authorize"])
            }
        }
        if diagnostics {
            snapshotTimer = Timer(timeInterval: 10, repeats: true) { [weak self] _ in self?.snapshot() }
            RunLoop.main.add(snapshotTimer!, forMode: .common)
        }
    }
    func installDesktopKey() {
        if preview { return }
        let events = [EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
                      EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased))]
        let result = events.withUnsafeBufferPointer { buffer in
            InstallEventHandler(GetApplicationEventTarget(), { _, event, context in
                guard let context = context, let event = event else { return OSStatus(eventNotHandledErr) }
                let app = Unmanaged<StationApp>.fromOpaque(context).takeUnretainedValue()
                if GetEventKind(event) == UInt32(kEventHotKeyReleased) { app.desktopKeyDown = false }
                else if !app.desktopKeyDown { app.desktopKeyDown = true; app.showDesktop() }
                return noErr
            }, events.count, buffer.baseAddress, Unmanaged.passUnretained(self).toOpaque(), &hotKeyHandler)
        }
        let registered = result == noErr ? RegisterEventHotKey(UInt32(kVK_F6), 0, EventHotKeyID(signature: 0x4C4F5354, id: 6), GetApplicationEventTarget(), 0, &hotKey) : result
        if registered != noErr {
            NSLog("LOST: global PF6 unavailable (%d); local PF6 and Dock remain available", registered)
            localKeyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                if event.keyCode == UInt16(kVK_F6) && event.modifierFlags.intersection([.command,.control,.option,.shift]).isEmpty {
                    if !event.isARepeat { self?.showDesktop() }; return nil
                }
                return event
            }
        }
    }
    var stationShown: Bool { !desktopMode && !NSApp.isHidden }
    @objc func showDesktop() {
        microphone.cancel()
        desktopMode = true
        NSApp.presentationOptions = []
        // Hiding alone is not enough: any activation (Cmd+Tab, Screen Sharing, launchservicesd) unhides the app
        // and its full-screen windows would cover both displays again. Ordered-out windows stay off-screen.
        for page in pages.values { page.window.orderOut(nil) }
        NSApp.hide(nil)
        NSLog("LOST: desktop; countdown continues")
        tick()
    }
    @objc func activateStation() {
        desktopMode = false
        NSApp.presentationOptions = preview ? [] : [.hideDock, .hideMenuBar]
        NSApp.unhide(nil)
        NSApp.activate(ignoringOtherApps: true)
        for page in pages.values { page.window.orderFront(nil) }
        pages["console"]?.window.makeKeyAndOrderFront(nil)
        if let page = pages["console"] { page.window.makeFirstResponder(page.web) }
        tick()
    }
    // Leaving the desktop needs an explicit request: Dock icon / LOST.app (reopen), the menu item or the distributed notification.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { activateStation(); return false }
    @objc func screensChanged() { layout() }
    func layout() {
        let screens = NSScreen.screens
        guard let main = screens.first else { return }
        if preview {
            let visible = main.visibleFrame
            let width = min(1000.0, visible.width - 48)
            let height = min(460.0, visible.height * 0.52)
            for (role, rect) in [("tv", NSRect(x: visible.midX-width/2, y: visible.maxY-height-24, width: width, height: height)),
                                 ("console", NSRect(x: visible.midX-width/2, y: visible.minY+16, width: width, height: max(230,visible.height-height-90)))] {
                if pages[role] == nil { pages[role] = StationPage(role: role, screen: main, base: base, app: self) }
                pages[role]?.window.setFrame(rect, display: true)
                pages[role]?.window.title = role == "tv" ? "LOST Preview — TIMER" : "LOST Preview — TERMINAL"
            }
            return
        }
        let target = screens.first(where: { $0.localizedName == displayName }) ?? (screens.count > 1 ? screens.last : nil)
        // Put the terminal on the other display even when the timer display is the macOS primary.
        let console = screens.first(where: { $0 !== target }) ?? main
        let assignments: [(String, NSScreen?)] = [("console", console), ("tv", localTimer ? target : nil)]
        for (role, screen) in assignments {
            guard let screen = screen else { pages.removeValue(forKey: role)?.close(); continue }
            if let page = pages[role] { page.window.setFrame(screen.frame, display: true) }
            else { pages[role] = StationPage(role: role, screen: screen, base: base, app: self) }
        }
        let key = screens.map { "\($0.localizedName):\($0.frame)" }.joined(separator: ";")
        if key != lastLayout { NSLog("LOST displays: %@", key); lastLayout = key }
        if !desktopMode && !NSApp.isHidden { pages["console"]?.window.makeKeyAndOrderFront(nil) }
    }
    func ownerAlive() -> Bool {
        guard owner > 1, kill(owner,0) == 0 else { return false }
        if ownerToken.isEmpty { return getppid() == owner }
        guard let url = ownerLease, let data = try? Data(contentsOf:url),
              let lease = (try? JSONSerialization.jsonObject(with:data)) as? [String:Any],
              lease["owner"] as? Int == Int(owner), lease["token"] as? String == ownerToken,
              let updated = lease["updatedAt"] as? Double,
              Date().timeIntervalSince1970 * 1000 - updated < 30000 else { return false }
        return true
    }
    func inputSourceSnapshot() -> [String: String] {
        guard let unmanaged = TISCopyCurrentKeyboardLayoutInputSource() else {
            return ["id": "", "label": "--"]
        }
        let source = unmanaged.takeRetainedValue()
        guard let pointer = TISGetInputSourceProperty(source, kTISPropertyInputSourceID) else {
            return ["id": "", "label": "--"]
        }
        let id = Unmanaged<CFString>.fromOpaque(pointer).takeUnretainedValue() as String
        let normalized = id.lowercased()
        let label: String
        if normalized.contains("russian") || normalized.contains("cyrillic") { label = "RU" }
        else if normalized.contains("abc") || normalized.contains("us") { label = "EN" }
        else {
            let name = id.split(separator: ".").last.map(String.init) ?? id
            label = String(name.prefix(3)).uppercased()
        }
        return ["id": id, "label": label]
    }
    func publishInputSource(force: Bool = false) {
        let value = inputSourceSnapshot()
        let id = value["id"] ?? ""
        guard force || id != lastInputSourceID else { return }
        lastInputSourceID = id
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
              let json = String(data: data, encoding: .utf8) else { return }
        pages["console"]?.web.evaluateJavaScript("window.__LOST_INPUT_SOURCE=\(json);window.dispatchEvent(new CustomEvent('lost-input-source',{detail:window.__LOST_INPUT_SOURCE}));", completionHandler: nil)
    }
    func tick() {
        if !ownerAlive() { ending = true; NSApp.terminate(nil); return }
        publishInputSource()
        guard let statusURL = statusURL else { return }
        // Same-user control file also works from SSH without GUI automation permissions.
        let commandURL = statusURL.deletingLastPathComponent().appendingPathComponent("native-command.txt")
        if let command = try? String(contentsOf: commandURL, encoding: .utf8) {
            try? FileManager.default.removeItem(at: commandURL)
            switch command.trimmingCharacters(in: .whitespacesAndNewlines) {
            case "desktop": showDesktop()
            case "activate": activateStation()
            case "diagnostics": snapshot()
            case "microphone-permission": activateStation(); microphone.command(["op":"authorize"])
            // Same-user microphone diagnostics never send captured audio.
            case "microphone-start": microphone.command(["op":"start"])
            case "microphone-stop": microphone.command(["op":"stop"])
            case "microphone-cancel": microphone.command(["op":"cancel"])
            case "microphone-chat-open": microphone.command(["op":"chat-open"])
            case "microphone-chat-close": microphone.command(["op":"chat-close"])
            default: break
            }
        }
        let info: [String: Any] = ["pid": getpid(), "owner": owner, "ownerToken": ownerToken, "bundle": Bundle.main.bundlePath, "renderer": "WKWebView", "desktopMode": desktopMode, "hidden": NSApp.isHidden, "globalPF6": hotKey != nil, "inputSource": inputSourceSnapshot(), "microphone": microphone.snapshot(), "updatedAt": Date().timeIntervalSince1970,
            "windows": pages.mapValues { ["url": $0.web.url?.absoluteString ?? "", "loading": $0.web.isLoading,
                                          "width": $0.web.bounds.width, "height": $0.web.bounds.height] as [String: Any] }]
        if let data = try? JSONSerialization.data(withJSONObject: info, options: [.sortedKeys]) { try? data.write(to: statusURL, options: .atomic) }
    }
    @objc func snapshot() {
        guard let statusURL = statusURL else { return }
        if let data = try? JSONSerialization.data(withJSONObject: audio.status(), options: [.sortedKeys]) {
            try? data.write(to: statusURL.deletingLastPathComponent().appendingPathComponent("native-audio.json"), options: .atomic)
        }
        for (role, page) in pages {
            let probe = "JSON.stringify({ready:document.readyState,url:location.href,errors:window.__LOST_NATIVE_ERRORS,viewport:[innerWidth,innerHeight],clipPath:CSS.supports('clip-path','inset(0 0 50% 0)'),transform3d:CSS.supports('transform','rotateX(90deg)'),digits:Array.from(document.querySelectorAll('.lost-flipper-prev .lost-flipper-number-table-cell')).map(function(e){return e.textContent.trim()}).join(''),input:!!document.querySelector('.my-console'),opener:!!window.opener,abortTimeout:typeof AbortSignal.timeout,requestSubmit:typeof HTMLFormElement.prototype.requestSubmit,hidden:document.hidden,clock:window.__LOST_CLOCK,audio:window.__LOST_TIMER?window.__LOST_TIMER.audioEvents:[],media:Array.from(document.querySelectorAll('audio')).map(function(a){return {src:a.getAttribute('src'),time:a.currentTime,paused:a.paused,ended:a.ended,muted:a.muted,volume:a.volume,ready:a.readyState,error:a.error?a.error.code:null}}),inputSource:window.__LOST_INPUT_SOURCE||null,inputSourceLine:document.querySelector('.input-source-line')?document.querySelector('.input-source-line').textContent:null,ups:window.LostUPS?window.LostUPS.status():null,upsLine:document.querySelector('.ups-line')?document.querySelector('.ups-line').textContent:null})"
            page.web.evaluateJavaScript(probe) { value, error in
                if let json = value as? String { try? json.write(to: statusURL.deletingLastPathComponent().appendingPathComponent("native-\(role)-diagnostics.json"), atomically: true, encoding: .utf8) }
            }
            page.web.takeSnapshot(with: nil) { image, error in
                guard let image = image, let tiff = image.tiffRepresentation,
                      let bitmap = NSBitmapImageRep(data: tiff), let png = bitmap.representation(using: .png, properties: [:]) else { return }
                try? png.write(to: statusURL.deletingLastPathComponent().appendingPathComponent("native-\(role).png"), options: .atomic)
            }
        }
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if ending || owner == 0 { return .terminateNow }
        ending = true
        URLSession.shared.dataTask(with: base.appendingPathComponent("__quit")) { _, _, _ in
            DispatchQueue.main.async { self.finishTermination() }
        }.resume()
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { self.finishTermination() }
        return .terminateLater
    }
    func finishTermination() {
        guard !terminationReplied else { return }; terminationReplied = true
        NSApp.reply(toApplicationShouldTerminate: true)
    }
    func applicationWillTerminate(_ notification: Notification) {
        microphone.shutdown()
        watchdog?.invalidate(); snapshotTimer?.invalidate()
        if owner > 0 { audio.stopAll() }
        if let hotKey = hotKey { UnregisterEventHotKey(hotKey) }
        if let handler = hotKeyHandler { RemoveEventHandler(handler) }
        if let monitor = localKeyMonitor { NSEvent.removeMonitor(monitor) }
        if let activity = activity { ProcessInfo.processInfo.endActivity(activity) }
        for page in pages.values { page.close() }
        if let url = statusURL { try? FileManager.default.removeItem(at: url) }
    }
}
let app = NSApplication.shared
let delegate = StationApp()
app.delegate = delegate
app.run()
