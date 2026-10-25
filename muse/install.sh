#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
MUSE_HOME=${LOST_MUSE_HOME:-"$HOME/Library/Application Support/LOST Muse"}
PYTHON=${LOST_MUSE_PYTHON:-/usr/bin/python3}
umask 077
mkdir -p "$MUSE_HOME"
"$PYTHON" -m venv "$MUSE_HOME/venv"
if [ -n "${LOST_MUSE_WHEELS:-}" ]; then
    "$MUSE_HOME/venv/bin/python" -m pip install --disable-pip-version-check --no-index --find-links "$LOST_MUSE_WHEELS" --only-binary=:all: -r "$ROOT/requirements.txt"
else
    "$MUSE_HOME/venv/bin/python" -m pip install --disable-pip-version-check --only-binary=:all: -r "$ROOT/requirements.txt"
fi
"$MUSE_HOME/venv/bin/python" -c 'import cryptography,websockets; print("Muse dependencies:",cryptography.__version__,websockets.__version__)'
printf '%s\n' 'Dependencies installed. Import the paired state before enabling the module.'
