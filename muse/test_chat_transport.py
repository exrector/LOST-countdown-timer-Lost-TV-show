"""Offline verification of independent Muse control and dedicated chat channels."""
from pathlib import Path
import asyncio
import base64
import io
import json
import sys
import tempfile
import types
import unittest
import wave
from unittest.mock import patch
from unittest.mock import AsyncMock

sys.path.insert(0, str(Path(__file__).parent / 'vendor'))
from chat_adapter import install
from musegadget.link_client import DeviceDescription, LinkSession, MessageDecoder, encode_message
from musegadget.noise import ApplicationResponse, BodyChunk, NoiseFrameDecoder, NoiseXXResponder, ServiceFrame, encode_noise_frames
from musegadget.noise.transport import decode_request_envelope, encode_response_envelope


class MemorySocket:
    def __init__(self, inbox, outbox):
        self.inbox, self.outbox = inbox, outbox
        self.closed = False

    async def send(self, data):
        await self.outbox.put(data)

    async def recv(self):
        data = await self.inbox.get()
        if data is None:
            raise ConnectionError('fixture closed')
        return data

    async def close(self):
        self.closed = True
        await self.outbox.put(None)


class NoisePeer:
    """Real Noise responder and framing over queues, with no socket/network."""
    def __init__(self, socket):
        self.socket = socket
        self.decoder = NoiseFrameDecoder()

    async def handshake(self):
        responder = NoiseXXResponder()
        responder.initialize()
        await self.socket.send(responder.read_message1_and_write_message2(await self.socket.recv()))
        responder.read_message3(await self.socket.recv())
        self.send_cipher, self.recv_cipher = responder.split()

    async def receive(self):
        while True:
            decrypted = self.recv_cipher.decrypt_with_ad(b'', await self.socket.recv())
            body = self.decoder.decode(decrypted)
            if body is not None:
                return decode_request_envelope(body)

    async def send(self, frame):
        for body in encode_noise_frames(encode_response_envelope(frame)):
            await self.socket.send(self.send_cipher.encrypt_with_ad(b'', body))


def event(kind, ident, parent=None, **extra):
    payload = {'message_id': ident, **extra}
    if parent:
        payload['reply_to_message_id'] = parent
    return {'type': 'event', 'event': kind, 'payload': payload}


class ChatTransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_noise_chat_subscription_cannot_consume_control_invoke(self):
        from musegadget import service
        peers = asyncio.Queue()
        sockets = []
        calls = []

        async def connect(url, headers):
            inbound, outbound = asyncio.Queue(), asyncio.Queue()
            client = MemorySocket(inbound, outbound)
            sockets.append(client)
            await peers.put(NoisePeer(MemorySocket(outbound, inbound)))
            return client

        def command(name, params, timeout):
            calls.append(name)
            return {'ok': True, 'payload': {'fixture_nonce': 'offline-proof'}}

        with tempfile.TemporaryDirectory() as root:
            base_session, base_service = service.LinkSession, service.Service
            try:
                state = install(Path(root), 'lost-terminal-fixture', separate_chat=True)
                session = service.LinkSession(noise_host='offline.invalid', vm_id='fixture',
                    vm_auth_token='fake', device=DeviceDescription('fixture-node', 'fixture', 'test', {}),
                    run_command=command, connect=connect)
                stop = asyncio.Event()
                running = asyncio.create_task(session.run(stop))
                control = await asyncio.wait_for(peers.get(), 1)
                await asyncio.wait_for(control.handshake(), 1)
                request = await asyncio.wait_for(control.receive(), 1)
                self.assertEqual(request.value.path, '/link-control')
                control_id = request.stream_id
                await control.send(ServiceFrame.response(control_id, ApplicationResponse(status=200)))
                register_frame = await asyncio.wait_for(control.receive(), 1)
                register = MessageDecoder().feed(register_frame.value.data)[0]
                self.assertEqual(register['method'], 'link.register')
                await control.send(ServiceFrame.body_chunk(control_id, BodyChunk(data=encode_message(
                    {'type': 'res', 'id': register['id'], 'result': {'node_id': 'fixture-node', 'status': 'registered'}}))))
                chat = await asyncio.wait_for(peers.get(), 1)
                await asyncio.wait_for(chat.handshake(), 1)
                subscribe = await asyncio.wait_for(chat.receive(), 1)
                # First HTTP request is subscribe, never a second link.register.
                self.assertEqual(subscribe.value.path, '/chat/subscribe')
                self.assertEqual(json.loads(subscribe.value.body)['session_id'], 'lost-terminal-fixture')
                # A brand-new side chat may return 404 until its first POST.
                await chat.send(ServiceFrame.response(subscribe.stream_id, ApplicationResponse(status=404, end_body=True)))
                client = service.Service(identity=None, executor=None)
                client._current = session
                send = asyncio.create_task(client._local_request(b'{"action":"chat_send","message":"fixture question"}'))
                post = await asyncio.wait_for(chat.receive(), 1)
                self.assertEqual(post.value.path, '/chat/stream')
                body = json.loads(post.value.body)
                self.assertEqual((body['device_id'], body['session_id']), ('fixture-node', 'lost-terminal-fixture'))
                await chat.send(ServiceFrame.response(post.stream_id, ApplicationResponse(status=200, end_body=True,
                    body=json.dumps({'result': {'message_id': 'our-note'}}).encode())))
                self.assertEqual(await asyncio.wait_for(send, 1), {'ok': True})
                subscribe = await asyncio.wait_for(chat.receive(), 5)
                self.assertEqual(subscribe.value.path, '/chat/subscribe')
                self.assertEqual(len(sockets), 2)  # HTTP stayed usable across 404.
                await chat.send(ServiceFrame.response(subscribe.stream_id, ApplicationResponse(status=200)))
                await control.send(ServiceFrame.body_chunk(control_id, BodyChunk(data=encode_message(
                    {'method': 'link.invoke', 'id': 'health-proof', 'command': 'device.health', 'params': {}}))))
                result_frame = await asyncio.wait_for(control.receive(), 1)
                result = MessageDecoder().feed(result_frame.value.data)[0]
                self.assertEqual(result, {'method': 'link.result', 'id': 'health-proof', 'ok': True,
                                          'payload': {'fixture_nonce': 'offline-proof'}})
                reply = event('message.assistant', 'own-reply', 'our-note', text='fixture result received')
                await chat.send(ServiceFrame.body_chunk(subscribe.stream_id, BodyChunk(data=json.dumps(reply).encode()+b'\n')))
                for _ in range(100):
                    if len(state.messages) > 1:
                        break
                    await asyncio.sleep(0.001)
                self.assertEqual(state.messages[-1]['text'], 'fixture result received')
                self.assertEqual(calls, ['device.health'])
                self.assertEqual(len(sockets), 2)
                # Drop only HTTP chat. Control registration survives, while
                # the observer reconnects and restores the same side chat.
                await chat.socket.close()
                replacement = await asyncio.wait_for(peers.get(), 5)
                self.assertTrue(session.registered.is_set())
                self.assertFalse(sockets[0].closed)
                await asyncio.wait_for(replacement.handshake(), 1)
                reopened = await asyncio.wait_for(replacement.receive(), 1)
                self.assertEqual(reopened.value.path, '/chat/subscribe')
                self.assertEqual(json.loads(reopened.value.body)['session_id'], 'lost-terminal-fixture')
                await replacement.send(ServiceFrame.response(reopened.stream_id, ApplicationResponse(status=200)))
                await asyncio.wait_for(session._chat_channel.chat_subscribed.wait(), 1)
                self.assertEqual(len(sockets), 3)
            finally:
                if 'stop' in locals():
                    stop.set()
                    await asyncio.wait_for(running, 1)
                    self.assertTrue(all(s.closed for s in sockets))
                service.LinkSession, service.Service = base_session, base_service

    async def test_chat_auth_rejection_closes_control_for_credential_refetch(self):
        from musegadget import service
        from musegadget.link_client import _UpgradeRejected, Outcome
        peers = asyncio.Queue()
        sockets = []

        async def connect(url, headers):
            if sockets:
                raise _UpgradeRejected(401)
            inbound, outbound = asyncio.Queue(), asyncio.Queue()
            client = MemorySocket(inbound, outbound)
            sockets.append(client)
            await peers.put(NoisePeer(MemorySocket(outbound, inbound)))
            return client

        with tempfile.TemporaryDirectory() as root:
            original = service.LinkSession, service.Service
            try:
                install(Path(root), 'lost-terminal-fixture', separate_chat=True)
                session = service.LinkSession(noise_host='offline.invalid', vm_id='fixture', vm_auth_token='fake',
                    device=DeviceDescription('fixture-node', 'fixture', 'test', {}), run_command=lambda *args: {}, connect=connect)
                stop = asyncio.Event()
                running = asyncio.create_task(session.run(stop))
                peer = await asyncio.wait_for(peers.get(), 1)
                await asyncio.wait_for(peer.handshake(), 1)
                request = await asyncio.wait_for(peer.receive(), 1)
                await peer.send(ServiceFrame.response(request.stream_id, ApplicationResponse(status=200)))
                register = MessageDecoder().feed((await asyncio.wait_for(peer.receive(), 1)).value.data)[0]
                await peer.send(ServiceFrame.body_chunk(request.stream_id, BodyChunk(data=encode_message(
                    {'id': register['id'], 'ok': True}))))
                # Model the close handshake: closing the client wakes recv.
                async def close():
                    sockets[0].closed = True
                    await sockets[0].inbox.put(None)
                sockets[0].close = close
                self.assertEqual(await asyncio.wait_for(running, 1), Outcome.CLOSED)
                self.assertTrue(sockets[0].closed)
            finally:
                if 'running' in locals() and not running.done():
                    stop.set()
                    await asyncio.wait_for(running, 1)
                service.LinkSession, service.Service = original

    async def test_text_voice_and_subscription_use_one_dedicated_chat_channel(self):
        calls = []
        subscribed = asyncio.Event()
        registrations = []
        opened = set()


        class BaseSession:
            def __init__(self):
                self.registered = asyncio.Event()
                self.chat_subscribed = asyncio.Event()
                self.subscribed = asyncio.Event()

            async def run(self, stop):
                opened.add(self)
                try:
                    await self._open_control_stream()
                    await stop.wait()
                finally:
                    opened.discard(self)

            async def _open_control_stream(self):
                registrations.append(self)
                self.registered.set()

            async def subscribe_chat(self, session_id):
                calls.append(('subscribe', session_id))
                subscribed.set()
                await asyncio.Event().wait()
                yield {}

            async def send_chat(self, message, session_id, **kwargs):
                calls.append(('text', session_id))
                return {'ok': True, 'response': {'result': {'message_id': 'own-text'}}}

            async def send_voice(self, audio, session_id, **kwargs):
                calls.append(('voice', session_id))
                return {'ok': True, 'response': {'result': {'message_id': 'own-voice'}}}

        with tempfile.TemporaryDirectory() as root:
            module = types.SimpleNamespace(Service=type('Service', (), {}), LinkSession=BaseSession)
            fake = types.ModuleType('musegadget')
            fake.service = module
            with patch.dict(sys.modules, {'musegadget': fake}):
                state = install(Path(root), "lost-terminal-fixture", separate_chat=True)
            session = module.LinkSession()
            stop = asyncio.Event()
            running = asyncio.create_task(session.run(stop))
            service = module.Service()
            service._current = session
            try:
                await asyncio.wait_for(subscribed.wait(), 1)
                self.assertIsNot(session._chat_channel, session)
                self.assertFalse(session._chat_channel.registered.is_set())
                self.assertEqual(registrations, [session])
                self.assertEqual(len(opened), 2)
                self.assertIsNone(session._chat_channel._handle(
                    {'method': 'link.invoke', 'id': 'not-on-chat', 'command': 'device.health'}))
                self.assertEqual(await service._local_request(
                    b'{"action":"chat_send","message":"own question"}'), {'ok': True})
                state.event(event('message.assistant', 'own-answer', 'own-text', text='own answer'))
                state.event(event('message.assistant', 'other-answer', 'foreign-note', text='private'))
                self.assertEqual(state.messages[-1]['text'], 'own answer')
                state.phase = 'idle'
                audio = io.BytesIO()
                with wave.open(audio, 'wb') as wav:
                    wav.setnchannels(1)
                    wav.setsampwidth(2)
                    wav.setframerate(16000)
                    wav.writeframes(b'\0\0' * 160)
                request = {'action': 'chat_voice', 'audio_base64': base64.b64encode(audio.getvalue()).decode()}
                self.assertEqual(await service._local_request(json.dumps(request).encode()), {'ok': True})
                self.assertEqual(calls, [('subscribe', 'lost-terminal-fixture'), ('text', 'lost-terminal-fixture'), ('voice', 'lost-terminal-fixture')])
            finally:
                stop.set()
                await asyncio.wait_for(running, 1)
                self.assertFalse(opened)
                state.flush()

    async def test_health_executor_returns_result_on_control(self):
        from musegadget.link_client import DeviceDescription, LinkSession
        from musegadget.executor import Account, Executor
        session = LinkSession(noise_host='offline.invalid', vm_id='fixture', vm_auth_token='fake',
                              device=DeviceDescription('fixture', 'fixture', 'test', {}),
                              run_command=Executor(Account.current()).run)
        session.send = AsyncMock()
        await asyncio.wait_for(session._invoke(
            {'id': 'health-fixture', 'command': 'device.health', 'params': {}, 'timeout_ms': 30000}), 2)
        reply = session.send.await_args.args[0]
        self.assertEqual((reply['method'], reply['id'], reply['ok']), ('link.result', 'health-fixture', True))
        self.assertIn('disk_gb', reply['payload'])
