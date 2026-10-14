#!/bin/bash
# Двойной клик — запуск LOST (таймер на Chromecast + терминал на этом компьютере)
cd "$(dirname "$0")"
[ -d node_modules ] || npm install --silent
exec node start.js
