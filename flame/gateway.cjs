'use strict';
// Состояние «Пламени» — только для самой станции (loopback и свой Host), только чтение.
function createFlameGateway({ flame, port }) {
    const reply = (res, code, data) => { if (res.destroyed || res.writableEnded) return; res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); };
    return function handle(req, res, route) {
        if (route !== '/__flame' && !route.startsWith('/__flame/')) return false;
        const p = typeof port === 'function' ? port() : port;
        const hosts = new Set(['localhost:' + p, '127.0.0.1:' + p]);
        const origins = new Set([...hosts].map(x => 'http://' + x));
        req.resume();
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) || !hosts.has(req.headers.host) || req.headers.origin && !origins.has(req.headers.origin)) { reply(res, 403, { error: 'forbidden' }); return true; }
        if (route !== '/__flame/state') { reply(res, 404, { error: 'not_found' }); return true; }
        if (req.method !== 'GET') { reply(res, 405, { error: 'method_not_allowed' }); return true; }
        const wanted = new URL(req.url, 'http://x').searchParams.get('refresh') === '1';
        Promise.resolve(wanted ? flame.refresh() : flame.snapshot()).then(data => reply(res, 200, data), () => reply(res, 503, { error: 'unavailable' }));
        return true;
    };
}
module.exports = { createFlameGateway };
