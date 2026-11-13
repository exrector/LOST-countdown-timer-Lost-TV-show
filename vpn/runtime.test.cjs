'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createVPN, parseStatus, commandFor, safeOutput } = require('./runtime.cjs');
const config = { host: 'router.test', port: 2222, user: 'lost', identityFile: '/fixture/key', knownHostsFile: '/fixture/known_hosts' };
test('status parser distinguishes explicit disconnected, connection and unrecognized failures', () => {
    assert.deepEqual(parseStatus('Connected to \x1b[1mNEW YORK\x1b[0m in \x1b[1mTUN\x1b[0m mode, running on tun0\n'), { status: 'connected', location: 'NEW YORK' });
    assert.equal(parseStatus('Disconnected').status, 'disconnected');
    assert.equal(parseStatus('Not connected').status, 'disconnected');
    assert.equal(parseStatus('Connecting...').status, 'connecting');
    assert.equal(parseStatus('SSH connection refused'), null);
    assert.equal(parseStatus('Warning: not connected to SSH'), null);
});
test('command validation rejects shell input, option injection and credentials settings', () => {
    assert.equal(commandFor('connect', 'New York'), 'connect New York');
    assert.equal(commandFor('exclusions-add', { mode: 'general', domain: 'пример.рф' }), 'exclusions-add general xn--e1afmkfd.xn--p1ai');
    for (const value of ['New York; id', 'NY\nHelsinki', '-l Paris', '$(id)', 'New\tYork']) assert.throws(() => commandFor('connect', value));
    for (const domain of ['example.com;id', '*.example.com', 'https://example.com', 'a..com', '-x.com']) assert.throws(() => commandFor('exclusions-remove', { mode: 'general', domain }));
    assert.throws(() => commandFor('setting', { name: 'set-socks-password', value: 'secret' }));
    assert.throws(() => commandFor('setting', { name: 'set-dns', value: '1.1.1.1; id' }));
    assert.throws(() => commandFor('setting', { name: 'set-socks-port', value: '65536' }));
    assert.equal(commandFor('setting', { name: 'set-bound-if-override', value: '' }), 'setting set-bound-if-override -');
    assert.equal(commandFor('setting', { name: 'set-socks-port', value: '1080' }), 'setting set-socks-port 1080');
});
test('poll is cached, uses strict SSH identity and no fallback; failed poll is unknown, not disconnected', async () => {
    let clock = 1000, fail = false; const calls = [];
    const vpn = createVPN({ config, now: () => clock, retryDelayMs: 0, run: async (...args) => { calls.push(args); if (fail) throw Error('private error'); return { stdout: 'Connected to NEW YORK in TUN mode' }; } });
    assert.equal((await vpn.refresh()).status, 'connected');
    await vpn.refresh(); assert.equal(calls.length, 1);
    assert.equal(calls[0][0], '/usr/bin/ssh'); assert.ok(calls[0][1].includes('StrictHostKeyChecking=yes')); assert.ok(calls[0][1].includes('IdentitiesOnly=yes')); assert.ok(calls[0][1].includes('UserKnownHostsFile=/fixture/known_hosts'));
    clock += 91000; assert.equal(vpn.snapshot().status, 'unavailable');
    fail = true; assert.equal((await vpn.refresh()).status, 'unavailable'); assert.equal(calls.length, 2); assert.ok(!JSON.stringify(vpn.snapshot()).includes('private error'));
});
test('old explicit disconnected state also expires', async () => {
    let clock = 100; const vpn = createVPN({ config, now: () => clock, run: async () => ({ stdout: 'Disconnected' }) });
    assert.equal((await vpn.refresh()).status, 'disconnected'); clock += 91000; assert.equal(vpn.snapshot().status, 'unavailable');
});
test('module off stops only monitoring and blocks commands, never disconnects VPN', async () => {
    const calls = [], timers = []; let cleared = 0;
    const vpn = createVPN({ config, run: async (_file, args) => { calls.push(args.at(-1)); return { stdout: 'Disconnected' }; }, setTimer: fn => { timers.push(fn); return 1; }, clearTimer: () => cleared++ });
    vpn.setEnabled(true); await new Promise(r => setImmediate(r)); assert.equal(calls[0], 'status');
    assert.equal(vpn.setEnabled(false).enabled, false); assert.equal(cleared, 1); await timers[0]();
    assert.equal((await vpn.execute('connect', 'Helsinki')).error, 'disabled'); assert.deepEqual(calls, ['status']); assert.equal(vpn.snapshot().status, 'disabled');
});
test('mutations are serialized, refresh status afterwards and expose no busy latch after completion', async () => {
    const calls = []; let release; const pending = new Promise(r => release = r);
    const vpn = createVPN({ config, run: async (_file, args) => { const command = args.at(-1); calls.push(command); if (command === 'connect New York') { await pending; return { stdout: 'Connected' }; } return { stdout: 'Connected to NEW YORK in TUN mode' }; } });
    const first = vpn.execute('connect', 'New York'); assert.equal((await vpn.execute('disconnect')).error, 'busy'); release(); const result = await first;
    assert.equal(result.ok, true); assert.equal(result.state.status, 'connected'); assert.equal(result.state.busy, false); assert.deepEqual(calls, ['connect New York', 'status']);
});
test('missing configuration never tries SSH or fabricates disconnected', async () => {
    let calls = 0; const vpn = createVPN({ configFile: '/does/not/exist', run: async () => calls++ });
    assert.equal(vpn.snapshot().installed, false); await vpn.refresh(); assert.equal((await vpn.execute('status')).error, 'not_installed'); assert.equal(calls, 0); assert.equal(vpn.snapshot().status, 'unavailable');
    assert.equal(safeOutput('Socks password: abc\nSocks username: joe\nMode: TUN').includes('abc'), false);
});
test('router forced command validates complete input and arguments before dispatch', t => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'lost-vpn-helper-')); t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    const stub = path.join(folder, 'cli'); fs.writeFileSync(stub, '#!/bin/sh\nprintf "ARG:%s\\n" "$@"\n'); fs.chmodSync(stub, 0o700);
    const helper = path.join(folder, 'helper'); fs.writeFileSync(helper, fs.readFileSync(path.join(__dirname, 'router-command.sh'), 'utf8').replace('/opt/bin/adguardvpn-cli', stub));
    const invoke = original => spawnSync('/bin/sh', [helper], { encoding: 'utf8', env: { ...process.env, SSH_ORIGINAL_COMMAND: original } });
    for (const input of ['connect New York; id', 'connect NY\nHelsinki', 'connect NY\tHelsinki', 'status\n', 'setting set-dns 1.1.1.1;id', 'exclusions-add general example.com$(id)', 'setting set-socks-password secret']) assert.equal(invoke(input).status, 64, input);
    const cases = ['status', 'connect New York', 'exclusions-add general example.com', 'setting set-dns 1.1.1.1', 'setting set-socks-host 127.0.0.1', 'setting set-socks-host ::1', 'setting set-socks-port 1080', 'setting set-bound-if-override -'];
    for (const input of cases) assert.equal(invoke(input).status, 0, input + ': ' + invoke(input).stderr);
    assert.match(invoke('connect New York').stdout, /ARG:New York/);
    assert.match(invoke('exclusions-add general example.com').stdout, /ARG:example.com \*\.example.com/);
});

test('the 60 s poll timer firing a moment early still polls: readings never go stale between polls', async () => {
    let clock = 0, calls = 0, tick = null;
    const vpn = createVPN({ config, now: () => clock, run: async () => { calls++; return { stdout: 'Connected to NEW YORK in TUN mode' }; }, setTimer: fn => { tick = fn; return 1; }, clearTimer: () => {} });
    vpn.setEnabled(true); await new Promise(r => setImmediate(r));
    for (let i = 1; i <= 3; i++) { clock = i * 60000 - 5; await tick(); assert.equal(calls, i + 1, 'poll ' + i); assert.equal(vpn.snapshot().status, 'connected'); }
});

test('autoPoll false: no own timer — the station poll cycle drives the router reads', async () => {
    let timers = 0, calls = 0;
    const vpn = createVPN({ config, autoPoll: false, staleMs: 180000, run: async () => { calls++; return { stdout: 'Connected to NEW YORK in TUN mode' }; }, setTimer: () => { timers++; return 1; }, clearTimer: () => {} });
    vpn.setEnabled(true); await new Promise(r => setImmediate(r));
    assert.equal(timers, 0); assert.equal(calls, 1);
    await vpn.refresh({ force: true }); assert.equal(calls, 2);
});

// 2026-11-13: повтор чтения, журнал причин NO DATA и решение о красной плашке VPN.
test('one failed read is retried once; a transient SSH glitch does not turn into NO DATA', async () => {
    let n = 0; const logs = [], sleeps = [];
    const vpn = createVPN({ config, log: t => logs.push(t), sleep: async ms => { sleeps.push(ms); }, run: async () => { n++; if (n === 1) { const e = Error('x'); e.code = 255; e.stderr = 'ssh: connect to host router.test port 2222: Operation timed out\n'; throw e; } return { stdout: 'Connected to NEW YORK in TUN mode' }; } });
    const s = await vpn.refresh({ force: true });
    assert.equal(s.status, 'connected'); assert.equal(n, 2); assert.deepEqual(sleeps, [4000]);
    assert.ok(logs.some(t => t.includes('повтор') && t.includes('ssh код 255') && t.includes('Operation timed out')));
    assert.ok(logs.includes('[vpn] connected NEW YORK'));
});
test('two failures in a row: NO DATA with the reason in the log, never in the snapshot', async () => {
    const logs = [];
    const vpn = createVPN({ config, log: t => logs.push(t), sleep: async () => {}, run: async () => { const e = Error('private'); e.killed = true; throw e; } });
    const s = await vpn.refresh({ force: true });
    assert.equal(s.status, 'unavailable'); assert.equal(s.alert, null);
    assert.ok(logs.some(t => t.startsWith('[vpn] нет данных') && t.includes('таймаут')));
    assert.ok(!JSON.stringify(s).includes('private'));
});
test('unrecognised router output is logged with its first line', async () => {
    const logs = [];
    const vpn = createVPN({ config, retryDelayMs: 0, log: t => logs.push(t), run: async () => ({ stdout: 'You are not logged in\nmore' }) });
    await vpn.refresh({ force: true });
    assert.ok(logs.some(t => t.includes('непонятный ответ') && t.includes('You are not logged in')));
});
test('state changes are logged once, not every poll', async () => {
    let clock = 0; const logs = [];
    const vpn = createVPN({ config, now: () => clock, log: t => logs.push(t), run: async () => ({ stdout: 'Connected to HELSINKI in TUN mode' }) });
    await vpn.refresh({ force: true }); clock += 120000; await vpn.refresh({ force: true }); clock += 120000; await vpn.refresh({ force: true });
    assert.equal(logs.filter(t => t === '[vpn] connected HELSINKI').length, 1);
});
test('alert: DISCONNECTED at once, CONNECTING after 3 min, NO DATA after 5 min, nothing when connected or module off', async () => {
    let clock = 1000, out = 'Disconnected', fail = false;
    const vpn = createVPN({ config, now: () => clock, staleMs: 180000, retryDelayMs: 0, run: async () => { if (fail) throw Error('x'); return { stdout: out }; } });
    assert.deepEqual((await vpn.refresh({ force: true })).alert, { code: 'down', text: 'VPN LINK DOWN' });
    out = 'Connecting...'; clock += 1000;
    assert.equal((await vpn.refresh({ force: true })).alert, null);
    clock += 120000; assert.equal((await vpn.refresh({ force: true })).alert, null);      // 2 мин подключения — ещё норма
    clock += 61000; assert.equal((await vpn.refresh({ force: true })).alert.code, 'connecting');
    out = 'Connected to NEW YORK in TUN mode'; clock += 1000;
    assert.equal((await vpn.refresh({ force: true })).alert, null);
    fail = true; clock += 1000;
    assert.equal((await vpn.refresh({ force: true })).alert, null);                       // разовое NO DATA — без тревоги
    clock += 299000; assert.equal(vpn.snapshot().alert, null);
    clock += 2000; assert.deepEqual(vpn.snapshot().alert, { code: 'nodata', text: 'VPN NO DATA' });
    vpn.setEnabled(false); assert.equal(vpn.snapshot().alert, null);
});
test('stale readings count NO DATA from the last good read', async () => {
    let clock = 0;
    const vpn = createVPN({ config, now: () => clock, staleMs: 180000, run: async () => ({ stdout: 'Connected to NEW YORK in TUN mode' }) });
    await vpn.refresh({ force: true });
    clock = 181000; assert.equal(vpn.snapshot().status, 'unavailable'); assert.equal(vpn.snapshot().alert, null);
    clock = 301000; assert.equal(vpn.snapshot().alert.code, 'nodata');
});
test('not installed: never alerts', () => {
    const vpn = createVPN({ configFile: '/nonexistent/vpn.json', now: () => 10 ** 9 });
    assert.equal(vpn.snapshot().alert, null);
});
