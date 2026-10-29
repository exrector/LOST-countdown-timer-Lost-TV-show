#!/bin/sh
# Run with sudo on the mini: installs the boot guard and ends the current hung progress app.
set -e
D=$(dirname "$0")
mkdir -p /usr/local/libexec
install -o root -g wheel -m 755 "$D/lost-boot-guard.sh" /usr/local/libexec/lost-boot-guard.sh
install -o root -g wheel -m 644 "$D/com.exrector.lost-boot-guard.plist" /Library/LaunchDaemons/com.exrector.lost-boot-guard.plist
plutil -lint /Library/LaunchDaemons/com.exrector.lost-boot-guard.plist
launchctl bootout system/com.exrector.lost-boot-guard 2>/dev/null || true
pkill -f "Installer Progress.app/Contents/MacOS/Installer Progress" && echo "hung Installer Progress ended" || echo "Installer Progress not running"
launchctl bootstrap system /Library/LaunchDaemons/com.exrector.lost-boot-guard.plist
echo "boot guard installed"
