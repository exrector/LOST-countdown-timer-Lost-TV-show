import Foundation
import AVFoundation

// An input-only recorder. It never changes the station's output device or engine.
private final class MicrophoneNoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil) // Captured audio must never leave the loopback bridge via a redirect.
    }
}

final class StationMicrophone: NSObject, AVAudioRecorderDelegate {
    private let update: ([String: Any]) -> Void
    private let endpoint: URL?
    private let origin: String?
    private var recorder: AVAudioRecorder?
    private var directory: URL?
    private var fileURL: URL?
    private var meterTimer: Timer?
    private var uploadTask: URLSessionUploadTask?
    private var disconnectObserver: NSObjectProtocol?
    private var connectObserver: NSObjectProtocol?
    private var deviceID: String?
    private var generation = 0
    private var wantRecord = false
    private var requesting = false
    private var recording = false
    private var uploading = false
    private var finished = false
    private var elapsed: TimeInterval = 0
    private var level: Float = 0
    private var errorText: String?
    private var startedAt: Date?
    private var shouldSend = true
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
        connectObserver = NotificationCenter.default.addObserver(forName: AVCaptureDevice.wasConnectedNotification, object: nil, queue: .main) { [weak self] _ in self?.publish() }
        disconnectObserver = NotificationCenter.default.addObserver(forName: AVCaptureDevice.wasDisconnectedNotification, object: nil, queue: .main) { [weak self] notification in
            guard let self = self else { return }
            if let device = notification.object as? AVCaptureDevice, device.uniqueID == self.deviceID, self.recording || self.requesting {
                self.cancelCapture(error: "Микрофон отключён. Запись отменена")
            } else { self.publish() }
        }
    }

    deinit {
        meterTimer?.invalidate()
        recorder?.delegate = nil
        recorder?.stop()
        uploadTask?.cancel()
        if let observer = disconnectObserver { NotificationCenter.default.removeObserver(observer) }
        if let observer = connectObserver { NotificationCenter.default.removeObserver(observer) }
        if let directory = directory { try? FileManager.default.removeItem(at: directory) }
    }

    func command(_ command: [String: Any]) {
        guard Thread.isMainThread else { DispatchQueue.main.async { [weak self] in self?.command(command) }; return }
        switch command["op"] as? String {
        case "query": publish()
        case "start": start()
        case "stop": stopAndSend()
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
        let device = AVCaptureDevice.default(for: .audio)
        let available = device != nil
        var value: [String: Any] = ["available": available, "supported": true, "recording": recording,
                                   "level": level, "elapsed": elapsed, "uploading": uploading,
                                   "requesting": requesting, "finished": finished, "device": device?.localizedName ?? "", "authorization": AVCaptureDevice.authorizationStatus(for: .audio).rawValue]
        value["error"] = errorText ?? ""
        return value
    }

    private func publish() { update(snapshot()) }

    private func start() {
        guard !recording, !requesting, !uploading, recorder == nil else { publish(); return }
        generation += 1
        let current = generation
        finished = false; errorText = nil; elapsed = 0; level = 0; wantRecord = true
        guard endpoint != nil, origin != nil else { fail("Недоступен локальный мост голосового ввода"); return }
        guard let device = AVCaptureDevice.default(for: .audio) else { fail("Микрофон не подключён"); return }
        deviceID = device.uniqueID
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: beginRecording(current)
        case .notDetermined:
            requesting = true; publish()
            AVCaptureDevice.requestAccess(for: .audio) { [weak self] allowed in
                DispatchQueue.main.async {
                    guard let self = self, self.generation == current, self.wantRecord else { return }
                    self.requesting = false
                    if allowed { self.beginRecording(current) }
                    else { self.fail("macOS не разрешила доступ к микрофону") }
                }
            }
        case .denied, .restricted: fail("Разрешите LOST доступ к микрофону в настройках macOS")
        @unknown default: fail("Не удалось проверить разрешение микрофона")
        }
    }

    private func beginRecording(_ current: Int) {
        guard current == generation, wantRecord else { return }
        guard AVCaptureDevice.default(for: .audio) != nil else { fail("Микрофон отключён"); return }
        do {
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("lost-muse-voice-" + UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            directory = dir
            let url = dir.appendingPathComponent("voice.wav")
            fileURL = url
            let settings: [String: Any] = [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16000.0,
                AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16,
                AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false]
            let capture = try AVAudioRecorder(url: url, settings: settings)
            capture.delegate = self; capture.isMeteringEnabled = true; recorder = capture
            guard capture.prepareToRecord(), capture.record(forDuration: 45) else { fail("Не удалось начать запись с микрофона"); return }
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
            recording = capture.isRecording; requesting = false; shouldSend = true; startedAt = Date()
            guard recording else { fail("Микрофон не начал запись"); return }
            meterTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
                guard let self = self, self.recording, let capture = self.recorder else { return }
                capture.updateMeters()
                self.elapsed = min(45, capture.currentTime)
                let db = capture.averagePower(forChannel: 0)
                self.level = max(0, min(1, pow(10, db / 20)))
                self.publish()
            }
            publish()
        } catch { fail("Не удалось подготовить запись микрофона") }
    }

    private func stopAndSend() {
        wantRecord = false
        if requesting {
            generation += 1; requesting = false; finished = true; publish(); return
        }
        guard let capture = recorder else { return }
        shouldSend = true
        elapsed = max(elapsed, capture.currentTime)
        recording = false; level = 0
        meterTimer?.invalidate(); meterTimer = nil
        capture.stop()
        // stop() finalizes the WAV; delegate and fallback share an identity guard.
        DispatchQueue.main.async { [weak self, weak capture] in
            guard let self = self, let capture = capture, self.recorder === capture else { return }
            self.finalize(capture, successful: true)
        }
        publish()
    }

    private func cancelCapture(error: String?) {
        generation += 1; wantRecord = false; requesting = false; shouldSend = false
        meterTimer?.invalidate(); meterTimer = nil
        recorder?.delegate = nil; recorder?.stop(); recorder = nil
        uploadTask?.cancel(); uploadTask = nil
        recording = false; uploading = false; level = 0; finished = true; errorText = error
        cleanup(); publish()
    }

    private func fail(_ message: String) { cancelCapture(error: message) }

    private func cleanup() {
        if let directory = directory { try? FileManager.default.removeItem(at: directory) }
        directory = nil; fileURL = nil; startedAt = nil
    }

    func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        guard Thread.isMainThread else { DispatchQueue.main.async { [weak self] in self?.audioRecorderDidFinishRecording(recorder, successfully: flag) }; return }
        finalize(recorder, successful: flag)
    }

    func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
        guard Thread.isMainThread else { DispatchQueue.main.async { [weak self] in self?.audioRecorderEncodeErrorDidOccur(recorder, error: error) }; return }
        guard self.recorder === recorder else { return }
        fail("Ошибка микрофона. Запись не отправлена")
    }

    private func finalize(_ capture: AVAudioRecorder, successful: Bool) {
        guard recorder === capture else { return }
        elapsed = max(elapsed, capture.currentTime)
        if let startedAt = startedAt { elapsed = min(45, max(elapsed, Date().timeIntervalSince(startedAt))) }
        recorder = nil; recording = false; requesting = false; wantRecord = false; level = 0; finished = true
        meterTimer?.invalidate(); meterTimer = nil
        capture.delegate = nil
        guard successful, shouldSend else { fail("Запись не завершена. Сообщение не отправлено"); return }
        guard elapsed >= 0.15 else { cleanup(); errorText = nil; publish(); return }
        guard let url = fileURL, let endpoint = endpoint, let origin = origin else { fail("Запись недоступна"); return }
        do {
            let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard size > 44, size <= maxBytes else { fail("Недопустимая длина голосовой записи"); return }
            let data = try Data(contentsOf: url)
            guard data.count == size, data.starts(with: Data("RIFF".utf8)), data.count >= 12,
                  data.subdata(in: 8..<12) == Data("WAVE".utf8) else { fail("Не удалось завершить WAV-запись"); return }
            cleanup()
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
        } catch { fail("Не удалось прочитать голосовую запись") }
    }
}
