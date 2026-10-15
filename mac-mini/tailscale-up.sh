#!/bin/bash
# Mac mini — AK: вход tailscaled со всеми нужными функциями.
# Запуск владельцем:  ssh -t mac-mini-ak 'sudo bash ~/LOST/mac-mini/tailscale-up.sh'
#   --ssh                         Tailscale SSH (правила ssh в tailnet уже разрешают свои машины)
#   --advertise-routes            доступ к домашней сети 192.168.1.0/24 через Mac mini (маршрут одобряется в tailnet)
#   --operator                    пользователь управляет tailscale без sudo
#   --accept-dns=false            DNS на Mac mini ведёт AdGuard VPN
# Ключ без срока действия включается в tailnet (API: keyExpiryDisabled) после входа.
set -u
[ "$(id -u)" = 0 ] || { echo "Запускать через sudo"; exit 1; }
U=${SUDO_USER:-exrectormini}

echo "1. Пересылка пакетов для доступа к домашней сети (сейчас и после перезагрузки)"
sysctl -w net.inet.ip.forwarding=1
grep -q '^net.inet.ip.forwarding=1' /etc/sysctl.conf 2>/dev/null || echo 'net.inet.ip.forwarding=1' >> /etc/sysctl.conf

echo "2. Вход: откройте ссылку ниже и подтвердите"
/usr/local/bin/tailscale up --reset --hostname=mac-mini-ak --accept-dns=false --ssh \
    --advertise-routes=192.168.1.0/24 --operator="$U" --timeout=10m
echo "--- итог"
/usr/local/bin/tailscale status | head -5
/usr/local/bin/tailscale ip -4
echo ГОТОВО
