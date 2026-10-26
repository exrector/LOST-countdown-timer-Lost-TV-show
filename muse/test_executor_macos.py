"""Offline actual subprocess/file fixtures; no credentials, network or personal files."""
import base64
import errno
import hashlib
import os
from pathlib import Path
import signal
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent / 'vendor'))
from musegadget import executor
from executor_adapter import MacExecutor, install


class ExecutorMacTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='lost-muse-executor-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.worker = MacExecutor(executor.Account.current())
        self.assertEqual(self.root.stat().st_mode & 0o777, 0o700)

    def run_command(self, command, params):
        result = self.worker.run(command, params)
        self.assertTrue(result.get('ok'), result)
        return result['payload']

    def write(self, target, data, **extra):
        return self.worker.run('file.write', {'path': str(target),
            'data_b64': base64.b64encode(data).decode(), **extra})

    def test_clean_child_environment_and_runtime_executor_selection(self):
        with patch.dict(os.environ, {'PYTHONPATH': '/fixture/untrusted', 'MUSEGADGET_SDK_TOKEN': 'fixture-secret'}):
            env = self.worker._child_options()['env']
            self.assertNotIn('PYTHONPATH', env)
            self.assertNotIn('MUSEGADGET_SDK_TOKEN', env)
        original = executor.Executor
        try:
            install()
            self.assertIs(executor.Executor, MacExecutor)
            self.assertEqual(set(executor.COMMAND_SPECS), {'device.health', 'system.run', 'file.read', 'file.write'})
        finally:
            executor.Executor = original

    def test_health_fields_available_on_mac(self):
        data = self.run_command('device.health', {})
        self.assertTrue({'version', 'hostname', 'load', 'disk_gb'} <= data.keys())
        self.assertGreater(data['disk_gb']['total'], 0)
        if sys.platform == 'darwin':
            self.assertFalse({'uptime_s', 'memory_mb', 'temperature_c', 'model'} & data.keys())

    def test_shell_stdout_stderr_nonzero_exit_and_cwd(self):
        data = self.run_command('system.run', {'command': "printf 'fixture-out'; printf 'fixture-err' >&2; exit 7", 'cwd': str(self.root)})
        self.assertEqual((data['stdout'], data['stderr'], data['exit_code']), ('fixture-out', 'fixture-err', 7))
        self.assertFalse(data['timed_out'])
        cwd = self.run_command('system.run', {'command': 'pwd -P', 'cwd': str(self.root)})
        self.assertEqual(cwd['stdout'].strip(), str(self.root))

    def test_timeout_kills_shell_and_its_child_process_group(self):
        result = self.run_command('system.run', {'command': '/bin/sleep 20 & printf "%s %s\\n" "$$" "$!"; wait',
                                                'cwd': str(self.root), 'timeout_ms': 200})
        self.assertTrue(result['timed_out'])
        self.assertEqual(result['exit_code'], -signal.SIGKILL)
        group, child = map(int, result['stdout'].split())
        deadline = time.monotonic() + 2
        while True:
            try:
                os.killpg(group, 0)
            except ProcessLookupError:
                break
            if time.monotonic() >= deadline:
                self.fail('timed-out fixture process group still exists')
            time.sleep(0.02)
        with self.assertRaises(ProcessLookupError):
            os.kill(child, 0)

    def test_two_chunks_sha_and_atomic_commit(self):
        target = self.root / 'atomic.bin'
        target.write_bytes(b'previous')
        target.chmod(0o600)
        data = b'first-chunk\0second-chunk\xff'
        digest = hashlib.sha256(data).hexdigest()
        with target.open('rb') as old_inode:
            first = self.write(target, data[:7], offset=0, final=False)
            self.assertTrue(first['ok'], first)
            self.assertEqual(first['payload']['received'], 7)
            self.assertFalse(first['payload']['complete'])
            self.assertEqual(target.read_bytes(), b'previous')
            self.assertEqual((self.root / '.atomic.bin.musegadget-partial').stat().st_mode & 0o777, 0o600)
            final = self.write(target, data[7:], offset=7, final=True, sha256=digest)
            self.assertTrue(final['ok'], final)
            self.assertEqual(final['payload']['sha256'], digest)
            self.assertEqual(old_inode.read(), b'previous')
        self.assertEqual(target.read_bytes(), data)
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        self.assertFalse((self.root / '.atomic.bin.musegadget-partial').exists())

    def test_overwrite_false_and_bad_hash_preserve_existing_target(self):
        target = self.root / 'preserve.bin'
        target.write_bytes(b'original')
        for extra, expected in (({'overwrite': False}, 'overwrite is false'), ({'sha256': '0' * 64}, 'sha256 mismatch')):
            result = self.write(target, b'replacement', final=True, **extra)
            self.assertFalse(result['ok'])
            self.assertIn(expected, result['error'])
            self.assertEqual(target.read_bytes(), b'original')
            self.assertFalse((self.root / '.preserve.bin.musegadget-partial').exists())

    def test_read_offset_limit_eof_and_base64_roundtrip(self):
        target = self.root / 'read.bin'
        data = bytes(range(256)) * 300
        target.write_bytes(data)
        first = self.run_command('file.read', {'path': str(target), 'offset': 2, 'limit': 4})
        self.assertEqual(base64.b64decode(first['data_b64']), data[2:6])
        self.assertEqual((first['offset'], first['next_offset'], first['eof']), (2, 6, False))
        capped = self.run_command('file.read', {'path': str(target), 'limit': 999999})
        self.assertEqual(len(base64.b64decode(capped['data_b64'])), 65536)
        tail = self.run_command('file.read', {'path': str(target), 'offset': 65536})
        self.assertEqual(base64.b64decode(tail['data_b64']), data[65536:])
        self.assertEqual((tail['next_offset'], tail['eof']), (len(data), True))
        eof = self.run_command('file.read', {'path': str(target), 'offset': len(data)})
        self.assertEqual((eof['data_b64'], eof['next_offset'], eof['eof']), ('', len(data), True))

    def test_wrong_chunk_offset_and_invalid_base64_do_not_commit(self):
        target = self.root / 'bad.bin'
        self.assertTrue(self.write(target, b'first', final=False)['ok'])
        result = self.write(target, b'second', offset=3, final=True)
        self.assertFalse(result['ok'])
        self.assertIn('expected offset 5', result['error'])
        self.assertFalse(target.exists())
        invalid = self.worker.run('file.write', {'path': str(target), 'data_b64': 'not!base64', 'final': True})
        self.assertFalse(invalid['ok'])
        self.assertFalse(target.exists())


if __name__ == '__main__':
    unittest.main()
