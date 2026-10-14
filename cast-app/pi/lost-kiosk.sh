#!/bin/bash
# LOST: киоск таймера на панели Waveshare 6.25" (720x1560, физически повёрнута): cage + chromium.
# Адрес страницы берётся из /etc/lost-kiosk.env (LOST_URL), по умолчанию — сервер на Маке.
[ -f /etc/lost-kiosk.env ] && . /etc/lost-kiosk.env
URL="${LOST_URL:-http://192.168.1.98:8765/index.html}"
ROTATE="${LOST_ROTATE:--r}"   # cage: -r = повернуть на 90° по часовой; пусто = без поворота; "-r -r -r" = 270°
# ждём, пока сервер таймера на Маке ответит
until curl -fsS -m 3 -o /dev/null "$URL"; do sleep 3; done
exec cage $ROTATE -- chromium --kiosk --noerrdialogs --disable-infobars --no-first-run --disable-translate \
  --autoplay-policy=no-user-gesture-required --ozone-platform=wayland \
  --user-data-dir=/tmp/lost-chromium --disk-cache-size=1 --check-for-update-interval=31536000 "$URL"
