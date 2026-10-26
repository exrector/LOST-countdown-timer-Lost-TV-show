'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createFlame, parseStatus } = require('./runtime.cjs');
const { createFlameGateway } = require('./gateway.cjs');
const Flame = require('./client.js');
const { EventEmitter } = require('node:events');

const status = (backend = 'Running') => JSON.stringify({
    BackendState: backend,
    Self: { HostName: 'Station', DNSName: 'swan.example.ts.net.', OS: 'macOS', Online: true, TailscaleIPs: ['100.64.0.1'] },
    Peer: {
        a: { HostName: 'localhost', DNSName: 'phone.example.ts.net.', OS: 'iOS', Online: false, LastSeen: '2026-10-05T07:41:00Z', TailscaleIPs: ['100.64.0.2'] },
        b: { HostName: 'nas', DNSName: 'nas.example.ts.net.', OS: 'linux', Online: true, LastSeen: '0001-01-01T00:00:00Z', TailscaleIPs: ['100.64.0.3'] },
        c: { HostName: 'box\u0007', DNSName: 'stranger.example.ts.net.', OS: 'linux', Online: true },
    },
});
const map = { swan: { station: 'THE SWAN', number: '3' }, nas: { station: 'THE PEARL', number: 5 }, phone: { station: 'THE BEACON' } };

test('nodes become stations by MagicDNS name; addresses never leave the runtime', () => {
    const r = parseStatus(status(), map);
    assert.equal(r.backend, 'Running');
    assert.deepEqual(r.stations.map(s => [s.device, s.station, s.number, s.online, s.self]), [
        ['SWAN', 'THE SWAN', '3', true, true], ['NAS', 'THE PEARL', '5', true, false], ['PHONE', 'THE BEACON', '', false, false], ['STRANGER', '', '', true, false]]);
    assert.equal(r.stations[2].lastSeen, Date.parse('2026-10-05T07:41:00Z'));
    assert.equal(r.stations[1].lastSeen, null);
    assert.equal(JSON.stringify(r).includes('100.64.'), false);
});

test('reads the local CLI with a fixed command and a local stations file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flame-')), file = path.join(dir, 'flame.json');
    fs.writeFileSync(file, JSON.stringify({ stations: map }));
    const calls = [];
    const flame = createFlame({ tailscale: '/fixture/tailscale', stationsFile: file, run: async (bin, args, options) => { calls.push([bin, ...args, options.env.TAILSCALE_BE_CLI]); return { stdout: status() }; }, setTimer: () => 1, clearTimer() {} });
    const s = await flame.refresh({ force: true });
    assert.deepEqual(calls, [['/fixture/tailscale', 'status', '--json', '1']]);
    assert.equal(s.status, 'ready'); assert.equal(s.stations[0].station, 'THE SWAN');
});

test('stopped Tailscale, failing CLI and a missing binary are reported, not hidden', async () => {
    const stopped = createFlame({ tailscale: '/t', run: async () => ({ stdout: status('Stopped') }) });
    assert.equal((await stopped.refresh({ force: true })).status, 'unavailable');
    const broken = createFlame({ tailscale: '/t', run: async () => { throw Error('x'); } });
    const b = await broken.refresh({ force: true }); assert.equal(b.status, 'unavailable'); assert.match(b.error, /Нет ответа/);
    const missing = createFlame({ exists: () => false });
    assert.equal(missing.snapshot().status, 'not_installed'); assert.equal(missing.snapshot().installed, false);
});

test('disabled module stops polling and returns no stations', async () => {
    let cleared = 0;
    const flame = createFlame({ tailscale: '/t', run: async () => ({ stdout: status() }), setTimer: () => 7, clearTimer: () => cleared++ });
    flame.setEnabled(true); flame.setEnabled(false);
    assert.equal(cleared, 1); assert.deepEqual(flame.snapshot().stations, []); assert.equal(flame.snapshot().status, 'disabled');
});

function request(remoteAddress, url, host = 'localhost:8765', method = 'GET') {
    const req = new EventEmitter(); req.socket = { remoteAddress }; req.headers = { host }; req.url = url; req.method = method; req.resume = () => {};
    const res = { code: 0, body: '', writeHead(c) { this.code = c; }, end(b) { this.body = b; this.done(); } };
    return { req, res, finished: new Promise(r => { res.done = r; }) };
}
test('gateway answers only the station itself and only reads', async () => {
    const gate = createFlameGateway({ flame: { snapshot: () => ({ status: 'ready' }), refresh: async () => ({ status: 'ready', fresh: true }) }, port: 8765 });
    let r = request('192.168.1.4', '/__flame/state'); gate(r.req, r.res, '/__flame/state'); await r.finished; assert.equal(r.res.code, 403);
    r = request('127.0.0.1', '/__flame/state', 'evil.test'); gate(r.req, r.res, '/__flame/state'); await r.finished; assert.equal(r.res.code, 403);
    r = request('127.0.0.1', '/__flame/state', undefined, 'POST'); gate(r.req, r.res, '/__flame/state'); await r.finished; assert.equal(r.res.code, 405);
    r = request('127.0.0.1', '/__flame/state?refresh=1'); gate(r.req, r.res, '/__flame/state'); await r.finished; assert.equal(r.res.code, 200); assert.equal(JSON.parse(r.res.body).fresh, true);
    assert.equal(gate(request('127.0.0.1', '/other').req, {}, '/other'), false);
});

test('screen: own station first, unknown machines named, offline shows last contact, blocked signal', () => {
    const screen = Flame.format({ installed: true, enabled: true, status: 'ready', stations: parseStatus(status(), map).stations });
    const lines = screen.split('\n');
    assert.equal(lines[0], 'DHARMA INITIATIVE · THE SWAN → ALL STATIONS'); assert.doesNotMatch(screen, /DHARMA(?! INITIATIVE)/); assert.match(screen, /ONLINE 3 OF 4/);
    assert.match(lines[4], /^3  THE SWAN\s+SWAN\s+ONLINE\s+THIS STATION$/);
    assert.match(screen, /UNKNOWN STATION\s+STRANGER\s+ONLINE/);
    assert.match(screen, /THE BEACON\s+PHONE\s+OFFLINE LAST SEEN \d\d\.10 \d\d:\d\d/);
    assert.ok(lines.every(l => l.length <= 78), 'rows fit the 820px panel');
    assert.match(Flame.row({ number: '1', station: 'THE HYDRA', device: 'EXRECTORS-MAC-MINI-USA-LONG-NAME', online: true }), /EXRECTORS-MAC-MINI-USA  ONLINE$/);
    assert.match(Flame.format({ installed: true, enabled: true, status: 'unavailable', error: 'Tailscale на станции: Stopped' }), /THE LOOKING GLASS IS BLOCKING ALL SIGNALS\.\nTailscale на станции: Stopped/);
    assert.match(Flame.format({ enabled: false }), /MODULE OFFLINE/);
    assert.match(Flame.format('not json'), /ДАННЫЕ НЕДОСТУПНЫ/);
});
