#!/bin/bash
# Mac mini — AK: заменить устаревшее приложение Tailscale (1.94, на каждом входе плодило новую машину в tailnet)
# на открытый tailscaled как системную службу. Бинарники собраны на MacBook:
#   GOOS=darwin GOARCH=amd64 go install tailscale.com/cmd/tailscale{,d}@v1.104.1  → кладутся в ~/tailscale-cli/
# Запуск владельцем:  ssh -t mac-mini-ak 'sudo bash ~/LOST/mac-mini/tailscale-cli-install.sh'
# Состояние узла хранится в одном файле (/Library/Tailscale) — при повторном входе машина та же.
set -u
[ "$(id -u)" = 0 ] || { echo "Запускать через sudo"; exit 1; }
U=${SUDO_USER:-exrectormini}; H=$(eval echo ~$U); SRC=$H/tailscale-cli
[ -x "$SRC/tailscaled" ] || { echo "Нет $SRC/tailscaled"; exit 1; }

echo "1. Закрываю приложение Tailscale и убираю его в Корзину"
sudo -u "$U" osascript -e 'quit app "Tailscale"' 2>/dev/null; sleep 3; pkill -x Tailscale 2>/dev/null
[ -d /Applications/Tailscale.app ] && mv /Applications/Tailscale.app "$H/.Trash/Tailscale.app-$(date +%Y%m%d)" && chown -R "$U" "$H/.Trash/Tailscale.app-$(date +%Y%m%d)"
# откат: вернуть приложение из Корзины в /Applications; sudo tailscaled uninstall-system-daemon

echo "2. Ставлю tailscale и tailscaled в /usr/local/bin и запускаю службу"
mkdir -p /usr/local/bin
install -m 755 -o root -g wheel "$SRC/tailscale" /usr/local/bin/
# tailscaled сам копирует себя в /usr/local/bin — запускать ТОЛЬКО из папки сборки:
# запуск из /usr/local/bin стирает собственный файл (копирование «на себя») и служба крутится вхолостую
"$SRC/tailscaled" install-system-daemon
sleep 4

echo "3. Вход в tailnet: откройте ссылку, которая появится ниже, на iPhone или MacBook и подтвердите"
# DNS Tailscale не трогаем: на Mac mini DNS ведёт AdGuard VPN — два DNS-менеджера мешали бы друг другу
/usr/local/bin/tailscale up --hostname=mac-mini-ak --accept-dns=false --timeout=10m
echo "--- итог"
/usr/local/bin/tailscale status | head -5
/usr/local/bin/tailscale ip -4
echo ГОТОВО
