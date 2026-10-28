#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${1:-run}"
TARGET_ARCH="${LOST_BUILD_ARCH:-$(uname -m)}"
BUNDLE="$ROOT/native/dist/LOST.app"
case "$MODE" in run|--debug|--logs|--telemetry|--verify|--build-only|--preview) ;; *) echo 'usage: build_and_run.sh [--preview|--build-only|--debug|--logs|--telemetry|--verify]' >&2; exit 2 ;; esac
# Never merge a new build into an older bundle: stale AppleDouble files break
# the code-signing resource seal after transfer to the Intel station.
rm -rf "$BUNDLE"
mkdir -p "$BUNDLE/Contents/MacOS" "$ROOT/native/.module-cache"
# Swift cannot catch NSException; a one-function Objective-C shim does (see LOSTObjC.h).
OBJ="$(mktemp -d)"; trap 'rm -rf "$OBJ"' EXIT
RNN="$ROOT/native/vendor/rnnoise"
xcrun clang -c -fobjc-arc -O2 -target "$TARGET_ARCH-apple-macosx12.0" -I"$RNN/include" "$ROOT/native/Sources/LOSTObjC.m" -o "$OBJ/LOSTObjC.o"
# RNNoise voice denoiser, x86_64 only (see native/vendor/rnnoise/README.md).
for c in "$RNN"/src/*.c; do
 xcrun clang -c -O2 -target "$TARGET_ARCH-apple-macosx12.0" -I"$RNN/include" -I"$RNN/src" "$c" -o "$OBJ/rnnoise-$(basename "$c" .c).o"
done
xcrun swiftc -module-cache-path "$ROOT/native/.module-cache" -swift-version 5 -O -target "$TARGET_ARCH-apple-macosx12.0" -framework AppKit -framework WebKit -framework Carbon -framework AVFoundation -Xcc -I"$RNN/include" -import-objc-header "$ROOT/native/Sources/LOSTObjC.h" "$ROOT/native/Sources/main.swift" "$ROOT/native/Sources/StationMicrophone.swift" "$ROOT/native/Sources/VoiceDenoiser.swift" "$OBJ"/*.o -o "$BUNDLE/Contents/MacOS/LOSTNative"
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
<key>CFBundleVersion</key><string>2</string>
<key>CFBundleShortVersionString</key><string>1.1</string>
<key>LSMinimumSystemVersion</key><string>12.0</string>
<key>NSMicrophoneUsageDescription</key><string>LOST записывает голосовое сообщение для Muse только пока вы удерживаете RESET в режиме AI.</string>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST
# An ad-hoc signature's default designated requirement is the cdhash, which changes
# on every rebuild, and macOS then revokes the microphone grant. Pin it to the bundle
# identifier so a rebuilt LOST keeps its permission.
/usr/bin/codesign --force --sign - --identifier com.exrector.lost.native \
 --requirements '=designated => identifier "com.exrector.lost.native"' "$BUNDLE"
case "$MODE" in
 --build-only) echo "$BUNDLE" ;;
 --preview) node "$ROOT/script/preview.cjs" "$BUNDLE" "$ROOT" "${LOST_PREVIEW_DIR:-$ROOT/.preview}" ;;
 --debug) python3 "$ROOT/script/install_native.py"; lldb -n LOSTNative ;;
 --logs|--telemetry) python3 "$ROOT/script/install_native.py"; /usr/bin/log stream --info --style compact --predicate 'process == "LOSTNative"' ;;
 --verify) python3 "$ROOT/script/install_native.py"; pgrep -x LOSTNative >/dev/null ;;
 *) python3 "$ROOT/script/install_native.py" ;;
esac
