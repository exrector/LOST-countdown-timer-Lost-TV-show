#!/bin/bash
# Mac mini — AK: экономный режим под LOST (только то, что требует sudo).
# Запуск владельцем:  ssh -t mac-mini-ak 'sudo bash ~/LOST/mac-mini/optimize-sudo.sh'
# Без sudo уже сделано (см. PORTING.md): службы GoogleUpdater сняты, автозапуск LOST через LaunchAgent.
# Откат — в комментариях у каждого шага.
set -u
[ "$(id -u)" = 0 ] || { echo "Запускать через sudo"; exit 1; }

echo "1. Spotlight: выключить индексацию всех дисков"        # откат: mdutil -a -i on
mdutil -a -i off >/dev/null && mdutil -s / | tail -1

echo "2. Обновления macOS и App Store: не проверять и не ставить сами"   # откат: те же ключи = true, softwareupdate --schedule on
SU=/Library/Preferences/com.apple.SoftwareUpdate
for k in AutomaticCheckEnabled AutomaticDownload AutomaticallyInstallMacOSUpdates CriticalUpdateInstall ConfigDataInstall; do
    defaults write $SU $k -bool false
done
defaults write /Library/Preferences/com.apple.commerce AutoUpdate -bool false
softwareupdate --schedule off

echo "3. Power Nap: выключить"                                 # откат: pmset -a powernap 1
pmset -a powernap 0

echo "--- итог"
mdutil -s / | tail -1
defaults read $SU | grep -E "Automatic|Critical|ConfigData"
softwareupdate --schedule
pmset -g | grep powernap
echo ГОТОВО
