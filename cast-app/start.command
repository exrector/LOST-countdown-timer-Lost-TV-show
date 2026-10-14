#!/bin/bash
# LOST — таймер на втором экране + терминал. Двойной клик или значок LOST.app.
cd "$(dirname "$0")"

# найти Node: PATH, nvm, Homebrew, /usr/local
find_node() {
  command -v node && return
  for n in "$HOME"/.nvm/versions/node/*/bin/node /opt/homebrew/bin/node /usr/local/bin/node; do [ -x "$n" ] && { echo "$n"; return; }; done
}
NODE=$(find_node | head -1)
if [ -z "$NODE" ]; then
  osascript -e 'display dialog "Для LOST нужен Node.js. Установите его с nodejs.org (LTS) и запустите снова." buttons {"OK"} with icon caution' >/dev/null 2>&1
  echo "Node.js не найден"; exit 1
fi
NPM="$(dirname "$NODE")/npm"
[ -d node_modules ] || "$NPM" install --silent
exec "$NODE" start.js
