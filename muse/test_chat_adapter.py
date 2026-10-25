"""Offline fixtures only: no SDK network, credentials or personal state."""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

_spec = importlib.util.spec_from_file_location('chat_adapter', Path(__file__).with_name('chat_adapter.py'))
chat = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(chat)


def event(kind, seq, ident='reply', parent=None, **fields):
    payload = dict(message_id=ident, **fields)
    if parent is not None:
        payload['reply_to_message_id'] = parent
    return {'type': 'event', 'seq': seq, 'event': kind, 'payload': payload}


class StateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.now = 10
        self.state = chat.ChatState(Path(self.tmp.name), clock=lambda: self.now)

    def begin(self):
        self.state.begin('question')
        self.state.accept({'ok': True, 'response': {'payload': {'message_id': 'note'}}})

    def test_deltas_final_dedup_and_settle(self):
        self.begin()
        self.state.event(event('delta.message_start', 1, parent='note'))
        self.state.event(event('delta.text_append', 2, text='Hello'))
        self.state.event(event('delta.text_append', 2, text='Hello'))
        self.state.event(event('delta.message_done', 3))
        self.assertEqual(self.state.messages[-1]['text'], 'Hello')
        self.state.tick()
        self.assertEqual(self.state.phase, 'replying')
        self.state.event(event('message.assistant', 4, display_text='Hello'))
        self.assertEqual(len(self.state.messages), 2)
        self.now += 2.1
        self.state.tick()
        self.assertEqual(self.state.phase, 'idle')

    def test_explicit_unready_full_not_done_and_wrong_parent_ignored(self):
        self.begin()
        self.state.event(event('delta.message_start', 1, ident='foreign', parent='elsewhere'))
        self.state.event(event('delta.text_append', 2, ident='foreign', text='wrong'))
        self.assertEqual(len(self.state.messages), 1)
        self.state.event(event('message.assistant', 3, parent='note', display_text='draft', display_text_ready=False))
        self.now += 3
        self.state.tick()
        self.assertTrue(self.state.busy)
        self.state.event(event('delta.message_done', 4, display_text='final', display_text_ready=False))
        self.now += 2.1
        self.state.tick()
        self.assertEqual(self.state.phase, 'idle')
        self.assertEqual(self.state.messages[-1]['text'], 'final')

    def test_early_events_correlated_after_ack_and_replay_skipped(self):
        self.state.begin('question')
        first = event('delta.text_append', 1, parent='note', text='piece')
        self.state.event(first)
        self.state.event(event('message.assistant', 2, ident='wrong', parent='other', content='bad'))
        self.assertEqual(len(self.state.messages), 1)
        self.state.accept({'ok': True, 'response': {'message_id': 'note'}})
        self.assertEqual(self.state.messages[-1]['text'], 'piece')
        self.state.new_subscription()
        self.state.event(first)
        self.assertEqual(self.state.messages[-1]['text'], 'piece')

    def test_busy_and_timeout_and_restart_bounds(self):
        self.begin()
        self.state.event(event('message.assistant', 1, display_text='finished'))
        self.state.event({'type': 'event', 'seq': 2, 'event_name': 'agent.status', 'payload': {'activity_code': 'working'}})
        self.now += 3
        self.state.tick()
        self.assertTrue(self.state.busy)
        self.now += 90
        self.state.tick()
        self.assertEqual(self.state.phase, 'error')
        self.state.messages = [{'id': str(i), 'role': 'assistant', 'text': 'x' * 16000} for i in range(30)]
        self.state.flush()
        fresh = chat.ChatState(Path(self.tmp.name))
        self.assertLessEqual(len(fresh.messages), 24)
        self.assertLessEqual(sum(len(m['text']) for m in fresh.messages), 64000)
        self.assertEqual(os.stat(fresh.path).st_mode & 0o777, 0o600)
        self.assertFalse(fresh.available)


class LocalRequestTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        class BaseSession:
            pass
        class BaseService:
            async def _local_request(self, line):
                return {'fallback': True}
        self.module = types.SimpleNamespace(Service=BaseService, LinkSession=BaseSession)
        fake = types.ModuleType('musegadget')
        fake.service = self.module
        with patch.dict(sys.modules, {'musegadget': fake}):
            self.state = chat.install(Path(self.tmp.name), 'lost-terminal-test')
        self.service = self.module.Service()
        self.service._current = None

    async def asyncTearDown(self):
        self.state.flush()

    async def test_send_accepts_only_active_and_not_busy(self):
        request = json.dumps({'action': 'chat_send', 'message': 'test'}).encode()
        self.assertEqual(await self.service._local_request(request), {'ok': False, 'error': 'not_connected'})
        registered, subscribed = asyncio.Event(), asyncio.Event()
        registered.set()
        subscribed.set()
        calls = []
        async def send(message, session_id, **kwargs):
            calls.append((message, session_id, kwargs))
            await asyncio.sleep(0)
            return {'ok': True, 'response': {'payload': {'message_id': 'note'}}}
        self.service._current = types.SimpleNamespace(registered=registered, chat_subscribed=subscribed, send_chat=send)
        self.state.connected(True)
        first = asyncio.create_task(self.service._local_request(request))
        await asyncio.sleep(0)
        self.assertEqual(await self.service._local_request(request), {'ok': False, 'error': 'busy'})
        self.assertEqual(await first, {'ok': True})
        self.assertEqual(calls, [('test', 'lost-terminal-test', {'output_modality': 'text'})])
        self.assertEqual(self.state.phase, 'waiting')
        self.assertEqual(await self.service._local_request(b'{"message":"legacy"}'), {'fallback': True})
        self.assertNotIn('access_token', json.dumps(self.state.snapshot()))

    async def test_first_send_allowed_before_sidechat_subscription_exists(self):
        registered = asyncio.Event()
        registered.set()
        subscribed = asyncio.Event()
        calls = []
        async def send(message, session_id, **kwargs):
            calls.append((message, session_id))
            return {'ok': True, 'response': {'message_id': 'note'}}
        self.service._current = types.SimpleNamespace(registered=registered, chat_subscribed=subscribed, send_chat=send)
        self.assertFalse(self.state.available)
        result = await self.service._local_request(b'{"action":"chat_send","message":"first turn"}')
        self.assertEqual(result, {'ok': True})
        self.assertEqual(calls, [('first turn', 'lost-terminal-test')])
        self.assertEqual(self.state.phase, 'waiting')
        self.assertIsNone(self.state.error)
        self.state.event(event('message.assistant', 1, parent='note', display_text='caught up'))
        self.assertEqual(self.state.messages[-1]['text'], 'caught up')

    async def test_rejected_send_sanitized(self):
        registered = asyncio.Event()
        registered.set()
        async def bad(*args, **kwargs):
            raise ValueError('SECRET must not appear')
        self.service._current = types.SimpleNamespace(registered=registered, chat_subscribed=registered, send_chat=bad)
        self.state.connected(True)
        result = await self.service._local_request(b'{"action":"chat_send","message":"test"}')
        self.assertEqual(result, {'ok': False, 'error': 'send_failed'})
        self.assertNotIn('SECRET', json.dumps(self.state.snapshot()))
        self.assertEqual(self.state.phase, 'error')


class SubscriptionTests(unittest.IsolatedAsyncioTestCase):
    async def test_missing_sidechat_subscription_retries_without_failing_first_send(self):
        with tempfile.TemporaryDirectory() as root:
            class BaseSession:
                def __init__(self):
                    self.registered = asyncio.Event()
                    self.chat_subscribed = asyncio.Event()
                    self.created = False
                    self.attempts = 0
                    self.got_reply = asyncio.Event()
                async def run(self, stop):
                    self.registered.set()
                    await stop.wait()
                    self.registered.clear()
                    self.chat_subscribed.clear()
                    return 'stopped'
                async def subscribe_chat(self, session):
                    self.attempts += 1
                    if not self.created:
                        raise FileNotFoundError('side chat does not exist yet')
                    self.chat_subscribed.set()
                    try:
                        self.got_reply.set()
                        yield event('message.assistant', 1, parent='note', display_text='reply after first send')
                        await asyncio.Future()
                    finally:
                        self.chat_subscribed.clear()
                async def send_chat(self, message, session_id, **kwargs):
                    self.created = True
                    return {'ok': True, 'response': {'message_id': 'note'}}
            class BaseService:
                pass
            module = types.SimpleNamespace(Service=BaseService, LinkSession=BaseSession)
            fake = types.ModuleType('musegadget')
            fake.service = module
            with patch.dict(sys.modules, {'musegadget': fake}):
                state = chat.install(Path(root), 'lost-terminal-fixture')
            session = module.LinkSession()
            stop = asyncio.Event()
            task = asyncio.create_task(session.run(stop))
            service = module.Service()
            service._current = session
            try:
                await asyncio.wait_for(session.registered.wait(), 1)
                await asyncio.sleep(0.02)
                self.assertEqual(session.attempts, 1)
                self.assertFalse(state.available)
                state.begin('already in flight')
                state.accept({'response': {'message_id': 'old-note'}})
                # The failed subscription leaves active work waiting, not error.
                await asyncio.sleep(0.02)
                self.assertEqual(state.phase, 'waiting')
                state.phase = 'idle'
                result = await service._local_request(b'{"action":"chat_send","message":"create side chat"}')
                self.assertEqual(result, {'ok': True})
                self.assertEqual(state.phase, 'waiting')
                await asyncio.wait_for(session.got_reply.wait(), 3)
                await asyncio.sleep(0.02)
                self.assertGreaterEqual(session.attempts, 2)
                self.assertEqual(state.messages[-1]['text'], 'reply after first send')
                self.assertEqual(state.phase, 'replying')
                self.assertIsNone(state.error)
            finally:
                stop.set()
                await asyncio.wait_for(task, 1)

    async def test_registration_subscription_projection_and_shutdown(self):
        with tempfile.TemporaryDirectory() as root:
            class BaseSession:
                def __init__(self):
                    self.registered = asyncio.Event()
                    self.chat_subscribed = asyncio.Event()
                    self.queue = asyncio.Queue()
                async def run(self, stop):
                    self.registered.set()
                    await stop.wait()
                    self.registered.clear()
                    self.chat_subscribed.clear()
                    return 'stopped'
                async def subscribe_chat(self, session):
                    self.subscribed_session = session
                    self.chat_subscribed.set()
                    try:
                        while True:
                            yield await self.queue.get()
                    finally:
                        self.chat_subscribed.clear()
            class BaseService:
                pass
            module = types.SimpleNamespace(Service=BaseService, LinkSession=BaseSession)
            fake = types.ModuleType('musegadget')
            fake.service = module
            with patch.dict(sys.modules, {'musegadget': fake}):
                state = chat.install(Path(root), 'lost-terminal-fixture')
            session = module.LinkSession()
            stop = asyncio.Event()
            task = asyncio.create_task(session.run(stop))
            try:
                await asyncio.wait_for(session.chat_subscribed.wait(), 1)
                await asyncio.sleep(0.25)
                self.assertTrue(state.available)
                self.assertEqual(session.subscribed_session, 'lost-terminal-fixture')
                await session.queue.put(event('message.assistant', 1, display_text='fixture reply'))
                await asyncio.sleep(0.02)
                self.assertEqual(state.messages[-1]['text'], 'fixture reply')
            finally:
                stop.set()
                self.assertEqual(await asyncio.wait_for(task, 1), 'stopped')
            self.assertFalse(state.available)
            self.assertFalse(json.loads((Path(root) / 'chat.json').read_text())['available'])


if __name__ == '__main__':
    unittest.main()
