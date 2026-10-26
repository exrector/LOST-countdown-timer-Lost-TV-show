"""Private local chat projection for the unmodified Muse transport SDK.

No credentials or raw chat events are copied into diagnostics. The chat history
belongs to the explicit LOST side chat, not to the user's main Muse chat.
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import io
import struct
import wave
from collections import OrderedDict
import hashlib
import json
import os
from pathlib import Path
import re
import time
import uuid

MAX_MESSAGES = 24
MAX_TEXT = 16000
MAX_TOTAL = 64000
WRITE_DELAY = 0.15
SETTLE_SECONDS = 2.0
WAIT_SECONDS = 90.0
MAX_VOICE_BYTES = 2 * 1024 * 1024
MAX_VOICE_BASE64 = 4 * ((MAX_VOICE_BYTES + 2) // 3)


class ChatState:
    def __init__(self, root: Path, clock=time.monotonic):
        self.path = Path(root) / 'chat.json'
        self.clock = clock
        self.messages = []
        self.phase = 'idle'
        self.error = None
        self.available = False
        self._write_handle = None
        self._last_seq = 0
        self._seen_events = OrderedDict()
        self._roots = set()
        self._rejected = set()
        self._early = []
        self._awaiting_ack = False
        self._agent_busy = False
        self._deadline = None
        self._last_activity = None
        self._got_reply = False
        self._user_id = None
        self._turn_messages = set()
        self._user_roots = {}
        self._load()
        self.flush()

    @property
    def busy(self):
        return self.phase in ('sending', 'waiting', 'replying')

    def _load(self):
        try:
            if self.path.stat().st_size > 1024 * 1024:
                return
            data = json.loads(self.path.read_text(encoding='utf-8'))
            for message in data.get('messages', [])[-MAX_MESSAGES:]:
                if isinstance(message, dict) and message.get('role') in ('user', 'assistant') and isinstance(message.get('text'), str):
                    self.messages.append({'id': str(message.get('id') or uuid.uuid4().hex)[:128],
                                          'role': message['role'], 'text': message['text'][:MAX_TEXT]})
            if data.get('phase') in ('sending', 'waiting', 'replying'):
                self.phase, self.error = 'error', 'Предыдущий запрос прерван перезапуском'
        except (OSError, ValueError, TypeError, AttributeError):
            pass
        self._bound()

    def _bound(self):
        self.messages = self.messages[-MAX_MESSAGES:]
        while sum(len(m['text']) for m in self.messages) > MAX_TOTAL and len(self.messages) > 1:
            self.messages.pop(0)

    def snapshot(self):
        self._bound()
        return {'phase': self.phase, 'messages': self.messages, 'error': self.error, 'available': self.available}

    def changed(self):
        self._bound()
        if self._write_handle is None:
            try:
                self._write_handle = asyncio.get_running_loop().call_later(WRITE_DELAY, self.flush)
            except RuntimeError:
                self.flush()

    def flush(self):
        if self._write_handle is not None:
            self._write_handle.cancel()
            self._write_handle = None
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        tmp = self.path.with_name(self.path.name + '.' + str(os.getpid()) + '.tmp')
        try:
            fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, 'w', encoding='utf-8') as stream:
                json.dump(self.snapshot(), stream, ensure_ascii=False)
            os.replace(str(tmp), str(self.path))
        finally:
            try:
                tmp.unlink()
            except FileNotFoundError:
                pass

    def connected(self, value):
        self.available = bool(value)
        if not value and self.busy:
            self.fail('Соединение с Muse потеряно; ответ мог быть доставлен')
        self.changed()

    def new_subscription(self):
        self._last_seq = 0

    def begin(self, message):
        self.phase, self.error = 'sending', None
        self._roots, self._rejected, self._early = set(), set(), []
        self._turn_messages = set()
        self._awaiting_ack, self._agent_busy, self._got_reply = True, False, False
        self._deadline = self.clock() + WAIT_SECONDS
        self._last_activity = self.clock()
        self._user_id = 'local-' + uuid.uuid4().hex
        self.messages.append({'id': self._user_id, 'role': 'user', 'text': message, 'pending': True})
        self.changed()

    def accept(self, reply):
        ids = set()
        def collect(value, depth=0):
            if not isinstance(value, dict) or depth > 3:
                return
            for key in ('message_id', 'parent_message_id', 'user_message_id', 'note_id', 'id'):
                v = value.get(key)
                if isinstance(v, str) and v:
                    ids.add(v[:128])
            for key in ('response', 'payload', 'result'):
                collect(value.get(key), depth + 1)
        collect(reply)
        self._roots.update(ids)
        for ident in ids:
            self._user_roots[ident] = self._user_id
        if len(self._user_roots) > 128:
            self._user_roots = dict(list(self._user_roots.items())[-64:])
        self._awaiting_ack = False
        self.phase = 'waiting'
        self.error = None
        self._deadline = self.clock() + WAIT_SECONDS
        self._last_activity = self.clock()
        for m in self.messages:
            if m['id'] == self._user_id:
                m['pending'] = False
        early, self._early = self._early, []
        for event in early:
            self._apply_event(event)
        self.changed()

    def fail(self, error):
        self.phase, self.error = 'error', error
        self._awaiting_ack = False
        self._early = []
        self._deadline = None
        for m in self.messages:
            m.pop('pending', None)
        self.changed()

    def event(self, event):
        if not isinstance(event, dict) or event.get('type') != 'event':
            return
        seq = event.get('seq')
        if isinstance(seq, (int, float)) and not isinstance(seq, bool) and seq > 0:
            # Muse updates a voice-note row with its transcript using the
            # original sequence, potentially after newer assistant events.
            if seq <= self._last_seq and (event.get('event_name') or event.get('event')) != 'message.user':
                return
            self._last_seq = max(self._last_seq, seq)
        if isinstance(seq, (int, float)) and not isinstance(seq, bool) and seq > 0:
            # The server may replay earlier deltas after resubscription. Sequence
            # filtering is subscription-local; retain bounded fingerprints too.
            try:
                key = hashlib.sha256(json.dumps(event, sort_keys=True).encode()).digest()
            except (ValueError, TypeError):
                return
            if key in self._seen_events:
                return
            self._seen_events[key] = None
            if len(self._seen_events) > 2048:
                self._seen_events.popitem(last=False)
        if self._awaiting_ack:
            # Keep bounded correlation candidates; no raw events are persisted.
            if len(self._early) < 128:
                try:
                    if len(json.dumps(event)) <= MAX_TEXT * 2:
                        self._early.append(event)
                except (ValueError, TypeError):
                    pass
            return
        self._apply_event(event)

    def _apply_event(self, event):
        kind = event.get('event_name') or event.get('event')
        p = event.get('payload')
        if not isinstance(p, dict):
            return
        if kind == 'message.user':
            ident = p.get('message_id') or event.get('message_id') or p.get('id')
            local_id = self._user_roots.get(ident) if isinstance(ident, str) else None
            if local_id is None:
                return
            text = next((p[k] for k in ('display_text', 'content', 'text') if isinstance(p.get(k), str)), None)
            if text is None:
                return
            text = text.split('\n[file:', 1)[0].strip()
            if not text or text in ('[Voice note]', '[Голосовое сообщение]'):
                return
            text = ''.join(c for c in text if c in '\n\t' or ord(c) >= 32 and not 127 <= ord(c) <= 159)
            for message in self.messages:
                if message['id'] == local_id and message['role'] == 'user':
                    message['text'] = text[:MAX_TEXT]
                    message['pending'] = False
                    self.changed()
                    break
            return
        if kind in ('agent.status', 'task.status'):
            if not self.busy:
                return
            code, value = p.get('activity_code'), p.get('status')
            if isinstance(code, str):
                self._agent_busy = bool(code) and code not in ('online', 'idle')
            elif isinstance(value, str):
                self._agent_busy = bool(value) and value not in ('completed', 'failed')
            self._last_activity = self.clock()
            self.changed()
            return
        if kind not in ('delta.message_start', 'delta.text_append', 'delta.message_done', 'message.assistant'):
            return
        ident = p.get('message_id') or event.get('message_id') or p.get('id')
        if not isinstance(ident, str) or not ident or len(ident) > 128:
            return
        parent = p.get('reply_to_message_id') or p.get('parent_message_id')
        if not isinstance(parent, str):
            parent = None
        if ident in self._rejected:
            return
        if parent and self._roots and parent not in self._roots and parent not in self._turn_messages:
            if len(self._rejected) < 256:
                self._rejected.add(ident)
            return
        message = next((m for m in self.messages if m['id'] == ident and m['role'] == 'assistant'), None)
        # A repeated delta after resubscription must not append a completed reply.
        if message and not message.get('pending') and kind in ('delta.message_start', 'delta.text_append'):
            return
        if message is None:
            message = {'id': ident, 'role': 'assistant', 'text': '', 'pending': True}
            self.messages.append(message)
        self._turn_messages.add(ident)
        if not message.get('pending') and kind == 'message.assistant' and p.get('display_text_ready') is False:
            return
        final = kind == 'delta.message_done' or (kind == 'message.assistant' and p.get('display_text_ready') is not False)
        if kind == 'delta.text_append' and isinstance(p.get('text'), str):
            message['text'] = (message['text'] + p['text'])[:MAX_TEXT]
        elif kind in ('delta.message_done', 'message.assistant'):
            text = next((p[k] for k in ('display_text', 'content', 'text') if isinstance(p.get(k), str)), None)
            if text is not None:
                message['text'] = text[:MAX_TEXT]
        message['pending'] = not final
        if self.busy:
            self.phase = 'replying'
            self._got_reply = True
        self._last_activity = self.clock()
        self.changed()

    def tick(self):
        if not self.busy:
            return
        now = self.clock()
        if self._deadline is not None and now >= self._deadline:
            self.fail('Muse не завершил ответ за 90 секунд')
            return
        pending = any(m.get('pending') for m in self.messages if m['role'] == 'assistant' and m['id'] in self._turn_messages)
        if self._got_reply and not pending and not self._agent_busy and now - self._last_activity >= SETTLE_SECONDS:
            self.phase, self.error, self._deadline = 'idle', None, None
            self.changed()


def _voice_note(encoded):
    """Accept one bounded 16-kHz mono signed-16-bit PCM WAV, never persist it."""
    if not isinstance(encoded, str) or not encoded or len(encoded) > MAX_VOICE_BASE64:
        raise ValueError('invalid_audio')
    try:
        data = base64.b64decode(encoded.encode('ascii'), validate=True)
        if not data or len(data) > MAX_VOICE_BYTES:
            raise ValueError('invalid_audio')
        with wave.open(io.BytesIO(data), 'rb') as audio:
            frames = audio.getnframes()
            if (audio.getnchannels() != 1 or audio.getsampwidth() != 2
                    or audio.getframerate() != 16000 or audio.getcomptype() != 'NONE'
                    or frames <= 0 or frames * 2 > len(data)):
                raise ValueError('invalid_audio')
            if len(audio.readframes(frames)) != frames * 2:
                raise ValueError('invalid_audio')
        return data, frames / 16000.0
    except (ValueError, UnicodeError, binascii.Error, wave.Error, EOFError, struct.error):
        raise ValueError('invalid_audio') from None


def install(root: Path, session_id: str):
    """Install the side-chat projection before the SDK's cli.main()."""
    if not isinstance(session_id, str) or not re.fullmatch(r'[A-Za-z0-9-]{1,64}', session_id):
        raise ValueError('Invalid local side-chat session id')
    from musegadget import service
    service.MAX_LOCAL_REQUEST = 3 * 1024 * 1024
    state = ChatState(root)
    def diagnostic(stage, exc=None, reply=None):
        detail = {'stage': stage, 'time': int(time.time()), 'exception': type(exc).__name__ if exc else None}
        if exc is not None and isinstance(getattr(exc, 'status', None), int): detail['status'] = exc.status
        if isinstance(reply, dict):
            detail['status'] = reply.get('status')
            body = reply.get('response')
            detail['response_type'] = type(body).__name__
            if isinstance(body, dict): detail['response_keys'] = list(body)[:12]
        p = Path(root) / 'chat-diagnostics.json'
        try: value = json.loads(p.read_text())
        except (OSError, ValueError): value = {}
        value[stage] = detail
        fd = os.open(str(p), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w') as f: json.dump(value, f)

    BaseSession, BaseService = service.LinkSession, service.Service

    class ChatSession(BaseSession):
        async def _chat_observe(self):
            await self.registered.wait()
            delay = 2
            while self.registered.is_set():
                state.new_subscription()
                try:
                    async for event in self.subscribe_chat(session_id):
                        state.connected(True)
                        delay = 2
                        state.event(event)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    diagnostic('subscribe', exc=exc)
                # A new side chat may not exist until its first POST. A
                # subscription 404 must neither block that POST nor fail its
                # active turn; retry while the main session remains registered.
                state.available = False
                state.changed()
                await asyncio.sleep(delay)
                delay = min(delay * 2, 15)

        async def _chat_tick(self):
            while True:
                # subscribe_chat sets the event once HTTP 2xx is acknowledged,
                # even if no chat event has arrived yet.
                if self.chat_subscribed.is_set() and not state.available:
                    state.connected(True)
                state.tick()
                await asyncio.sleep(0.2)

        async def run(self, stop):
            tasks = [asyncio.create_task(self._chat_observe()), asyncio.create_task(self._chat_tick())]
            try:
                return await super().run(stop)
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                state.connected(False)
                state.flush()

    class ChatService(BaseService):
        async def _local_request(self, line):
            try:
                request = json.loads(line)
            except (ValueError, TypeError):
                return {'ok': False, 'error': 'invalid_request'}
            if not isinstance(request, dict) or request.get('action') not in ('chat_send', 'chat_voice'):
                return await super()._local_request(line)
            voice = request.get('action') == 'chat_voice'
            audio = None
            if voice:
                try:
                    audio, duration = _voice_note(request.get('audio_base64'))
                except ValueError:
                    return {'ok': False, 'error': 'invalid_audio'}
                message = '[Голосовое сообщение: {:.1f} с]'.format(duration)
            else:
                message = request.get('message')
                if not isinstance(message, str) or not message.strip() or len(message) > MAX_TEXT:
                    return {'ok': False, 'error': 'invalid_message'}
            session = self._current
            if session is None or not session.registered.is_set():
                return {'ok': False, 'error': 'not_connected'}
            if state.busy:
                return {'ok': False, 'error': 'busy'}
            state.begin(message.strip())
            try:
                if voice:
                    reply = await session.send_voice(audio, session_id, output_modality='text')
                else:
                    reply = await session.send_chat(message.strip(), session_id, output_modality='text')
                if not isinstance(reply, dict) or reply.get('ok') is not True or not session.registered.is_set():
                    diagnostic('send_rejected', reply=reply)
                    raise ValueError('Rejected')
                state.accept(reply)
                return {'ok': True}
            except asyncio.CancelledError:
                state.fail('Отправка прервана; доставка не подтверждена')
                raise
            except Exception as exc:
                if not isinstance(exc, ValueError): diagnostic('send', exc=exc)
                state.fail('Не удалось подтвердить отправку в Muse')
                return {'ok': False, 'error': 'send_failed'}

    service.LinkSession = ChatSession
    service.Service = ChatService
    return state
