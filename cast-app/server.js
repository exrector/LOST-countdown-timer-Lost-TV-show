const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const ROOT = path.resolve(__dirname, '..');          // исходные index.html / console.html / css / js / assets
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
    '.png': 'image/png', '.mp3': 'audio/mpeg', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

function lanIp() {
    const priv = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/;
    for (const [name, list] of Object.entries(os.networkInterfaces()))
        if (!/^(utun|awdl|llw|bridge|lo)/.test(name))
            for (const i of list) if (i.family === 'IPv4' && !i.internal && priv.test(i.address)) return i.address;
    return '127.0.0.1';
}

function start(port = 8765) {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        let p = decodeURIComponent(url.pathname);
        if (p === '/') p = '/index.html';
        if (p === '/__jquery.js') { res.writeHead(200, { 'Content-Type': TYPES['.js'] }); return res.end(fs.readFileSync(path.join(__dirname, 'vendor', 'jquery-3.5.1.min.js'))); }
        if (p === '/__bridge.js') { res.writeHead(200, { 'Content-Type': TYPES['.js'] }); return res.end(fs.readFileSync(path.join(__dirname, 'bridge.js'))); }
        const file = path.join(ROOT, p);
        if (!file.startsWith(ROOT) || p.startsWith('/cast-app') || p.startsWith('/.git') || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            res.writeHead(404); return res.end('not found');
        }
        let body = fs.readFileSync(file);
        if (p === '/index.html' || p === '/console.html')
            body = Buffer.from(body.toString()
                .replace(/https:\/\/ajax\.googleapis\.com\/ajax\/libs\/jquery\/[\d.]+\/jquery\.min\.js/, '/__jquery.js')
                .replace('</head>', '<script src="/__bridge.js"></script></head>'));
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(body);
    });

    const wss = new WebSocketServer({ noServer: true });
    const peers = { tv: new Set(), console: new Set() };
    const last = {}; // последние enableConsole/__state от ТВ — чтобы новая консоль сразу их получила

    server.on('upgrade', (req, sock, head) => {
        const role = new URL(req.url, 'http://x').searchParams.get('role');
        if (!peers[role]) return sock.destroy();
        wss.handleUpgrade(req, sock, head, ws => {
            peers[role].add(ws);
            console.log(`[bridge] ${role} connected (tv=${peers.tv.size}, console=${peers.console.size})`);
            if (role === 'console') Object.values(last).forEach(m => ws.send(m));
            ws.on('message', m => {
                const s = m.toString();
                if (s.indexOf('"__log"') !== -1) { console.log('[' + role + ' log]', JSON.parse(s).msg); return; }
                const to = role === 'tv' ? 'console' : 'tv';
                if (role === 'tv') { if (s.indexOf('enableConsole') !== -1) last.enable = s; else if (s.indexOf('"__state"') !== -1) last.state = s; }
                for (const o of peers[to]) if (o.readyState === 1) o.send(s);
            });
            ws.on('close', () => { peers[role].delete(ws); console.log(`[bridge] ${role} left`); });
        });
    });

    return new Promise(resolve => server.listen(port, '0.0.0.0', () => {
        const ip = lanIp();
        console.log(`LOST server: http://${ip}:${port}/index.html  |  console: http://localhost:${port}/console.html`);
        resolve({ server, port, ip });
    }));
}

module.exports = { start, lanIp };
if (require.main === module) start(parseInt(process.env.PORT) || 8765);
