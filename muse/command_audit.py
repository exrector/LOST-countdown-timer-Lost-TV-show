"""Local-only, append-only command events. Never retain params or payload text."""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
from pathlib import Path
import threading
import time
import uuid

METHODS = frozenset(('device.health', 'system.run', 'file.read', 'file.write'))
_clock_lock = threading.Lock()
_last_us = 0


def timeline_now():
    """Shared creation order for chat rows and audit events, in epoch ms."""
    global _last_us
    with _clock_lock:
        _last_us = max(time.time_ns() // 1000, _last_us + 1)
        return _last_us / 1000


class CommandAudit:
    def __init__(self, path: Path):
        self.path = path
        self._warning_reported = False

    def emit(self, method, ref, stage, **fields):
        row = {'id': uuid.uuid4().hex, 'createdAt': timeline_now(),
               'method': method, 'ref': ref, 'stage': stage}
        if isinstance(fields.get('ok'), bool):
            row['ok'] = fields['ok']
        for key in ('durationMs', 'exitCode'):
            value = fields.get(key)
            if isinstance(value, int) and not isinstance(value, bool):
                if key == 'durationMs' and 0 <= value <= 86400000 or key == 'exitCode' and -255 <= value <= 255:
                    row[key] = value
        if isinstance(fields.get('timedOut'), bool):
            row['timedOut'] = fields['timedOut']
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            fd = os.open(str(self.path), os.O_WRONLY | os.O_CREAT | os.O_APPEND | getattr(os, 'O_NOFOLLOW', 0), 0o600)
            try:
                os.fchmod(fd, 0o600)
                os.write(fd, (json.dumps(row, separators=(',', ':')) + '\n').encode())
            finally:
                os.close(fd)
        except OSError:
            # A UI journal failure must not prevent a device command.
            if not self._warning_reported:
                logging.getLogger(__name__).warning('local command journal unavailable')
                self._warning_reported = True


async def audited_invoke(session, message, audit, session_key):
    """Same executor/semaphore/result contract as SDK _invoke, with local stages."""
    invoke_id, method = message.get('id'), message.get('command')
    if not invoke_id or method not in METHODS:
        return False
    ref = hashlib.sha256((session_key + ':' + str(invoke_id)).encode()).hexdigest()[:16]
    audit.emit(method, ref, 'received')
    params = message.get('params') if isinstance(message.get('params'), dict) else {}
    timeout_ms = message.get('timeout_ms') or None
    started = time.monotonic()
    phase = 'execute'
    try:
        async with session._invokes:
            started = time.monotonic()
            result = await asyncio.get_running_loop().run_in_executor(
                None, session._run_command, method, params, timeout_ms)
            duration = int((time.monotonic() - started) * 1000)
            payload = result.get('payload')
            payload = payload if isinstance(payload, dict) else {}
            audit.emit(method, ref, 'completed', ok=result.get('ok') is True,
                       durationMs=duration, exitCode=payload.get('exit_code'),
                       timedOut=payload.get('timed_out'))
        phase = 'send'
        await session.send({'method': 'link.result', 'id': invoke_id, **result})
        audit.emit(method, ref, 'sent')
    except asyncio.CancelledError:
        audit.emit(method, ref, 'cancelled', durationMs=int((time.monotonic() - started) * 1000))
        raise
    except Exception:
        audit.emit(method, ref, 'send_failed' if phase == 'send' else 'failed',
                   durationMs=int((time.monotonic() - started) * 1000))
        raise
    return True
