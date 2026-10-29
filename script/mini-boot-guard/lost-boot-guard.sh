#!/bin/sh
# LOST station (Mac mini AK, macOS 12.7.6), root LaunchDaemon, once per boot.
# Any shutdown without a clean logout (power button, power loss) leaves loginwindow's
# "previous startup was a panic" state. The next login then shows "You shut down your
# computer because of a problem" and tears the boot progress UI down without finishing its
# "loginwindow Boot" phase: /System/Library/CoreServices/Installer Progress.app never quits
# ("Unable to quit because there are still phases") and keeps the frontmost slot, so the
# station's keyboard input goes nowhere. Wait for the console user, give the progress app
# 30 s to quit by itself, then end it.
P="Installer Progress.app/Contents/MacOS/Installer Progress"
i=0
while [ "$i" -lt 120 ]; do
    u=$(stat -f %Su /dev/console 2>/dev/null)
    [ -n "$u" ] && [ "$u" != root ] && break
    sleep 5; i=$((i+1))
done
sleep 30
if pgrep -f "$P" >/dev/null; then
    logger -t lost-boot-guard "Installer Progress still running 30 s after login; ending it"
    pkill -f "$P"
else
    logger -t lost-boot-guard "Installer Progress quit by itself"
fi
exit 0
