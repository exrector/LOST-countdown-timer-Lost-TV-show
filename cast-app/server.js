const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const events = new EventEmitter();

const _log = console.log;
console.log = (...a) => _log(new Date().toTimeString().slice(0, 8), ...a);

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

function start(port = 8765, opts = {}) {
    const stage = opts.stage || { width: 1560, height: 720 };
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        let p = decodeURIComponent(url.pathname);
        if (p === '/') p = '/index.html';
        if (p === '/__ping') { res.writeHead(200); return res.end('ok'); }
        if (p === '/__quit') { res.writeHead(200); res.end('bye'); setTimeout(() => events.emit('quit'), 100); return; }
        // «Фокус: Сон» с iPhone (Команды → «Получить содержимое URL»): /__sleep?on=1 — пауза, /__sleep?on=0 — продолжить
        if (p === '/__sleep') {
            setSleep(url.searchParams.get('on') === '1', 'запрос с iPhone');
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end(sleepOn ? 'LOST: сон, пауза' : 'LOST: работает');
        }
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
                .replace('</head>', `<script>window.__LOST_STAGE=${JSON.stringify({ w: stage.width, h: stage.height })}</script><script src="/__bridge.js"></script></head>`));
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(body);
    });

    const wss = new WebSocketServer({ noServer: true });
    const peers = { tv: new Set(), console: new Set() };
    const stateFile = path.join(__dirname, '.state.json');
    let audioMode = opts.audioDefault || 'mac';
    try { audioMode = JSON.parse(fs.readFileSync(stateFile, 'utf8')).audio || audioMode; } catch (_) {}
    // Физический выход звука (динамики Мака / монитор по HDMI) переключает macOS-помощник bin/lost-audio
    const AUDIO_BIN = path.join(__dirname, 'bin', 'lost-audio');
    function applyAudioDevice(mode) {
        const args = mode === 'monitor' ? ['set', 'display', opts.display || ''] : mode === 'speakers' ? ['set', 'builtin'] : null;
        if (!args || !fs.existsSync(AUDIO_BIN)) return;
        execFile(AUDIO_BIN, args.filter(Boolean), (e, out, err) => {
            if (e) console.log('[audio] не удалось переключить (' + mode + '):', (err || e.message).trim());
            else { try { console.log('[audio] выход звука:', JSON.parse(out).name); } catch (_) {} }
        });
    }
    if (audioMode !== 'monitor' && audioMode !== 'off') audioMode = 'speakers'; // прежние значения (on/tv/mac) = динамики Мака
    applyAudioDevice(audioMode);
    const audioMsg = () => JSON.stringify({ type: '__audio', mode: audioMode });
    const last = {}; // последние enableConsole/__state от ТВ — чтобы новая консоль сразу их получила
    let sleepOn = false; // состояние «Сна» — заново отправляется таймеру после перезагрузки его страницы
    const sleepMsg = () => JSON.stringify({ type: '__cmd', cmd: 'sleep', on: sleepOn });
    function setSleep(on, source) {
        sleepOn = on;
        console.log(`[сон] ${on ? 'включён — пауза таймера' : 'выключен — таймер продолжает'} (${source})`);
        for (const o of peers.tv) if (o.readyState === 1) o.send(sleepMsg());
    }
    // «Сон» через iMessage: автоматизация iPhone по фокусу «Сон» шлёт сообщение на Apple ID этого Мака.
    // LOST читает новые входящие из базы «Сообщений» (нужен «Полный доступ к диску» для LOST.app) раз в 10 с,
    // только от разрешённых отправителей (config.json → sleepFrom). Работает, где бы ни был iPhone.
    // «Сон» — пауза; «Подъём» / «Проснулся» / «Утро» / «Сон выкл» — продолжить. Запрос /__sleep тоже работает.
    if (opts.sleepFrom && opts.sleepFrom.length) {
        const db = path.join(os.homedir(), 'Library/Messages/chat.db');
        const from = opts.sleepFrom.map(x => "'" + String(x).replace(/'/g, '') + "'").join(',');
        const parse = t => {
            t = String(t || '').toLowerCase();
            if (/(выкл|проснул|подъ[её]м|утро|встал)/.test(t)) return false;
            if (/сон|спать|сплю/.test(t)) return true;
            return null;
        };
        let lastId = null, warned = false;
        const check = () => {
            const q = lastId === null ? 'select max(ROWID) from message;'
                : `select m.ROWID, m.text from message m join handle h on h.ROWID = m.handle_id where m.ROWID > ${lastId} and m.is_from_me = 0 and h.id in (${from}) order by m.ROWID;`;
            execFile('/usr/bin/sqlite3', ['-readonly', '-separator', '\t', db, q], (e, out) => {
                if (e) { if (!warned) console.log('[сон] не читается база «Сообщений» — дайте LOST.app «Полный доступ к диску»:', (e.message || '').split('\n')[0]); warned = true; return; }
                if (warned) { console.log('[сон] доступ к «Сообщениям» есть'); warned = false; }
                if (lastId === null) { lastId = parseInt(out) || 0; return; } // старые сообщения не трогаем
                for (const line of out.split('\n').filter(Boolean)) {
                    const [id, ...rest] = line.split('\t'); lastId = Math.max(lastId, parseInt(id));
                    const on = parse(rest.join('\t'));
                    if (on !== null) setSleep(on, 'iMessage: «' + rest.join(' ').trim() + '»');
                }
            });
        };
        console.log('[сон] жду iMessage от:', opts.sleepFrom.join(', '));
        check(); setInterval(check, 10000);
    }

    server.on('upgrade', (req, sock, head) => {
        const role = new URL(req.url, 'http://x').searchParams.get('role');
        if (!peers[role]) return sock.destroy();
        wss.handleUpgrade(req, sock, head, ws => {
            peers[role].add(ws);
            console.log(`[bridge] ${role} connected (tv=${peers.tv.size}, console=${peers.console.size})`);
            ws.send(audioMsg());
            if (role === 'console') Object.values(last).forEach(m => ws.send(m));
            if (role === 'tv' && sleepOn) ws.send(sleepMsg());
            ws.on('message', m => {
                const s = m.toString();
                if (s.indexOf('"cmd":"quit"') !== -1) { events.emit('quit'); return; }
                if (s.indexOf('"__audio"') !== -1) {
                    audioMode = JSON.parse(s).mode;
                    applyAudioDevice(audioMode);
                    try { fs.writeFileSync(stateFile, JSON.stringify({ audio: audioMode })); } catch (_) {}
                    for (const set of Object.values(peers)) for (const o of set) if (o.readyState === 1) o.send(audioMsg());
                    return;
                }
                if (s.indexOf('"__alive"') !== -1) { events.emit('tv-alive', JSON.parse(s)); return; }
                if (s.indexOf('"__log"') !== -1) { console.log('[' + role + ' log]', JSON.parse(s).msg); return; }
                const to = role === 'tv' ? 'console' : 'tv';
                if (role === 'tv') { if (s.indexOf('enableConsole') !== -1) last.enable = s; else if (s.indexOf('"__state"') !== -1) last.state = s; }
                for (const o of peers[to]) if (o.readyState === 1) o.send(s);
            });
            events.emit('peers', { tv: peers.tv.size, console: peers.console.size });
            ws.on('close', () => { peers[role].delete(ws); events.emit('peers', { tv: peers.tv.size, console: peers.console.size }); console.log(`[bridge] ${role} left`); });
        });
    });

    return new Promise(resolve => server.listen(port, '0.0.0.0', () => {
        const ip = lanIp();
        console.log(`LOST server: http://${ip}:${port}/index.html  |  console: http://localhost:${port}/console.html`);
        resolve({ server, port, ip });
    }));
}

module.exports = { start, lanIp, events };
if (require.main === module) start(parseInt(process.env.PORT) || 8765);
