#!/usr/bin/env python3
"""Switch the existing station to WKWebView without resetting timer state; rollback on failure."""
import argparse
import datetime
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parent.parent
CFG = ROOT / 'cast-app/config.json'
APP = ROOT / 'LOST.app'
SERVICE = 'gui/{}/com.exrector.lost'.format(os.getuid())


def health(port):
    try:
        with urllib.request.urlopen('http://127.0.0.1:{}/__health'.format(port), timeout=2) as r:
            return json.load(r)
    except (OSError, ValueError):
        return None


def stop(port):
    if health(port):
        try:
            with urllib.request.urlopen('http://127.0.0.1:{}/__quit'.format(port), timeout=4) as r:
                r.read()
        except OSError:
            # A closed response can mean the core has already completed shutdown.
            if health(port):
                raise
        end = time.monotonic() + 15
        while health(port) and time.monotonic() < end:
            time.sleep(.3)
        if health(port):
            raise RuntimeError('Core did not stop; installation cancelled')


def launch():
    result = subprocess.run(['/bin/launchctl', 'kickstart', SERVICE], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if result.returncode:
        log = Path.home() / 'Library/Logs/LOST'
        log.mkdir(parents=True, exist_ok=True)
        with (log / 'portable.log').open('ab') as out:
            subprocess.Popen(['/bin/bash', str(ROOT / 'cast-app/start.command')], stdin=subprocess.DEVNULL,
                             stdout=out, stderr=out, start_new_session=True)


def write_config(cfg):
    temp = CFG.with_name('config.json.' + uuid.uuid4().hex + '.tmp')
    temp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + '\n')
    os.replace(temp, CFG)


def replace_app(bundle):
    staged = ROOT / ('.LOST-install-' + uuid.uuid4().hex + '.app')
    shutil.copytree(bundle, staged)
    try:
        # The core has stopped and its windows are closed before this step.
        if APP.exists():
            shutil.rmtree(APP)
        os.rename(staged, APP)
    finally:
        if staged.exists():
            shutil.rmtree(staged)


def restore(backup):
    cfg = json.loads((backup / 'config.json').read_text())
    stop(cfg.get('port', 8765))
    replace_app(backup / 'LOST.app')
    write_config(cfg)
    saved_state = backup / 'state-before-explicit-reset.json'
    if saved_state.exists():
        restore_state = ROOT / 'cast-app/.state.json'
        temp = restore_state.with_name('.state.restore.' + uuid.uuid4().hex + '.tmp')
        shutil.copy2(saved_state, temp); os.replace(temp, restore_state)
    launch()


def install(reset_live=False):
    cfg = json.loads(CFG.read_text())
    bundle = ROOT / 'native/dist/LOST.app'
    if not (bundle / 'Contents/MacOS/LOSTNative').is_file():
        raise RuntimeError('Build first: ./script/build_and_run.sh --build-only')
    if "cfg.renderer === 'native'" not in (ROOT / 'cast-app/start.js').read_text():
        raise RuntimeError('Core does not support native renderer')
    backup = ROOT / '.native-backups' / (datetime.datetime.now().strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:6])
    backup.mkdir(parents=True)
    shutil.copy2(CFG, backup / 'config.json')
    shutil.copytree(APP, backup / 'LOST.app')
    print('Backup:', backup, flush=True)
    port = cfg.get('port', 8765)
    try:
        stop(port)
        if reset_live:
            state_path = ROOT / 'cast-app/.state.json'
            saved = {}
            if state_path.exists():
                shutil.copy2(state_path, backup / 'state-before-explicit-reset.json')
                saved = json.loads(state_path.read_text())
            # This is an explicit one-off user reset, never a startup default.
            saved['mode'] = 'live'
            saved['live'] = {'left': 6480, 'paused': False}
            temp = state_path.with_name('.state.reset.' + uuid.uuid4().hex + '.tmp')
            temp.write_text(json.dumps(saved)); os.replace(temp, state_path)
        replace_app(bundle)
        write_config(dict(cfg, renderer='native'))
        launch()
        end = time.monotonic() + 45
        while time.monotonic() < end:
            state = health(port) or {}
            modules = state.get('components', {})
            expected = ['terminal'] + (['timer'] if cfg.get('output', 'chromecast') in ('local', 'both') else [])
            if modules.get('renderer', {}).get('name') == 'WKWebView' and all(modules.get(k, {}).get('status') == 'ready' for k in expected):
                print('WKWebView ready; new Live cycle 108:00' if reset_live else 'WKWebView ready; timer state preserved', flush=True)
                return
            time.sleep(1)
        raise RuntimeError('Native windows did not become ready within 45 seconds')
    except BaseException:
        print('Restoring previous app and renderer', flush=True)
        restore(backup)
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--restore', type=Path)
    parser.add_argument('--reset-live', action='store_true', help='Explicit one-off new 108-minute Live cycle; preserves Dev slot')
    args = parser.parse_args()
    if args.restore:
        restore(args.restore.resolve())
    else:
        install(reset_live=args.reset_live)
