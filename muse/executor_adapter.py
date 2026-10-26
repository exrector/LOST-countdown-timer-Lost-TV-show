"""Launch the vendored file worker without relying on inherited sys.path."""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys

from musegadget import executor

FILE_WORKER = Path(__file__).resolve().parent / 'vendor' / 'musegadget' / 'fileops.py'


class MacExecutor(executor.Executor):
    def file_op(self, op: str, params: dict) -> dict:
        # The SDK's clean child environment intentionally has no PYTHONPATH.
        # fileops is a standalone stdlib-only script; use its fixed local path.
        request = json.dumps({**params, 'op': op}).encode()
        proc = subprocess.run(
            [sys.executable, str(FILE_WORKER)], input=request,
            capture_output=True, timeout=60, cwd='/', **self._child_options(),
        )
        try:
            return json.loads(proc.stdout)
        except json.JSONDecodeError:
            return executor.error(proc.stderr.decode(errors='replace')[-2000:] or 'file operation failed')


def install():
    # cli.cmd_run resolves this class only when invoked. Other SDK contracts,
    # child environment, account, timeout and command registry remain upstream.
    executor.Executor = MacExecutor
