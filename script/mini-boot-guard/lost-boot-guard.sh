#!/bin/sh
# LOST station (Mac mini AK, macOS 12.7.6), root LaunchDaemon, once per boot.
#
# loginwindow keeps a "last panic" stamp (lastLoginPanic in /Library/Preferences/com.apple.loginwindow).
# When it is recent, every login - even after a clean menu restart - counts as a "second panic": it shows
# "You shut down your computer because of a problem", writes the stamp again and tears the boot progress UI
# down without finishing its "loginwindow Boot" phase. /System/Library/CoreServices/Installer Progress.app
# then never quits and keeps the frontmost slot, so the station's keyboard input goes nowhere. One real
# unclean shutdown starts this loop and it then sustains itself.
#
# 1. Before the login: drop the stamp, so a clean restart is not a "second panic".
# 2. After the login: end Installer Progress at once if it is still there.
P="Installer Progress.app/Contents/MacOS/Installer Progress"
if defaults read /Library/Preferences/com.apple.loginwindow lastLoginPanic >/dev/null 2>&1; then
    defaults delete /Library/Preferences/com.apple.loginwindow lastLoginPanic
    logger -t lost-boot-guard "removed stale lastLoginPanic before login"
fi
i=0
while [ "$i" -lt 240 ]; do
    u=$(stat -f %Su /dev/console 2>/dev/null)
    [ -n "$u" ] && [ "$u" != root ] && break
    sleep 1; i=$((i+1))
done
# The progress app may still be on its way out for a moment after a normal login.
sleep 3
if pgrep -f "$P" >/dev/null; then
    pkill -f "$P"
    logger -t lost-boot-guard "Installer Progress still running after login; ended it"
fi
exit 0
