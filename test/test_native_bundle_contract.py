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


if __name__ == "__main__":
    unittest.main()
