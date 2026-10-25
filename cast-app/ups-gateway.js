'use strict';

const http = require('node:http');

/** A same-origin, route- and method-restricted bridge to the local UPS agent. */
function createUPSGateway({
  port = 8766,
  origin = 'http://localhost:8765',
  timeoutMs = 6000,
  maxBodyBytes = 16384,
  upstreamHost = '127.0.0.1',
} = {}) {
  const core = new URL(origin);
  if (core.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(core.hostname) ||
      core.username || core.password || core.pathname !== '/' || core.search || core.hash) {
    throw new TypeError('The core origin must be a loopback HTTP origin');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535 ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 ||
      !Number.isInteger(maxBodyBytes) || maxBodyBytes < 1 ||
      !['localhost', '127.0.0.1', '::1'].includes(upstreamHost)) {
    throw new TypeError('Invalid UPS gateway configuration');
  }
  const corePort = core.port || '80';
  const allowedOrigins = new Set(['localhost', '127.0.0.1'].map(host =>
    `http://${host}${corePort === '80' ? '' : `:${corePort}`}`));
  const routes = new Map([
    ['/__ups/state', { method: 'GET', path: '/state' }],
    ['/__ups/variable', { method: 'POST', path: '/variable' }],
    ['/__ups/beeper', { method: 'POST', path: '/beeper' }],
  ]);

  function reply(res, status, payload, headers = {}) {
    if (res.destroyed || res.writableEnded) return;
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    });
    res.end(body);
  }

  async function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      let complete = false;
      const finish = (error, body) => {
        if (complete) return;
        complete = true;
        clearTimeout(timer);
        req.removeListener('data', onData);
        req.removeListener('end', onEnd);
        req.removeListener('aborted', onAbort);
        req.removeListener('error', onAbort);
        if (error) {
          // An aborted upload can emit an error after its aborted event.
          req.once('error', () => {});
          req.resume();
          reject(error);
        } else resolve(body);
      };
      const onData = chunk => {
        size += chunk.length;
        if (size > maxBodyBytes) finish(413);
        else chunks.push(chunk);
      };
      const onEnd = () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (body === null || typeof body !== 'object' || Array.isArray(body)) return finish(400);
          finish(null, Buffer.from(JSON.stringify(body)));
        } catch { finish(400); }
      };
      const onAbort = () => finish(400);
      const timer = setTimeout(() => finish(408), timeoutMs);
      req.on('data', onData);
      req.on('end', onEnd);
      req.on('aborted', onAbort);
      req.on('error', onAbort);
    });
  }

  function proxy(req, res, route, body) {
    let finished = false;
    let upstream;
    const finish = (status, payload) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reply(res, status, payload);
    };
    const timer = setTimeout(() => {
      finish(504, { error: 'UPS agent timed out' });
      upstream?.destroy();
    }, timeoutMs);
    upstream = http.request({
      hostname: upstreamHost,
      port,
      path: route.path,
      method: route.method,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-LOST-UPS': '1',
        'Origin': core.origin,
        ...(body ? { 'Content-Length': body.length } : {}),
      },
    }, response => {
      let size = 0;
      const chunks = [];
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          finish(502, { error: 'Invalid UPS agent response' });
          response.destroy();
        } else chunks.push(chunk);
      });
      response.on('error', () => finish(503, { error: 'UPS agent unavailable' }));
      response.on('aborted', () => finish(503, { error: 'UPS agent unavailable' }));
      response.on('end', () => {
        if (finished) return;
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          finish(response.statusCode || 502, payload);
        } catch { finish(502, { error: 'Invalid UPS agent response' }); }
      });
    });
    upstream.on('error', () => finish(503, { error: 'UPS agent unavailable' }));
    res.once('close', () => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        upstream.destroy();
      }
    });
    upstream.end(body);
  }

  return function handleUPSGateway(req, res, pathname) {
    const route = routes.get(pathname);
    if (!route) return false;
    if (req.method !== route.method) {
      req.resume();
      reply(res, 405, { error: 'Method not allowed' }, { Allow: route.method });
      return true;
    }
    if (route.method === 'GET') {
      proxy(req, res, route);
      return true;
    }
    if (!allowedOrigins.has(req.headers.origin) || req.headers['x-lost-ups'] !== '1') {
      req.resume();
      reply(res, 403, { error: 'UPS write request rejected' });
      return true;
    }
    if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] || '')) {
      req.resume();
      reply(res, 415, { error: 'JSON content type required' });
      return true;
    }
    readBody(req).then(body => proxy(req, res, route, body), status => {
      reply(res, status, { error: status === 413 ? 'Request body too large' :
        status === 408 ? 'Request body timed out' : 'Invalid JSON request' });
    });
    return true;
  };
}

module.exports = { createUPSGateway };
