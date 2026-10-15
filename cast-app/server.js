const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const { EventEmitter } = require('events');
const { execFile, execFileSync } = require('child_process');
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
            setSleep(url.searchParams.get('on') === '1', 'запрос по сети');
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end(sleepOn ? 'LOST: сон, пауза' : 'LOST: работает');
        }
        // тот же пульт, что и по iMessage, но по локальной сети: /__cmd?text=Пауза — ответ тем же текстом, что пришёл бы сообщением
        if (p === '/__cmd') {
            const answer = runRemote(url.searchParams.get('text') || '', 'сеть');
            setTimeout(() => { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(answer ? answer + ' ' + statusText() : statusText()); }, 1500);
            return;
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
                .replace('</head>', `<script>window.__LOST_STAGE=${JSON.stringify({ w: stage.width, h: stage.height })};window.__LOST_RESUME=${JSON.stringify({ left: curLeft > 0 ? curLeft : null, paused: curPaused })}</script><script src="/__bridge.js"></script></head>`));
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(body);
    });

    const wss = new WebSocketServer({ noServer: true });
    const peers = { tv: new Set(), console: new Set() };
    const stateFile = path.join(__dirname, '.state.json');
    let audioMode = opts.audioDefault || 'mac';
    let saved = {}; try { saved = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (_) {}
    audioMode = saved.audio || audioMode;
    // Где остановился таймер: продолжаем с того же места после перезапуска LOST и при переключении Dev/Live.
    // Время, пока LOST выключен, не идёт. Если таймер дошёл до нуля — следующий запуск с начала (108 мин).
    let curLeft = saved.left > 0 ? saved.left : null, curPaused = !!saved.paused, savedAt = 0;
    function saveState() {
        savedAt = Date.now();
        try { fs.writeFileSync(stateFile, JSON.stringify({ audio: audioMode, left: curLeft, paused: curPaused })); } catch (_) {}
    }
    process.on('exit', saveState); // при выходе — точное место, а не 10-секундной давности
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
    let sleepOn = false; // последняя удалённая команда паузы — заново отправляется таймеру после перезагрузки его страницы
    const sleepMsg = () => JSON.stringify({ type: '__cmd', cmd: 'sleep', on: sleepOn });
    function setSleep(on, source) {
        sleepOn = on;
        console.log(`[пульт] ${on ? 'пауза' : 'старт'} (${source})`);
        for (const o of peers.tv) if (o.readyState === 1) o.send(sleepMsg());
    }
    function setAudio(mode) {
        audioMode = mode;
        applyAudioDevice(audioMode);
        saveState();
        for (const set of Object.values(peers)) for (const o of set) if (o.readyState === 1) o.send(audioMsg());
    }
    // Что сейчас с таймером: оставшееся время приходит от таймера каждую секунду (enableConsole), пауза — по подписи кнопки
    function timerInfo() {
        let left = null, open = false, paused = false;
        try { const e = JSON.parse(last.enable); left = e.remainingTime; open = !!e.enabled; } catch (_) {}
        try { paused = /Старт/.test(JSON.parse(last.state).label); } catch (_) {}
        return { left, open, paused };
    }
    function statusText() {
        const t = timerInfo(), L = t.left;
        const left = L == null ? '?' : L > 240 ? Math.ceil(L / 60) + ' мин' : Math.floor(L / 60) + ':' + String(L % 60).padStart(2, '0');
        const snd = { speakers: 'динамики', monitor: 'монитор', off: 'выкл' }[audioMode] || audioMode;
        return `LOST: ${t.paused ? 'пауза' : 'идёт'}, осталось ${left}${t.open ? ' — можно вводить код' : ''}. Звук: ${snd}.`;
    }

    // ===== Удалённый пульт через iMessage =====
    // Сообщения на Apple ID этого Мака от разрешённых номеров (config.json → sleepFrom) читаются из базы «Сообщений»
    // раз в 10 с и выполняются как команды; на каждую LOST отвечает сообщением со своим состоянием.
    // Выход и Dev Mode по сообщению намеренно недоступны (удалённо их не отменить, Dev Mode перезапускает таймер).
    const HELP = 'Команды: Пауза/Сон, Старт/Утро, Звук, Звук выкл, Динамики, Монитор, Статус, код 4 8 15 16 23 42 — или точное название команды из «Команд» Mac mini.';
    function runRemote(text, via, sender) {
        const t = String(text || '').trim().toLowerCase().replace(/ё/g, 'е');
        if (/^[\d\s]+$/.test(t) && /\d/.test(t)) {
            const code = t.split(/\s+/).filter(Boolean).join(' ');
            if (!timerInfo().open) return 'Код не принят: терминал открывается только в последние 4 минуты.';
            const msg = JSON.stringify({ type: 'numberSubmitted', value: code });
            for (const o of peers.tv) if (o.readyState === 1) o.send(msg);
            console.log('[пульт] код:', code);
            return 'Код отправлен.';
        }
        // Своя команда из «Команд» этого Мака: текст сообщения точно совпадает с её названием (без учёта регистра).
        // Так любое слово с iPhone может запустить что угодно в системе — достаточно создать команду с таким именем.
        const sc = findShortcut(text);
        if (sc) {
            console.log('[пульт] запускаю команду «' + sc + '» (' + via + ')');
            execFile('shortcuts', ['run', sc], { timeout: 120000 }, (e, out) => {
                const res = e ? 'ошибка: ' + (e.message || '').split('\n')[0] : (String(out || '').trim() || 'готово');
                console.log('[пульт] команда «' + sc + '»: ' + res);
                if (sender) reply(sender, 'Команда «' + sc + '»: ' + res.slice(0, 500));
            });
            return 'Запускаю команду «' + sc + '».';
        }
        if (/^(статус|status|\?)/.test(t)) return '';
        if (/звук выкл|без звука|тихо|mute/.test(t)) { setAudio('off'); return ''; }
        if (/динамик/.test(t)) { setAudio('speakers'); return ''; }
        if (/монитор|hdmi/.test(t)) { setAudio('monitor'); return ''; }
        if (/^звук/.test(t)) { setAudio({ speakers: 'monitor', monitor: 'off', off: 'speakers' }[audioMode] || 'speakers'); return ''; }
        if (/(выкл|проснул|подъем|утро|встал|старт|пуск|продолж|play)/.test(t)) { setSleep(false, via + ' «' + text.trim() + '»'); return ''; }
        if (/(пауза|сон|спать|сплю|стоп|pause)/.test(t)) { setSleep(true, via + ' «' + text.trim() + '»'); return ''; }
        return 'Не понял «' + text.trim() + '». ' + HELP;
    }
    // Названия команд из «Команд» этого Мака (обновляются раз в минуту)
    let shortcutNames = [], shortcutsAt = 0;
    function findShortcut(text) {
        if (Date.now() - shortcutsAt > 60000) {
            try { shortcutNames = execFileSync('shortcuts', ['list'], { encoding: 'utf8', timeout: 10000 }).split('\n').map(x => x.trim()).filter(Boolean); } catch (_) {}
            shortcutsAt = Date.now();
        }
        const want = String(text || '').trim().toLowerCase();
        return shortcutNames.find(n => n.toLowerCase() === want) || null;
    }
    // Ответ через «Сообщения» на этом Маке (при первой отправке macOS спросит разрешение на управление «Сообщениями»)
    function reply(to, text) {
        const script = 'on run argv\n tell application "Messages"\n set s to 1st account whose service type = iMessage\n' +
            ' send (item 2 of argv) to participant (item 1 of argv) of s\n end tell\nend run';
        execFile('osascript', ['-e', script, to, text], e => { if (e) console.log('[пульт] ответ не отправлен:', (e.message || '').split('\n')[0]); });
    }
    if (opts.sleepFrom && opts.sleepFrom.length) {
        const db = path.join(os.homedir(), 'Library/Messages/chat.db');
        const from = opts.sleepFrom.map(x => "'" + String(x).replace(/'/g, '') + "'").join(',');
        let lastId = null, warned = false;
        const check = () => {
            const q = lastId === null ? 'select max(ROWID) from message;'
                : `select m.ROWID, h.id, m.text from message m join handle h on h.ROWID = m.handle_id where m.ROWID > ${lastId} and m.is_from_me = 0 and h.id in (${from}) order by m.ROWID;`;
            execFile('/usr/bin/sqlite3', ['-readonly', '-separator', '\t', db, q], (e, out) => {
                if (e) { if (!warned) console.log('[пульт] не читается база «Сообщений» — дайте LOST.app «Полный доступ к диску»:', (e.message || '').split('\n')[0]); warned = true; return; }
                if (warned) { console.log('[пульт] доступ к «Сообщениям» есть'); warned = false; }
                if (lastId === null) { lastId = parseInt(out) || 0; return; } // старые сообщения не трогаем
                for (const line of out.split('\n').filter(Boolean)) {
                    const [id, sender, ...rest] = line.split('\t'); lastId = Math.max(lastId, parseInt(id));
                    const answer = runRemote(rest.join(' '), 'iMessage', sender);
                    // ответ — после того, как таймер успеет отработать команду и прислать новое состояние
                    setTimeout(() => reply(sender, answer ? answer + ' ' + statusText() : statusText()), 1500);
                }
            });
        };
        console.log('[пульт] жду iMessage от:', opts.sleepFrom.join(', '));
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
            ws.on('message', m => {
                const s = m.toString();
                if (s.indexOf('"cmd":"quit"') !== -1) { events.emit('quit'); return; }
                if (s.indexOf('"__audio"') !== -1) { setAudio(JSON.parse(s).mode); return; }
                if (s.indexOf('"__alive"') !== -1) { events.emit('tv-alive', JSON.parse(s)); return; }
                if (s.indexOf('"__log"') !== -1) { console.log('[' + role + ' log]', JSON.parse(s).msg); return; }
                const to = role === 'tv' ? 'console' : 'tv';
                if (role === 'tv') {
                    if (s.indexOf('enableConsole') !== -1) {
                        last.enable = s;
                        try { curLeft = JSON.parse(s).remainingTime; } catch (_) {}
                        if (Date.now() - savedAt > 10000 || curLeft <= 0) saveState();
                    } else if (s.indexOf('"__state"') !== -1) {
                        last.state = s;
                        try { const p = /Старт/.test(JSON.parse(s).label); if (p !== curPaused) { curPaused = p; saveState(); } } catch (_) {}
                    }
                }
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
