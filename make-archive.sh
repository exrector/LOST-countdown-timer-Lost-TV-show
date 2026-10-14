#!/bin/bash
# Собирает LOST-portable.zip — только то, что нужно для работы. Распаковать на другом Маке и запустить LOST.app.
cd "$(dirname "$0")"
OUT="LOST-portable.zip"; rm -f "$OUT"
STAGE=$(mktemp -d)/LOST; mkdir -p "$STAGE/cast-app/node_modules"
cp -R index.html console.html css js assets LOST.app "$STAGE/"
cd cast-app && cp server.js start.js cast.js bridge.js config.json package.json start.command README.md "$STAGE/cast-app/" && cd ..
cp -R cast-app/bin "$STAGE/cast-app/"; cp -R cast-app/node_modules/ws "$STAGE/cast-app/node_modules/"          # для локального режима нужен только ws
cp -R cast-app/node_modules/castv2 cast-app/node_modules/protobufjs cast-app/node_modules/long cast-app/node_modules/@protobufjs cast-app/node_modules/debug cast-app/node_modules/ms cast-app/node_modules/@types cast-app/node_modules/undici-types "$STAGE/cast-app/node_modules/" 2>/dev/null  # для режима Chromecast
find "$STAGE" -name ".DS_Store" -delete
chmod +x "$STAGE/cast-app/start.command"
(cd "$(dirname "$STAGE")" && zip -q -r -X "$OLDPWD/$OUT" LOST)
echo "готово: $OUT ($(du -h "$OUT" | cut -f1))"
