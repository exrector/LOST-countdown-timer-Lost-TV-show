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
    const vpn = createVPN({ config, now: () => clock, retryDelayMs: 0, run: async (...args) => { if (args[1].at(-1) !== 'status') return { stdout: 'state=healthy\nmonitor=alive\n' }; calls.push(args); if (fail) throw Error('private error'); return { stdout: 'Connected to NEW YORK in TUN mode' }; } });
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
    assert.equal((await vpn.execute('connect', 'Helsinki')).error, 'disabled'); assert.deepEqual(calls, ['status', 'health']); assert.equal(vpn.snapshot().status, 'disabled');
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
    const vpn = createVPN({ config, now: () => clock, run: async (_f, a) => { if (a.at(-1) === 'status') calls++; return { stdout: 'Connected to NEW YORK in TUN mode' }; }, setTimer: fn => { tick = fn; return 1; }, clearTimer: () => {} });
    vpn.setEnabled(true); await new Promise(r => setImmediate(r));
    for (let i = 1; i <= 3; i++) { clock = i * 60000 - 5; await tick(); assert.equal(calls, i + 1, 'poll ' + i); assert.equal(vpn.snapshot().status, 'connected'); }
});

test('autoPoll false: no own timer — the station poll cycle drives the router reads', async () => {
    let timers = 0, calls = 0;
    const vpn = createVPN({ config, autoPoll: false, staleMs: 180000, run: async (_f, a) => { if (a.at(-1) === 'status') calls++; return { stdout: 'Connected to NEW YORK in TUN mode' }; }, setTimer: () => { timers++; return 1; }, clearTimer: () => {} });
    vpn.setEnabled(true); await new Promise(r => setImmediate(r));
    assert.equal(timers, 0); assert.equal(calls, 1);
    await vpn.refresh({ force: true }); assert.equal(calls, 2);
});

// 2026-11-13: повтор чтения, журнал причин NO DATA и решение о красной плашке VPN.
test('one failed read is retried once; a transient SSH glitch does not turn into NO DATA', async () => {
    let n = 0; const logs = [], sleeps = [];
    const vpn = createVPN({ config, log: t => logs.push(t), sleep: async ms => { sleeps.push(ms); }, run: async (_f, a) => { if (a.at(-1) !== 'status') return { stdout: 'state=healthy\nmonitor=alive\n' }; n++; if (n === 1) { const e = Error('x'); e.code = 255; e.stderr = 'ssh: connect to host router.test port 2222: Operation timed out\n'; throw e; } return { stdout: 'Connected to NEW YORK in TUN mode' }; } });
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

test('test alert shows the plate for the given seconds without touching the VPN', async () => {
    let clock = 0, calls = 0; const logs = [];
    const vpn = createVPN({ config, now: () => clock, log: t => logs.push(t), run: async (_f, a) => { if (a.at(-1) === 'status') calls++; return { stdout: 'Connected to NEW YORK in TUN mode' }; } });
    await vpn.refresh({ force: true }); const before = calls;
    assert.equal(vpn.testAlert(60, 'nodata'), true);
    assert.deepEqual(vpn.snapshot().alert, { code: 'test', text: 'VPN NO DATA' }); assert.equal(vpn.snapshot().status, 'connected');
    clock += 61000; assert.equal(vpn.snapshot().alert, null);
    vpn.testAlert(60); assert.equal(vpn.snapshot().alert.text, 'VPN LINK DOWN'); vpn.testAlert(0); assert.equal(vpn.snapshot().alert, null);
    assert.equal(vpn.testAlert(301), false); assert.equal(vpn.testAlert(10, 'boom'), false); assert.equal(vpn.testAlert('x'), false);
    assert.equal(calls, before); assert.ok(logs.some(t => t.includes('проверка плашки')));
});
// 2026-11-13: окно не должно само «состаривать» показания — ядро читает роутер раз в 120 с, а окно
// с порогом 90 с показывало NO DATA ~30 с из каждых 120 при живом VPN. Свежесть решает только ядро.
test('window trusts the core freshness: no own age threshold on updatedAt in vpn/client.js', () => {
    const client = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8');
    assert.ok(!/Date\.now\(\)\s*-\s*state\.updatedAt/.test(client), 'client must not age readings itself');
    assert.match(client, /function shown\(\)\{return \['connected','disconnected','connecting'\]\.includes\(state\.status\)/);
});
test('core keeps a reading fresh for the whole 120 s station cycle (staleMs 180 s)', async () => {
    let clock = 0;
    const vpn = createVPN({ config, now: () => clock, staleMs: 180000, run: async () => ({ stdout: 'Connected to NEW YORK in TUN mode' }) });
    await vpn.refresh({ force: true });
    for (const t of [90000, 110000, 119000, 179000]) { clock = t; assert.equal(vpn.snapshot().status, 'connected', 'at ' + t); }
});
// 2026-11-13: здоровье туннеля от монитора роутера — LOST видит сбои, при которых CLI пишет «Connected».
const { parseHealth } = require('./runtime.cjs');
const H = (state, extra = '') => 'state=' + state + '\nsince=1794571990\nupdated=1794572000\nmonitor=alive\n' + extra;
function stand({ status = 'Connected to NEW YORK in TUN mode', health = H('healthy'), healthFails = false } = {}) {
    let clock = 1794572100000; const logs = [], cmds = [];
    const box = { status, health, healthFails };
    const vpn = createVPN({ config, now: () => clock, staleMs: 180000, retryDelayMs: 0, log: t => logs.push(t), run: async (_f, a) => {
        const c = a.at(-1); cmds.push(c);
        if (c === 'health') { if (box.healthFails) throw Error('x'); return { stdout: box.health }; }
        return { stdout: box.status };
    } });
    return { vpn, logs, cmds, box, tick: ms => { clock += ms; }, now: () => clock };
}
test('health parser: state, since, monitor and transitions; garbage ignored', () => {
    const h = parseHealth('state=adguard_tunnel_failure_split_alive\nsince=100\nupdated=130\nmonitor=alive\nevent=50 healthy adguard_tunnel_failure_split_alive 1000\nevent=x y z 1\nrandom line\n');
    assert.equal(h.state, 'adguard_tunnel_failure_split_alive'); assert.equal(h.since, 100000); assert.equal(h.alive, true);
    assert.deepEqual(h.events, [{ at: 50000, from: 'healthy', to: 'adguard_tunnel_failure_split_alive', duration: 1000000 }]);
    assert.equal(parseHealth('nothing'), null); assert.equal(parseHealth('state=bad;id'), null);
});
test('connected + tunnel failure from the monitor: TUNNEL FAILURE plate at once, status stays connected', async () => {
    const t = stand({ health: H('adguard_tunnel_failure_split_alive') });
    const s = await t.vpn.refresh({ force: true });
    assert.equal(s.status, 'connected'); assert.equal(s.location, 'NEW YORK');
    assert.deepEqual(s.fault && s.fault.code, 'tunnel'); assert.equal(s.fault.text, 'TUNNEL FAILURE');
    assert.deepEqual(s.alert, { code: 'tunnel', text: 'VPN TUNNEL FAILURE' });
    assert.deepEqual(t.cmds, ['status', 'health']);
    assert.ok(t.logs.includes('[vpn] туннель: adguard_tunnel_failure_split_alive'));
});
test('kill switch and DNS failures get their own plates; provider outage and RU-bypass do not', async () => {
    for (const [state, code] of [['adguard_killswitch_missing', 'killswitch'], ['adguard_dns_failure', 'dns'], ['adguard_route_missing', 'tunnel'], ['adguard_total_failure', 'tunnel']]) {
        const t = stand({ health: H(state) }); assert.equal((await t.vpn.refresh({ force: true })).alert.code, code, state);
    }
    for (const state of ['provider_path_unavailable', 'adguard_split_bypass_failure', 'healthy', 'observer_stale']) {
        const t = stand({ health: H(state) }); assert.equal((await t.vpn.refresh({ force: true })).alert, null, state);
    }
    assert.equal(stand().vpn.snapshot().alert, null);
});
test('a dead monitor or a failed health read never invents a fault and never breaks the status', async () => {
    const dead = stand({ health: 'state=adguard_tunnel_failure_split_alive\nsince=1\nmonitor=dead\n' });
    const s1 = await dead.vpn.refresh({ force: true }); assert.equal(s1.status, 'connected'); assert.equal(s1.alert, null);
    assert.ok(dead.logs.some(x => x.includes('монитор VPN на роутере не работает')));
    const broken = stand({ healthFails: true });
    const s2 = await broken.vpn.refresh({ force: true }); assert.equal(s2.status, 'connected'); assert.equal(s2.alert, null);
    assert.ok(broken.logs.some(x => x.includes('здоровье туннеля недоступно')));
});
test('disconnected wins over a tunnel fault; an old health reading expires with the status', async () => {
    const t = stand({ status: 'Disconnected', health: H('adguard_tunnel_failure_split_alive') });
    assert.equal((await t.vpn.refresh({ force: true })).alert.code, 'down');
    const u = stand({ health: H('adguard_tunnel_failure_split_alive') }); await u.vpn.refresh({ force: true });
    u.tick(181000); assert.equal(u.vpn.snapshot().fault, null);
});
test('a fault that started and ended between two polls is remembered for an hour (LAST FAULT)', async () => {
    const t = stand({ health: H('healthy', 'event=1794571990 healthy adguard_tunnel_failure_split_alive 12346\nevent=1794572051 adguard_tunnel_failure_split_alive healthy 61\n') });
    const s = await t.vpn.refresh({ force: true });
    assert.equal(s.alert, null); assert.equal(s.fault, null);
    assert.deepEqual(s.lastFault, { code: 'tunnel', text: 'TUNNEL FAILURE', startedAt: 1794571990000, endedAt: 1794572051000, duration: 61000 });
    t.tick(3600000); await t.vpn.refresh({ force: true }); assert.equal(t.vpn.snapshot().lastFault, null);
});
test('router forced command: health is read-only, exact, and reads the monitor files', t => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'lost-vpn-health-')); t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    fs.mkdirSync(path.join(folder, 'lib')); fs.mkdirSync(path.join(folder, 'logs'));
    fs.writeFileSync(path.join(folder, 'lib/current-state'), 'state=healthy\nsince=10\nupdated=20\ntimestamp=x\ntun_rx=5\n');
    fs.writeFileSync(path.join(folder, 'lib/pid'), String(process.pid));
    const month = new Date().toISOString().slice(0, 7);
    fs.writeFileSync(path.join(folder, 'logs/adguard-events-' + month + '.tsv'), 'iso\t100\ttransition\thealthy\tadguard_dns_failure\t90\t1\niso\t160\theartbeat\tx\tx\t1\niso\t200\ttransition\tadguard_dns_failure\thealthy\t100\t1\n');
    const helper = path.join(folder, 'helper');
    fs.writeFileSync(helper, fs.readFileSync(path.join(__dirname, 'router-command.sh'), 'utf8').replace('/opt/var/lib/adguard-vpn-monitor', path.join(folder, 'lib')).replace('/opt/var/log/keenetic-outages', path.join(folder, 'logs')));
    const invoke = original => spawnSync('/bin/sh', [helper], { encoding: 'utf8', env: { ...process.env, SSH_ORIGINAL_COMMAND: original } });
    const r = invoke('health'); assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'state=healthy\nsince=10\nupdated=20\nmonitor=alive\nevent=100 healthy adguard_dns_failure 90\nevent=200 adguard_dns_failure healthy 100\n');
    for (const bad of ['health x', 'health;id', 'health\n']) assert.equal(invoke(bad).status, 64, bad);
    assert.equal(commandFor('health'), 'health'); assert.throws(() => commandFor('health', 'x'));
});
