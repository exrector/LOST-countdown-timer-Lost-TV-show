'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createUPSGateway } = require('../ups-gateway.js');

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
function request(port, path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
        body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
async function fixture(t, responder, options = {}) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      responder(req, res, body);
    });
  });
  const upstreamPort = await listen(upstream);
  const handler = createUPSGateway({ port: upstreamPort, ...options });
  const core = http.createServer((req, res) => {
    if (!handler(req, res, new URL(req.url, 'http://localhost').pathname)) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{}');
    }
  });
  const port = await listen(core);
  t.after(async () => { await close(core); await close(upstream); });
  return { port, seen };
}
const writeHeaders = { origin: 'http://localhost:8765', 'x-lost-ups': '1', 'content-type': 'application/json' };
const ok = (_req, res) => res.end('{"ok":true}');

test('state is proxied without caller credentials or arbitrary headers', async t => {
  const { port, seen } = await fixture(t, ok);
  const result = await request(port, '/__ups/state?ignored=1', { headers: {
    cookie: 'private', authorization: 'secret', 'x-arbitrary': 'secret', origin: 'http://evil.example' } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true });
  assert.match(result.headers['content-type'], /application\/json/);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(seen[0].url, '/state');
  assert.equal(seen[0].headers.origin, 'http://localhost:8765');
  assert.equal(seen[0].headers['x-lost-ups'], '1');
  for (const header of ['cookie', 'authorization', 'x-arbitrary']) assert.equal(seen[0].headers[header], undefined);
});

test('both mutation routes forward bounded JSON with the fixed upstream origin', async t => {
  const { port, seen } = await fixture(t, ok, { origin: 'http://127.0.0.1:9999' });
  for (const [route, origin] of [['variable', 'http://localhost:9999'], ['beeper', 'http://127.0.0.1:9999']]) {
    const result = await request(port, `/__ups/${route}`, { method: 'POST', headers: { ...writeHeaders, origin }, body: '{"value":"test"}' });
    assert.equal(result.status, 200);
  }
  assert.deepEqual(seen.map(r => r.url), ['/variable', '/beeper']);
  assert.ok(seen.every(r => r.method === 'POST' && r.headers.origin === 'http://127.0.0.1:9999'));
  assert.deepEqual(JSON.parse(seen[0].body), { value: 'test' });
});

test('rejects missing/foreign origins, incorrect port, and missing write header', async t => {
  const { port, seen } = await fixture(t, ok);
  for (const origin of [undefined, 'null', 'http://evil.example', 'http://localhost:8766', 'https://localhost:8765', 'http://localhost:8765/']) {
    const headers = { ...writeHeaders };
    if (origin === undefined) delete headers.origin; else headers.origin = origin;
    assert.equal((await request(port, '/__ups/beeper', { method: 'POST', headers, body: '{}' })).status, 403);
  }
  const headers = { ...writeHeaders }; delete headers['x-lost-ups'];
  assert.equal((await request(port, '/__ups/beeper', { method: 'POST', headers, body: '{}' })).status, 403);
  assert.equal(seen.length, 0);
});

test('route and method allowlists prevent policy access and unexpected methods', async t => {
  const { port, seen } = await fixture(t, ok);
  for (const [path, method, allow] of [['state', 'POST', 'GET'], ['variable', 'GET', 'POST'], ['beeper', 'OPTIONS', 'POST']]) {
    const response = await request(port, `/__ups/${path}`, { method });
    assert.equal(response.status, 405); assert.equal(response.headers.allow, allow);
  }
  assert.equal((await request(port, '/__ups/policy')).status, 404);
  assert.equal(seen.length, 0);
});

test('rejects invalid JSON, non-object bodies, oversized bodies and wrong content types', async t => {
  const { port, seen } = await fixture(t, ok, { maxBodyBytes: 20 });
  for (const body of ['', '{', 'null', '[]', '42']) {
    assert.equal((await request(port, '/__ups/variable', { method: 'POST', headers: writeHeaders, body })).status, 400);
  }
  assert.equal((await request(port, '/__ups/variable', { method: 'POST', headers: writeHeaders, body: '{"x":"12345678901234567890"}' })).status, 413);
  assert.equal((await request(port, '/__ups/variable', { method: 'POST', headers: { ...writeHeaders, 'content-type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal(seen.length, 0);
});

test('upstream timeout is a sanitized 504', async t => {
  const { port } = await fixture(t, () => {}, { timeoutMs: 30 });
  const result = await request(port, '/__ups/state');
  assert.equal(result.status, 504);
  assert.deepEqual(result.body, { error: 'UPS agent timed out' });
});

test('unavailable upstream is a sanitized 503', async t => {
  const temporary = http.createServer();
  const unusedPort = await listen(temporary); await close(temporary);
  const handler = createUPSGateway({ port: unusedPort });
  const core = http.createServer((req, res) => handler(req, res, '/__ups/state'));
  const port = await listen(core); t.after(() => close(core));
  const result = await request(port, '/__ups/state');
  assert.equal(result.status, 503);
  assert.deepEqual(result.body, { error: 'UPS agent unavailable' });
});

test('non-JSON upstream error never exposes raw exception text', async t => {
  const { port } = await fixture(t, (_req, res) => { res.statusCode = 500; res.end('private traceback secret'); });
  const result = await request(port, '/__ups/state');
  assert.equal(result.status, 502);
  assert.deepEqual(result.body, { error: 'Invalid UPS agent response' });
});

test('configuration cannot target a non-loopback upstream or origin', () => {
  assert.throws(() => createUPSGateway({ upstreamHost: 'evil.example' }));
  assert.throws(() => createUPSGateway({ origin: 'http://evil.example:8765' }));
  assert.throws(() => createUPSGateway({ origin: 'http://localhost:8765/path' }));
});
