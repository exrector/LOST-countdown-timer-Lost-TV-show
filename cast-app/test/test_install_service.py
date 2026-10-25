import contextlib
import importlib.util
import io
import os
from pathlib import Path
import plistlib
import tempfile
import unittest
from unittest import mock


spec = importlib.util.spec_from_file_location("installer", Path(__file__).resolve().parents[1] / "install-service.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name).resolve()
        self.root = self.home / "LOST with spaces ; $(false)"
        (self.root / "cast-app").mkdir(parents=True)
        (self.root / "cast-app/start.js").write_text("// fixture\n")
        self.node = self.home / "node"
        self.node.write_text("fixture")
        self.node.chmod(0o755)
        self.destination = self.home / "Library/LaunchAgents/com.exrector.lost.plist"
        self.args = ["--root", str(self.root), "--node", str(self.node)]

    def run_main(self, extra):
        with mock.patch.object(Path, "home", return_value=self.home), \
             mock.patch.object(installer.sys, "platform", "darwin"), \
             mock.patch.object(installer.platform, "mac_ver", return_value=("12.7", (), "")), \
             mock.patch.object(installer.os, "geteuid", return_value=501), \
             contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return installer.main(self.args + extra)

    def test_dry_run_has_no_side_effects(self):
        before = sorted(str(path) for path in self.home.rglob("*"))
        with mock.patch.object(installer.subprocess, "run") as run:
            self.assertEqual(self.run_main(["--dry-run"]), 0)
            run.assert_not_called()
        self.assertEqual(before, sorted(str(path) for path in self.home.rglob("*")))

    def test_plist_configuration_and_no_start(self):
        with mock.patch.object(installer.subprocess, "run") as run:
            self.assertEqual(self.run_main(["--no-start"]), 0)
            run.assert_not_called()
        config = plistlib.loads(self.destination.read_bytes())
        self.assertEqual(config["ProgramArguments"], [str(self.node), str(self.root / "cast-app/start.js")])
        self.assertEqual(config["KeepAlive"], {"SuccessfulExit": False})
        self.assertEqual(config["EnvironmentVariables"], {"LOST_SUPERVISED": "1"})
        self.assertTrue(config["RunAtLoad"])
        self.assertEqual(config["ThrottleInterval"], 10)
        self.assertTrue(config["StandardOutPath"].endswith("Library/Logs/LOST/core.log"))

    def test_each_install_keeps_original_backup_bytes(self):
        self.destination.parent.mkdir(parents=True)
        old = b"legacy plist fixture"
        self.destination.write_bytes(old)
        self.assertEqual(self.run_main(["--no-start"]), 0)
        first = self.destination.read_bytes()
        self.assertEqual(self.run_main(["--no-start"]), 0)
        backups = list((self.home / "Library/Application Support/LOST/backups").glob("*/*.plist"))
        self.assertEqual(len(backups), 2)
        self.assertEqual({path.read_bytes() for path in backups}, {old, first})

    def test_activate_uses_argument_lists_and_does_not_rewrite(self):
        self.assertEqual(self.run_main(["--no-start"]), 0)
        before = self.destination.stat().st_mtime_ns
        with mock.patch.object(installer.os, "getuid", return_value=501), \
             mock.patch.object(installer.subprocess, "run", return_value=mock.Mock(returncode=3)) as run:
            self.assertEqual(self.run_main(["--activate"]), 0)
        self.assertEqual(run.call_args_list[0].args[0], ["/bin/launchctl", "bootout", "gui/501/com.exrector.lost"])
        self.assertEqual(run.call_args_list[1].args[0], ["/bin/launchctl", "bootstrap", "gui/501", str(self.destination)])
        self.assertEqual(before, self.destination.stat().st_mtime_ns)

    def test_activate_rejects_other_configuration(self):
        self.assertEqual(self.run_main(["--no-start"]), 0)
        self.destination.write_bytes(plistlib.dumps({"Label": "other"}))
        with mock.patch.object(installer.subprocess, "run") as run:
            self.assertEqual(self.run_main(["--activate"]), 1)
            run.assert_not_called()

    def test_symlink_is_not_replaced(self):
        self.destination.parent.mkdir(parents=True)
        self.destination.symlink_to(self.node)
        self.assertEqual(self.run_main(["--no-start"]), 1)
        self.assertTrue(self.destination.is_symlink())

    def test_unexpected_bootout_error_stops_before_bootstrap(self):
        with mock.patch.object(installer.subprocess, "run", return_value=mock.Mock(returncode=1, stderr="permission denied")) as run:
            with self.assertRaisesRegex(RuntimeError, "permission denied"):
                installer.activate(self.destination, 501)
        self.assertEqual(run.call_count, 1)


if __name__ == "__main__":
    unittest.main()
