#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${1:-run}"
TARGET_ARCH="${LOST_BUILD_ARCH:-$(uname -m)}"
BUNDLE="$ROOT/native/dist/LOST.app"
case "$MODE" in run|--debug|--logs|--telemetry|--verify|--build-only|--preview) ;; *) echo 'usage: build_and_run.sh [--preview|--build-only|--debug|--logs|--telemetry|--verify]' >&2; exit 2 ;; esac
mkdir -p "$BUNDLE/Contents/MacOS" "$ROOT/native/.module-cache"
xcrun swiftc -module-cache-path "$ROOT/native/.module-cache" -swift-version 5 -O -target "$TARGET_ARCH-apple-macosx12.0" -framework AppKit -framework WebKit -framework Carbon -framework AVFoundation "$ROOT/native/Sources/main.swift" -o "$BUNDLE/Contents/MacOS/LOSTNative"
if [ -f "$ROOT/native/Resources/LOST.icns" ]; then
 mkdir -p "$BUNDLE/Contents/Resources"; cp "$ROOT/native/Resources/LOST.icns" "$BUNDLE/Contents/Resources/LOST.icns"
fi
cat > "$BUNDLE/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>LOSTNative</string>
<key>CFBundleIdentifier</key><string>com.exrector.lost.native</string>
<key>CFBundleName</key><string>LOST</string>
<key>CFBundleDisplayName</key><string>LOST</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleIconFile</key><string>LOST.icns</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>12.0</string>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST
/usr/bin/codesign --force --sign - "$BUNDLE"
case "$MODE" in
 --build-only) echo "$BUNDLE" ;;
 --preview) node "$ROOT/script/preview.cjs" "$BUNDLE" "$ROOT" "${LOST_PREVIEW_DIR:-$ROOT/.preview}" ;;
 --debug) python3 "$ROOT/script/install_native.py"; lldb -n LOSTNative ;;
 --logs|--telemetry) python3 "$ROOT/script/install_native.py"; /usr/bin/log stream --info --style compact --predicate 'process == "LOSTNative"' ;;
 --verify) python3 "$ROOT/script/install_native.py"; pgrep -x LOSTNative >/dev/null ;;
 *) python3 "$ROOT/script/install_native.py" ;;
esac
