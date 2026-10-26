'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { createVPNGateway } = require('./gateway.cjs');
async function fixture(t) {
    const calls = []; let enabled = true;
    const vpn = { snapshot: () => ({ enabled, status: 'connected', location: 'NEW YORK' }), execute: async (action, value) => { calls.push([action, value]); return action === 'bad' ? { ok: false, error: 'invalid_action' } : { ok: true, output: 'ok', state: vpn.snapshot() }; } };
    const server = http.createServer((req, res) => { if (!gateway(req, res, new URL(req.url, 'http://x').pathname)) { res.writeHead(404); res.end(); } });
    const gateway = createVPNGateway({ vpn, port: () => server.address().port });
    await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
    const port = server.address().port;
    const request = (method, route, body = '', extra = {}) => new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port, method, path: route, headers: { Host: '127.0.0.1:' + port, ...(method === 'POST' ? { Origin: 'http://127.0.0.1:' + port, 'Content-Type': 'application/json', 'X-LOST-VPN': '1' } : {}), ...extra } }, res => { let raw = ''; res.on('data', x => raw += x); res.on('end', () => resolve({ code: res.statusCode, body: JSON.parse(raw) })); });
        req.on('error', reject); req.end(body);
    });
    return { request, calls, disable: () => enabled = false };
}
test('state is loopback-only and browser origin and Host are restricted against rebinding', async t => {
    const f = await fixture(t); assert.equal((await f.request('GET', '/__vpn/state')).body.status, 'connected');
    assert.equal((await f.request('GET', '/__vpn/state', '', { Origin: 'https://evil.test' })).code, 403);
    assert.equal((await f.request('GET', '/__vpn/state', '', { Host: 'evil.test' })).code, 403);
    const req = new EventEmitter(); req.socket = { remoteAddress: '192.168.1.4' }; req.headers = { host: 'localhost:8765' }; req.resume = () => {};
    let code; const res = { writeHead: value => code = value, end() {} }; createVPNGateway({ vpn: {}, port: 8765 })(req, res, '/__vpn/state'); assert.equal(code, 403);
});
test('only same-origin bounded JSON with custom header reaches command execution', async t => {
    const f = await fixture(t); assert.equal((await f.request('POST', '/__vpn/command', '{"action":"connect","value":"New York"}')).code, 200);
    assert.deepEqual(f.calls, [['connect', 'New York']]);
    for (const headers of [{ Origin: '' }, { 'X-LOST-VPN': '' }, { 'Content-Type': 'text/plain' }]) assert.equal((await f.request('POST', '/__vpn/command', '{"action":"disconnect"}', headers)).code, 403);
    assert.equal((await f.request('POST', '/__vpn/command', '{')).code, 400);
    assert.equal((await f.request('POST', '/__vpn/command', '[]')).code, 400);
    assert.equal((await f.request('POST', '/__vpn/command', 'x'.repeat(4097))).code, 413);
    assert.equal((await f.request('GET', '/__vpn/command')).code, 405);
    assert.equal((await f.request('POST', '/__vpn/command', '{"action":"bad"}')).code, 400);
    assert.equal(f.calls.length, 2);
});
test('disabled monitoring refuses commands without touching router', async t => {
    const f = await fixture(t); f.disable(); assert.equal((await f.request('POST', '/__vpn/command', '{"action":"disconnect"}')).code, 503); assert.deepEqual(f.calls, []);
    assert.equal((await f.request('GET', '/__vpn/state')).body.enabled, false);
});
