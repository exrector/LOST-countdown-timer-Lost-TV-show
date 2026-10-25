#!/bin/bash
# Единая точка запуска: установленная служба либо переносимый foreground-процесс.
cd "$(dirname "$0")" || exit 1
SERVICE="gui/$(id -u)/com.exrector.lost"
if /bin/launchctl print "$SERVICE" >/dev/null 2>&1; then
    exec /bin/launchctl kickstart "$SERVICE"
fi
find_node() {
  for n in "$HOME"/.local/node/bin/node /opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.nvm/versions/node/*/bin/node; do
    [ -x "$n" ] && { echo "$n"; return; }
  done
  command -v node
}
NODE=$(find_node | head -1)
if [ -z "$NODE" ]; then echo 'LOST: Node.js не найден'; exit 1; fi
if [ ! -d node_modules/ws ]; then echo 'LOST: отсутствуют зависимости cast-app/node_modules. Выполните npm ci при установке.'; exit 1; fi
exec "$NODE" start.js
