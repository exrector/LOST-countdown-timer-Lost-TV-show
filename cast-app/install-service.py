#!/usr/bin/env python3
"""Install LOST's foreground Node LaunchAgent on macOS 12 or newer.

  install-service.py --root /absolute/LOST --dry-run
  install-service.py --root /absolute/LOST --no-start
  install-service.py --root /absolute/LOST --activate

Default: back up and atomically replace the plist, then bootout/bootstrap it.
--no-start: only back up and replace the plist, without launchctl operations.
--activate: only activate the previously installed plist (must match this root).
--dry-run: print the proposed plist and operations; create or change nothing.

The caller must gracefully stop the previous core and exit the old app before
activation. This script deliberately does not send quit requests or kill apps.
Run as the logged-in user, never with sudo. No shell is used for subprocesses.
"""

import argparse
import datetime
import os
from pathlib import Path
import plistlib
import platform
import shutil
import subprocess
import sys
import tempfile

LABEL = "com.exrector.lost"


def absolute_path(value):
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise ValueError("Expected an absolute path: " + str(path))
    return path.resolve()


def find_node(explicit=None):
    if explicit:
        candidates = [absolute_path(explicit)]
    else:
        candidates = [Path.home() / ".local/node/bin/node"]
        fallback = shutil.which("node")
        if fallback:
            candidates.append(Path(fallback))
    for candidate in candidates:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate.resolve()
    raise ValueError("Executable Node.js not found; pass --node /absolute/path/to/node")


def make_plist(root, node, home):
    logs = home / "Library/Logs/LOST"
    return {
        "Label": LABEL,
        "ProgramArguments": [str(node), str(root / "cast-app/start.js")],
        "WorkingDirectory": str(root / "cast-app"),
        "RunAtLoad": True,
        "KeepAlive": {"SuccessfulExit": False},
        "ThrottleInterval": 10,
        "EnvironmentVariables": {"LOST_SUPERVISED": "1"},
        "StandardOutPath": str(logs / "core.log"),
        "StandardErrorPath": str(logs / "core-error.log"),
    }


def write_plist(destination, payload, backup_root):
    """Preserve existing bytes in a unique directory, then atomically replace."""
    backup = None
    if destination.exists() or destination.is_symlink():
        if destination.is_symlink() or not destination.is_file():
            raise ValueError("Refusing to replace a symlink or non-file LaunchAgent")
        backup_root.mkdir(parents=True, exist_ok=True)
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ-")
        backup_dir = Path(tempfile.mkdtemp(prefix=stamp, dir=str(backup_root)))
        backup = backup_dir / destination.name
        shutil.copy2(destination, backup)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=str(destination.parent), prefix=".lost-", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.chmod(0o644)
        os.replace(temporary, destination)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()
    return backup


def activate(destination, uid):
    domain = "gui/" + str(uid)
    # bootout's nonzero result is expected when the agent is not loaded.
    stopped = subprocess.run(
        ["/bin/launchctl", "bootout", domain + "/" + LABEL],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    if stopped.returncode and stopped.returncode not in (3, 113):
        # Do not suppress unexpected permission or session failures.
        raise RuntimeError("launchctl bootout failed: " + stopped.stderr.strip())
    subprocess.run(["/bin/launchctl", "bootstrap", domain, str(destination)], check=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", required=True, help="Absolute LOST root containing cast-app/start.js")
    parser.add_argument("--node", help="Absolute executable Node.js path (default: ~/.local/node/bin/node, then PATH)")
    parser.add_argument("--dry-run", action="store_true", help="Print plist and operations without writes or launchctl")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--no-start", action="store_true", help="Install plist only; do not bootout or bootstrap")
    mode.add_argument("--activate", action="store_true", help="Activate matching installed plist only; do not rewrite")
    args = parser.parse_args(argv)
    try:
        root = absolute_path(args.root)
        if not (root / "cast-app/start.js").is_file():
            raise ValueError("Missing cast-app/start.js beneath --root")
        node = find_node(args.node)
        home = Path.home()
        destination = home / "Library/LaunchAgents" / (LABEL + ".plist")
        backup_root = home / "Library/Application Support/LOST/backups"
        config = make_plist(root, node, home)
        payload = plistlib.dumps(config, fmt=plistlib.FMT_XML, sort_keys=False)
        if args.activate:
            if destination.is_symlink() or not destination.is_file():
                raise ValueError("Install the LaunchAgent with --no-start before --activate")
            if plistlib.loads(destination.read_bytes()) != config:
                raise ValueError("Installed LaunchAgent does not match proposed root/node; reinstall with --no-start")
        operations = []
        if not args.activate:
            operations += ["Back up existing plist (if present) under " + str(backup_root),
                           "Atomically write " + str(destination)]
        operations.append("Ensure log directory " + str(home / "Library/Logs/LOST"))
        if not args.no_start:
            operations += ["Caller must first gracefully stop the old core and exit the old app",
                           "launchctl bootout gui/UID/" + LABEL,
                           "launchctl bootstrap gui/UID " + str(destination)]
        if args.dry_run:
            print(payload.decode("utf-8"), end="")
            print("\nProposed operations:\n" + "\n".join("- " + item for item in operations))
            return 0
        if sys.platform != "darwin" or int(platform.mac_ver()[0].split(".")[0]) < 12:
            raise ValueError("Installation requires macOS 12 or newer")
        if os.geteuid() == 0:
            raise ValueError("Run as the logged-in user, without sudo")
        (home / "Library/Logs/LOST").mkdir(parents=True, exist_ok=True)
        if not args.activate:
            backup = write_plist(destination, payload, backup_root)
            if backup:
                print("Previous LaunchAgent backed up to " + str(backup))
            print("Installed " + str(destination))
        if not args.no_start:
            activate(destination, os.getuid())
            print("Activated " + LABEL)
        return 0
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError, plistlib.InvalidFileException) as error:
        print("LOST service installation failed: " + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
