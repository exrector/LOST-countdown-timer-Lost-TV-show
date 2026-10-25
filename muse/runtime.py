"""LOST host for the preserved Muse SDK; macOS 12 / Python 3.9+."""
from __future__ import annotations
import fcntl
import json
import logging
import re
import os
from pathlib import Path
import sys
import signal
import threading
import time
import uuid

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE / 'vendor'))
ROOT = Path(os.environ.get('LOST_MUSE_HOME', str(Path.home() / 'Library/Application Support/LOST Muse')))
STATE = ROOT / 'state'
STATUS = ROOT / 'status.json'
_status_lock = threading.Lock()

def status(value, error=None):
    with _status_lock:
        data = {'status': value, 'error': error, 'pid': os.getpid(), 'updatedAt': int(time.time() * 1000)}
        tmp = STATUS.with_suffix('.tmp')
        fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w') as f:
            json.dump(data, f)
        os.replace(str(tmp), str(STATUS))

class Health(logging.Handler):
    def emit(self, record):
        message = record.getMessage()
        if 'registered with the Muse' in message:
            status('ready')
        elif 'session ended:' in message or 'reconnecting in' in message:
            status('reconnecting')
        elif 'connecting to' in message:
            status('connecting')
        elif 'VM fetch failed:' in message or 'session failed:' in message or 'token refresh failed:' in message:
            status('unavailable', 'Нет соединения с Muse; проверьте VPN и сеть')

def main():
    os.umask(0o077)
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = (ROOT / 'runtime.lock').open('a')
    for attempt in range(5):
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if attempt == 4:
                print('Muse runtime already running', file=sys.stderr)
                return 2
            time.sleep(1)
    for name in ('identity.json', 'pairing.json', 'sdk_token'):
        p = STATE / name
        if not p.is_file() or not p.stat().st_size:
            status('error', 'Отсутствует сохранённая пара; новая идентичность не создавалась')
            return 3
        if p.stat().st_mode & 0o077:
            status('error', 'Небезопасные права файла пары')
            return 3
    try:
        pairing = json.loads((STATE / 'pairing.json').read_text())
        ident = json.loads((STATE / 'identity.json').read_text())
    except (ValueError, OSError):
        status('error', 'Не удалось прочитать сохранённую пару; файлы сохранены')
        return 3
    if not isinstance(pairing, dict) or not pairing.get('access_token') or not pairing.get('refresh_token'):
        status('error', 'Файл пары не содержит токенов')
        return 3
    os.environ['MUSEGADGET_STATE_DIR'] = str(STATE)
    os.environ['MUSEGADGET_SOCKET'] = str(ROOT / 'muse.sock')
    mac = ident.get('mac') if isinstance(ident, dict) else None
    if not isinstance(mac, str) or not re.fullmatch(r'[0-9a-f]{2}(:[0-9a-f]{2}){5}', mac):
        status('error', 'Повреждена сохранённая идентичность; новая не создавалась')
        return 3
    from musegadget import cli, config, identity
    fixed_identity = identity.Identity(mac)
    identity.load_or_create = lambda *args, **kwargs: fixed_identity
    try:
        if not config.sdk_token():
            raise ValueError('Missing SDK token')
    except ValueError:
        status('error', 'Некорректный SDK-токен; запросы не отправлялись')
        return 3
    def preserve_pairing(name, directory=None):
        status('revoked', 'Muse отозвал пару; файлы сохранены, автоматическое перепаривание отключено')
        raise RuntimeError('Pairing revoked; preserved for manual recovery')
    config.delete_json = preserve_pairing
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(name)s: %(message)s')
    logging.getLogger().addHandler(Health())
    owner = int(os.environ.get('LOST_MUSE_OWNER_PID', os.getppid()))
    def watch_owner():
        while True:
            time.sleep(1)
            if os.getppid() != owner:
                os.kill(os.getpid(), signal.SIGTERM)
                return
    threading.Thread(target=watch_owner, daemon=True).start()
    from chat_adapter import install
    install(ROOT, str(uuid.uuid5(uuid.NAMESPACE_URL, 'lost-terminal-' + fixed_identity.suffix)))
    status('connecting')
    sys.argv = ['musegadget', 'run']
    try:
        return cli.main() or 0
    except Exception:
        # No exception values: upstream errors can contain credentials/URLs.
        if not STATUS.exists() or json.loads(STATUS.read_text()).get('status') != 'revoked':
            status('error', 'Ошибка runtime Muse; пара сохранена')
        raise
    finally:
        # Keep revoked/error visible; process ownership is checked by LOST.
        lock.close()

if __name__ == '__main__':
    sys.exit(main())
