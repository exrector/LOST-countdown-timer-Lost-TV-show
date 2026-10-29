#!/bin/sh
# Run with sudo on the mini: removes the LOST boot guard LaunchDaemon.
launchctl bootout system/com.exrector.lost-boot-guard 2>/dev/null || true
rm -f /Library/LaunchDaemons/com.exrector.lost-boot-guard.plist /usr/local/libexec/lost-boot-guard.sh
launchctl print system/com.exrector.lost-boot-guard >/dev/null 2>&1 && echo "still loaded" || echo "boot guard removed"
