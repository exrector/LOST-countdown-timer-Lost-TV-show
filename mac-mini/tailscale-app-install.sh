#!/bin/bash
# Mac mini — AK: официальное приложение Tailscale вместо открытого tailscaled, плюс удаление AdGuard VPN.
# Открытый tailscaled на macOS не может пустить трафик через exit-ноду: маршрут 0.0.0.0/0 в utun не встаёт,
# пока есть маршрут через Wi-Fi, а при выключении exit-ноды он удаляет маршрут Wi-Fi.
# 1.102.4 — последняя версия для macOS 12 (LSMinimumSystemVersion 12.4); с 1.104.1 нужна macOS 13.5.
# Пакет кладётся заранее в ~/tailscale-app/ (скачан с pkgs.tailscale.com, подпись Apple проверяется ниже).
# Запуск владельцем:  ssh -t mac-mini-ak 'sudo bash ~/LOST/mac-mini/tailscale-app-install.sh'
# Откат: удалить /Applications/Tailscale.app, вернуть /Library/Tailscale из .bak и запустить tailscale-cli-install.sh.
set -u
[ "$(id -u)" = 0 ] || { echo "Запускать через sudo"; exit 1; }
U=${SUDO_USER:-exrectormini}; H=$(eval echo ~$U)
PKG=$H/tailscale-app/Tailscale-1.102.4-macos.pkg
[ -f "$PKG" ] || { echo "Нет $PKG"; exit 1; }
pkgutil --check-signature "$PKG" | grep -q "Notarization: trusted" || { echo "Подпись пакета не подтверждена"; exit 1; }

echo "1. Удаляю AdGuard VPN"
sudo -u "$U" osascript -e 'quit app "AdGuard VPN"' 2>/dev/null; sleep 2; pkill -x "AdGuard VPN" 2>/dev/null
launchctl bootout system/com.adguard.mac.vpn.vpn_helper 2>/dev/null
rm -f /Library/LaunchDaemons/com.adguard.mac.vpn.vpn_helper.plist
rm -rf "/Applications/AdGuard VPN.app" "/Library/Application Support/AdGuard Software"

echo "2. Останавливаю открытый tailscaled (состояние сохраняется в /Library/Tailscale.bak-*)"
[ -x /usr/local/bin/tailscaled ] && /usr/local/bin/tailscaled uninstall-system-daemon
rm -f /usr/local/bin/tailscaled /usr/local/bin/tailscale
[ -d /Library/Tailscale ] && mv /Library/Tailscale "/Library/Tailscale.bak-$(date +%Y%m%d-%H%M)"

echo "3. Ставлю Tailscale 1.102.4"
installer -pkg "$PKG" -target / || { echo "Установка не удалась"; exit 1; }
# CLI приложения — та же команда tailscale, что и раньше
ln -sf /Applications/Tailscale.app/Contents/MacOS/Tailscale /usr/local/bin/tailscale

echo "4. Запускаю приложение"
sudo -u "$U" open -a /Applications/Tailscale.app
echo
echo "Дальше на экране Mac mini:"
echo " - разрешить системное расширение Tailscale (Системные настройки → Защита и безопасность → Разрешить)"
echo " - разрешить добавление конфигурации VPN"
echo " - войти в Tailscale (Log in) под [Apple ID владельца]"
echo ГОТОВО
