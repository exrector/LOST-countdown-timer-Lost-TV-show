import Foundation
import AVFoundation

// Swift 5.7 из Command Line Tools на macOS Monterey не импортирует новые
// AVCaptureDevice.was*Notification, хотя сами уведомления существуют с 10.7.
// Стабильные Objective-C raw names сохраняют hot-plug микрофона и позволяют
// собирать тот же исходник как старым SDK mini, так и современным SDK разработки.
private extension Notification.Name {
    static let lostCaptureDeviceConnected = Notification.Name("AVCaptureDeviceWasConnectedNotification")
    static let lostCaptureDeviceDisconnected = Notification.Name("AVCaptureDeviceWasDisconnectedNotification")
}

// An input-only recorder. It never changes the station's output device or engine.
private final class MicrophoneNoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil) // Captured audio must never leave the loopback bridge via a redirect.
    }
}

final class StationMicrophone: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate {
    // The device delivers 48 kHz, RNNoise's native rate (VoiceDenoiser); the bridge
    // (muse/chat_adapter.py) accepts exactly 16-kHz mono signed-16-bit PCM WAV.
    private static let captureRate = 48000.0
    private static let rate = 16000.0
    private static let maxSeconds = 45.0
    private let update: ([String: Any]) -> Void
    private let endpoint: URL?
    private let origin: String?
    private let captureQueue = DispatchQueue(label: "com.exrector.lost.microphone")
    private var capture: AVCaptureSession?
    private var dataOutput: AVCaptureAudioDataOutput?
    private var denoiser: (output: AVCaptureAudioDataOutput, filter: VoiceDenoiser)? // capture queue only
    private var pcm = Data() // held in memory only, never written to disk
    private var deviceName = ""
    private var meterTimer: Timer?
    private var uploadTask: URLSessionUploadTask?
    private var disconnectObserver: NSObjectProtocol?
    private var connectObserver: NSObjectProtocol?
    private var deviceID: String?
    private var generation = 0
    private var wantRecord = false
    private var requesting = false
    private var permissionRequests = 0
    private var lastCommand = ""
    private var recording = false
    private var uploading = false
    private var finished = false
    private var elapsed: TimeInterval = 0
    private var level: Float = 0
    private var errorText: String?
    private var startedAt: Date?
    private var shouldSend = true
    private var draft: Data?
    private let maxBytes = 2 * 1024 * 1024
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 70
        config.timeoutIntervalForResource = 75
        return URLSession(configuration: config, delegate: MicrophoneNoRedirects(), delegateQueue: .main)
    }()

    init(baseURL: URL, update: @escaping ([String: Any]) -> Void) {
        self.update = update
        if var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false),
           components.scheme == "http", components.user == nil, components.password == nil,
           ["localhost", "127.0.0.1", "::1"].contains(components.host ?? "") {
            components.path = ""; components.query = nil; components.fragment = nil
            self.origin = components.url?.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            components.path = "/__muse/voice"
            self.endpoint = components.url
        } else { self.endpoint = nil; self.origin = nil }
        super.init()
        connectObserver = NotificationCenter.default.addObserver(forName: .lostCaptureDeviceConnected, object: nil, queue: .main) { [weak self] _ in self?.publish() }
        disconnectObserver = NotificationCenter.default.addObserver(forName: .lostCaptureDeviceDisconnected, object: nil, queue: .main) { [weak self] notification in
            guard let self = self else { return }
            if let device = notification.object as? AVCaptureDevice, device.uniqueID == self.deviceID, self.recording || self.requesting {
                self.cancelCapture(error: "Микрофон отключён. Запись отменена")
            } else { self.publish() }
        }
    }

    deinit {
        meterTimer?.invalidate()
        capture?.stopRunning()
        uploadTask?.cancel()
        if let observer = disconnectObserver { NotificationCenter.default.removeObserver(observer) }
        if let observer = connectObserver { NotificationCenter.default.removeObserver(observer) }
    }

    func command(_ command: [String: Any]) {
        guard Thread.isMainThread else { DispatchQueue.main.async { [weak self] in self?.command(command) }; return }
        lastCommand = command["op"] as? String ?? ""
        switch command["op"] as? String {
        case "authorize": authorize()
        case "query": publish()
        case "start": start()
        case "stop": stopRecording()
        case "send": sendDraft()
        case "cancel": cancel()
        default: break
        }
    }

    func cancel() {
        guard Thread.isMainThread else { DispatchQueue.main.async { [weak self] in self?.cancel() }; return }
        let wasUploading = uploading
        cancelCapture(error: wasUploading ? "Отправка прервана. Проверьте историю перед повтором" : nil)
    }

    func snapshot() -> [String: Any] {
        // The meter publishes ten times a second while recording; keep the chosen device then.
        let name = recording ? deviceName : (AVCaptureDevice.default(for: .audio)?.localizedName ?? "")
        var value: [String: Any] = ["available": !name.isEmpty, "supported": true, "recording": recording,
                                   "level": level, "elapsed": elapsed, "uploading": uploading,
                                   "requesting": requesting, "finished": finished, "draftReady": draft != nil, "device": name, "authorization": AVCaptureDevice.authorizationStatus(for: .audio).rawValue, "permissionRequests": permissionRequests, "lastCommand": lastCommand]
        value["error"] = errorText ?? ""
        return value
    }

    private func publish() { update(snapshot()) }

    private func authorize() {
        guard !requesting else { publish(); return }
        guard AVCaptureDevice.default(for: .audio) != nil else { fail("Микрофон не подключён"); return }
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .notDetermined:
            requesting = true; errorText = nil; permissionRequests += 1; publish()
            AVCaptureDevice.requestAccess(for: .audio) { [weak self] allowed in
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    self.requesting = false
                    self.errorText = allowed ? nil : "macOS не разрешила доступ к микрофону"
                    self.publish()
                }
            }
        case .authorized: errorText = nil; publish()
        case .denied, .restricted: fail("Разрешите LOST доступ к микрофону в настройках macOS")
        @unknown default: fail("Не удалось проверить разрешение микрофона")
        }
    }

    private func start() {
        guard !recording, !requesting, !uploading, capture == nil else { publish(); return }
        generation += 1
        let current = generation
        draft = nil
        finished = false; errorText = nil; elapsed = 0; level = 0; wantRecord = true
        guard endpoint != nil, origin != nil else { fail("Недоступен локальный мост голосового ввода"); return }
        guard let device = AVCaptureDevice.default(for: .audio) else { fail("Микрофон не подключён"); return }
        deviceID = device.uniqueID
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: beginRecording(current, device)
        case .notDetermined:
            requesting = true; permissionRequests += 1; publish()
            AVCaptureDevice.requestAccess(for: .audio) { [weak self] allowed in
                DispatchQueue.main.async {
                    guard let self = self, self.generation == current, self.wantRecord else { return }
                    self.requesting = false
                    if allowed { self.beginRecording(current, device) }
                    else { self.fail("macOS не разрешила доступ к микрофону") }
                }
            }
        case .denied, .restricted: fail("Разрешите LOST доступ к микрофону в настройках macOS")
        @unknown default: fail("Не удалось проверить разрешение микрофона")
        }
    }

    private func beginRecording(_ current: Int, _ device: AVCaptureDevice) {
        guard current == generation, wantRecord else { return }
        let session = AVCaptureSession()
        let output = AVCaptureAudioDataOutput()
        output.audioSettings = [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: Self.captureRate,
            AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true,
            AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false]
        guard let filter = VoiceDenoiser() else { fail("Не удалось запустить шумоподавление"); return }
        // Fresh RNNoise state per recording, installed before the first buffer can arrive.
        captureQueue.sync { denoiser = (output, filter) }
        output.setSampleBufferDelegate(self, queue: captureQueue)
        guard let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input), session.canAddOutput(output) else {
            fail("Не удалось подготовить запись микрофона"); return
        }
        session.addInput(input); session.addOutput(output)
        pcm = Data(); capture = session; dataOutput = output; deviceName = device.localizedName
        session.startRunning()
        guard session.isRunning else { fail("Микрофон не начал запись"); return }
        recording = true; requesting = false; shouldSend = true; startedAt = Date()
        meterTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            guard let self = self, self.recording else { return }
            self.publish()
        }
        publish()
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let format = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee,
              let block = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
        let length = CMBlockBufferGetDataLength(block)
        guard length >= 4, let denoiser = denoiser, denoiser.output === output else { return }
        let valid = asbd.mFormatID == kAudioFormatLinearPCM && asbd.mSampleRate == Self.captureRate && asbd.mChannelsPerFrame == 1
            && asbd.mBitsPerChannel == 32 && asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0
            && asbd.mFormatFlags & (kAudioFormatFlagIsBigEndian | kAudioFormatFlagIsNonInterleaved) == 0
        var samples = [Float](repeating: 0, count: length / 4)
        let status = samples.withUnsafeMutableBytes { CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: $0.count, destination: $0.baseAddress!) }
        let ok = valid && status == kCMBlockBufferNoErr
        let bytes = ok ? samples.withUnsafeBufferPointer { denoiser.filter.process($0) } : Data()
        DispatchQueue.main.async { [weak self] in self?.receive(bytes, valid: ok, from: output) }
    }

    private func receive(_ bytes: Data, valid: Bool, from output: AVCaptureOutput) {
        guard output === dataOutput else { return }
        guard valid else { fail("Микрофон выдал неожиданный формат. Запись отменена"); return }
        let room = max(0, Int(Self.rate * Self.maxSeconds) * 2 - pcm.count)
        pcm.append(bytes.prefix(room))
        elapsed = Double(pcm.count) / (Self.rate * 2)
        var sum = 0.0, count = 0
        bytes.withUnsafeBytes { raw in
            for sample in raw.bindMemory(to: Int16.self) { let v = Double(sample) / 32768; sum += v * v; count += 1 }
        }
        level = count > 0 ? Float(min(1, sqrt(sum / Double(count)))) : 0
        if recording && room <= bytes.count { stopRecording() }
    }

    private func stopRecording() {
        wantRecord = false
        if requesting {
            generation += 1; requesting = false; finished = true; publish(); return
        }
        guard let session = capture, recording else { return }
        shouldSend = true
        recording = false; level = 0
        meterTimer?.invalidate(); meterTimer = nil
        session.stopRunning()
        // Buffers already on the capture queue still hop to main; let them land first.
        captureQueue.async { [weak self, weak session] in
            DispatchQueue.main.async {
                guard let self = self, let session = session, self.capture === session else { return }
                self.finish()
            }
        }
        publish()
    }

    private func cancelCapture(error: String?) {
        generation += 1; wantRecord = false; requesting = false; shouldSend = false; draft = nil
        meterTimer?.invalidate(); meterTimer = nil
        capture?.stopRunning(); capture = nil; dataOutput = nil
        uploadTask?.cancel(); uploadTask = nil
        recording = false; uploading = false; level = 0; finished = true; errorText = error
        cleanup(); publish()
    }

    private func fail(_ message: String) { cancelCapture(error: message) }

    private func cleanup() {
        pcm = Data(); startedAt = nil
        captureQueue.async { [weak self] in self?.denoiser = nil }
    }

    private func finish() {
        let held = startedAt.map { Date().timeIntervalSince($0) } ?? 0
        capture = nil; dataOutput = nil; recording = false; requesting = false; wantRecord = false; level = 0; finished = true
        meterTimer?.invalidate(); meterTimer = nil
        guard shouldSend else { fail("Запись не завершена. Сообщение не отправлено"); return }
        if pcm.isEmpty && held >= 0.15 { fail("Микрофон не передал звук. Сообщение не отправлено"); return }
        guard elapsed >= 0.15 else { cleanup(); errorText = nil; publish(); return }
        let data = Self.wav(pcm)
        cleanup()
        guard data.count > 44, data.count <= maxBytes else { fail("Недопустимая длина голосовой записи"); return }
        draft = data; errorText = nil; publish()
    }

    // Canonical 44-byte PCM header: Python's wave module rejects extensible/odd layouts.
    private static func wav(_ pcm: Data) -> Data {
        var data = Data(capacity: 44 + pcm.count)
        func text(_ value: String) { data.append(contentsOf: Array(value.utf8)) }
        func u32(_ value: UInt32) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
        func u16(_ value: UInt16) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
        text("RIFF"); u32(UInt32(36 + pcm.count)); text("WAVE")
        text("fmt "); u32(16); u16(1); u16(1); u32(UInt32(rate)); u32(UInt32(rate) * 2); u16(2); u16(16)
        text("data"); u32(UInt32(pcm.count)); data.append(pcm)
        return data
    }

    private func sendDraft() {
        guard !recording, !requesting, !uploading, let data = draft,
              let endpoint = endpoint, let origin = origin else { publish(); return }
        draft = nil
        uploading = true; errorText = nil; publish()
            var request = URLRequest(url: endpoint)
            request.httpMethod = "POST"
            request.timeoutInterval = 70
            request.setValue("audio/wav", forHTTPHeaderField: "Content-Type")
            request.setValue("1", forHTTPHeaderField: "X-LOST-Muse")
            request.setValue(origin, forHTTPHeaderField: "Origin")
            let current = generation
            uploadTask = session.uploadTask(with: request, from: data) { [weak self] data, response, error in
                DispatchQueue.main.async {
                    guard let self = self, self.generation == current else { return }
                    self.uploadTask = nil; self.uploading = false
                    let code = (response as? HTTPURLResponse)?.statusCode ?? 0
                    let body = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
                    if error != nil { self.errorText = "Не удалось подтвердить отправку. Проверьте историю перед повтором" }
                    else if code == 409 { self.errorText = "Muse ещё отвечает на предыдущий запрос" }
                    else if !(200..<300).contains(code) || body?["ok"] as? Bool != true { self.errorText = "Muse не подтвердил приём записи. Проверьте связь и историю" }
                    self.publish()
                }
            }
            uploadTask?.resume()
    }
}
