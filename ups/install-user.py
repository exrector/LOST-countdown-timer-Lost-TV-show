#!/usr/bin/env python3
"""Install the loopback-only user agent; connection.json is provisioned separately."""
import os
import pathlib
import plistlib
import subprocess

home = pathlib.Path.home()
root = pathlib.Path(__file__).resolve().parent
node = home / '.local/node/bin/node'
if not node.is_file():
    raise SystemExit('Node 20 expected at ~/.local/node/bin/node')
config = home / 'Library/Application Support/LOST UPS'
config.mkdir(parents=True, exist_ok=True, mode=0o700)
os.chmod(str(config), 0o700)
agents = home / 'Library/LaunchAgents'
agents.mkdir(parents=True, exist_ok=True)
target = agents / 'com.exrector.lost-ups.plist'
data = {
    'Label': 'com.exrector.lost-ups',
    'ProgramArguments': [str(node), str(root / 'agent.js')],
    'WorkingDirectory': str(root),
    'EnvironmentVariables': {'LOST_UPS_CONFIG': str(config)},
    'RunAtLoad': True,
    'KeepAlive': True,
    'ThrottleInterval': 10,
    'StandardOutPath': str(config / 'agent.log'),
    'StandardErrorPath': str(config / 'agent-error.log'),
}
with target.open('wb') as stream:
    plistlib.dump(data, stream)
os.chmod(str(target), 0o600)
domain = 'gui/' + str(os.getuid())
subprocess.run(['launchctl', 'bootout', domain, str(target)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
subprocess.run(['launchctl', 'bootstrap', domain, str(target)], check=True)
print('LOST UPS user agent installed; main timer was not restarted.')
