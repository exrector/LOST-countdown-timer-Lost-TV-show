import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('installer', Path(__file__).resolve().parents[1] / 'script/install_native.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for rel in ('cast-app', 'LOST.app/Contents/MacOS', 'native/dist/LOST.app/Contents/MacOS'):
            (self.root / rel).mkdir(parents=True)
        (self.root / 'LOST.app/Contents/MacOS/old').write_text('old application')
        (self.root / 'native/dist/LOST.app/Contents/MacOS/LOSTNative').write_text('native application')
        (self.root / 'cast-app/config.json').write_text(json.dumps({'port':8765, 'output':'local', 'custom':'keep'}))
        (self.root / 'cast-app/start.js').write_text("cfg.renderer === 'native'")
        (self.root / 'cast-app/.state.json').write_text('{"live":{"left":4321,"paused":true}}')
        for key, value in [('ROOT', self.root), ('CFG', self.root / 'cast-app/config.json'), ('APP', self.root / 'LOST.app')]:
            p = patch.object(module, key, value); p.start(); self.addCleanup(p.stop)
        for name in ('stop', 'launch'):
            p = patch.object(module, name); p.start(); self.addCleanup(p.stop)

    def test_install_retains_timer_and_custom_config_and_backup(self):
        ready = {'components':{'renderer':{'name':'WKWebView'},'timer':{'status':'ready'},'terminal':{'status':'ready'}}}
        with patch.object(module, 'health', return_value=ready):
            module.install()
        self.assertEqual(json.loads(module.CFG.read_text())['custom'], 'keep')
        self.assertEqual(json.loads(module.CFG.read_text())['renderer'], 'native')
        self.assertEqual(json.loads((self.root/'cast-app/.state.json').read_text())['live']['left'],4321)
        backups = list((self.root/'.native-backups').iterdir())
        self.assertEqual((backups[0]/'LOST.app/Contents/MacOS/old').read_text(), 'old application')

    def test_failed_start_restores_app_and_config_without_touching_state(self):
        before_config = json.loads(module.CFG.read_text())
        before_state = (self.root/'cast-app/.state.json').read_bytes()
        with patch.object(module.time, 'monotonic', side_effect=[0,46]), self.assertRaisesRegex(RuntimeError,'did not become ready'):
            module.install()
        self.assertEqual(json.loads(module.CFG.read_text()),before_config)
        self.assertEqual((module.APP/'Contents/MacOS/old').read_text(),'old application')
        self.assertEqual((self.root/'cast-app/.state.json').read_bytes(),before_state)
        self.assertFalse((module.APP/'Contents/MacOS/LOSTNative').exists())

    def test_explicit_new_live_cycle_preserves_dev_and_backup(self):
        old = {'mode':'dev','audio':'speakers','live':{'left':4321,'paused':True},'dev':{'left':42,'paused':True}}
        state_file = self.root/'cast-app/.state.json'
        state_file.write_text(json.dumps(old))
        ready = {'components':{'renderer':{'name':'WKWebView'},'timer':{'status':'ready'},'terminal':{'status':'ready'}}}
        with patch.object(module, 'health', return_value=ready): module.install(reset_live=True)
        after = json.loads(state_file.read_text())
        self.assertEqual(after['mode'],'live')
        self.assertEqual(after['live'],{'left':6480,'paused':False})
        self.assertEqual(after['dev'],old['dev'])
        self.assertEqual(after['audio'],'speakers')
        backup = next((self.root/'.native-backups').iterdir())
        self.assertEqual(json.loads((backup/'state-before-explicit-reset.json').read_text()),old)


if __name__ == '__main__': unittest.main()
