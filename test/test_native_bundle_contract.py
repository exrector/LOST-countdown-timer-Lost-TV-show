import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


class NativeBundleContractTests(unittest.TestCase):
    def test_first_managed_launch_requests_undecided_microphone_permission(self):
        source = (ROOT / "native/Sources/main.swift").read_text()
        self.assertIn("if !preview && AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined", source)
        self.assertIn('self?.microphone.command(["op": "authorize"])', source)

    def test_build_stages_a_clean_complete_monterey_bundle(self):
        source = (ROOT / "script/build_and_run.sh").read_text()
        self.assertIn('rm -rf "$BUNDLE"', source)
        self.assertIn('"$ROOT/native/Sources/StationMicrophone.swift"', source)
        self.assertIn("<key>LSMinimumSystemVersion</key><string>12.0</string>", source)
        self.assertIn("<key>NSMicrophoneUsageDescription</key>", source)
        self.assertIn("<key>CFBundleShortVersionString</key><string>1.1</string>", source)

    def test_microphone_hotplug_uses_notification_names_available_to_monterey_swift(self):
        source = (ROOT / "native/Sources/StationMicrophone.swift").read_text()
        self.assertIn('Notification.Name("AVCaptureDeviceWasConnectedNotification")', source)
        self.assertIn('Notification.Name("AVCaptureDeviceWasDisconnectedNotification")', source)
        self.assertNotIn("AVCaptureDevice.wasConnectedNotification", source)
        self.assertNotIn("AVCaptureDevice.wasDisconnectedNotification", source)

    def test_audio_graph_rebuild_cannot_abort_the_station(self):
        main = (ROOT / "native/Sources/main.swift").read_text()
        build = (ROOT / "script/build_and_run.sh").read_text()
        self.assertIn("LOSTCatchException({ node.play(at: startTime) })", main)
        self.assertIn('-import-objc-header "$ROOT/native/Sources/LOSTObjC.h"', build)
        self.assertIn('"$OBJ/LOSTObjC.o"', build)

    def test_rebuild_keeps_microphone_grant_with_identifier_requirement(self):
        build = (ROOT / "script/build_and_run.sh").read_text()
        self.assertIn("""--requirements '=designated => identifier "com.exrector.lost.native"'""", build)

    def test_voice_uses_processed_microphone_only_while_processor_is_fresh(self):
        source = (ROOT / "native/Sources/StationMicrophone.swift").read_text()
        self.assertIn('"Apple Voice Processed Mic"', source)
        self.assertIn("Library/Logs/AppleVoiceProcessor/status.json", source)
        self.assertIn('status["state"] as? String == "recording"', source)
        self.assertIn("timeIntervalSince(updated) < 15", source)
        self.assertIn("return AVCaptureDevice.default(for: .audio)", source)
        self.assertNotIn("AVAudioRecorder", source)

    def test_keyboard_layout_indicator_is_read_only_and_uses_macos_source(self):
        source = (ROOT / "native/Sources/main.swift").read_text()
        console = (ROOT / "console.html").read_text()
        client = (ROOT / "js/input-source.js").read_text()
        self.assertIn("TISCopyCurrentKeyboardLayoutInputSource", source)
        self.assertIn("lost-input-source", source)
        self.assertNotIn("TISSelectInputSource", source)
        self.assertIn('src="js/input-source.js"', console)
        self.assertIn("LANG: ", client)


if __name__ == "__main__":
    unittest.main()
