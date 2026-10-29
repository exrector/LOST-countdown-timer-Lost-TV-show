#!/bin/sh
# LOST station (Mac mini AK, macOS 12.7.6), root LaunchDaemon, once per boot, before the login.
#
# 2026-10-28 a failed wake left /var/db/PanicReporter/current.panic (a link to its
# "Sleep Wake Failure" report) that the system never cleared. While it exists, every login -
# even after a clean menu restart - counts as "after a panic": loginwindow shows "You shut down
# your computer because of a problem", and its boot progress app (Installer Progress) hangs
# frontmost so the station's keyboard input goes nowhere. Owner's decision 2026-10-29: clear the
# folder on every boot. The reports themselves stay in /Library/Logs/DiagnosticReports.
for f in /var/db/PanicReporter/*; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    rm -f "$f" && logger -t lost-boot-guard "cleared $f"
done
exit 0
