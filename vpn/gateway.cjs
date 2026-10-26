'use strict';
function createVPNGateway({ vpn, port }) {
    const reply = (res, code, data) => { if (res.destroyed || res.writableEnded) return; res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); };
    return function handle(req, res, route) {
        if (route !== '/__vpn' && !route.startsWith('/__vpn/')) return false;
        const p = typeof port === 'function' ? port() : port;
        const hosts = new Set(['localhost:' + p, '127.0.0.1:' + p]);
        const origins = new Set([...hosts].map(x => 'http://' + x));
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) || !hosts.has(req.headers.host) || req.headers.origin && !origins.has(req.headers.origin)) { req.resume(); reply(res, 403, { error: 'forbidden' }); return true; }
        if (route === '/__vpn/state') {
            if (req.method !== 'GET') { req.resume(); reply(res, 405, { error: 'method_not_allowed' }); return true; }
            reply(res, 200, vpn.snapshot()); return true;
        }
        if (route !== '/__vpn/command') { req.resume(); reply(res, 404, { error: 'not_found' }); return true; }
        if (req.method !== 'POST') { req.resume(); reply(res, 405, { error: 'method_not_allowed' }); return true; }
        if (!origins.has(req.headers.origin) || req.headers['x-lost-vpn'] !== '1' || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) { req.resume(); reply(res, 403, { error: 'invalid_request' }); return true; }
        if (!vpn.snapshot().enabled) { req.resume(); reply(res, 503, { error: 'disabled' }); return true; }
        let size = 0, chunks = [], done = false;
        const finish = (code, data) => { if (done) return; done = true; clearTimeout(timer); req.resume(); reply(res, code, data); };
        const timer = setTimeout(() => finish(408, { error: 'request_timeout' }), 4000);
        req.on('data', chunk => { if (done) return; size += chunk.length; if (size > 4096) return finish(413, { error: 'too_large' }); chunks.push(chunk); });
        req.on('aborted', () => { done = true; clearTimeout(timer); });
        req.on('error', () => finish(400, { error: 'invalid_body' }));
        req.on('end', async () => {
            if (done) return;
            clearTimeout(timer); let data;
            try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.action !== 'string') throw Error(); }
            catch (_) { return finish(400, { error: 'invalid_body' }); }
            try { const result = await vpn.execute(data.action, data.value); finish(result.ok ? 200 : result.error === 'busy' ? 409 : ['invalid_action', 'invalid_value'].includes(result.error) ? 400 : 503, result); }
            catch (_) { finish(503, { error: 'router_unavailable' }); }
        });
        return true;
    };
}
module.exports = { createVPNGateway };
