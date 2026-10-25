const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const events = new EventEmitter();
const { loadState, writeState } = require('./state-store');
const { StationClock } = require('./clock');
const timeline = require('../js/lost-timeline');
const { createModules } = require('./modules');
const { createUPSGateway } = require('./ups-gateway');
const { createMuseGateway } = require('../muse/gateway.cjs');

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
    let clockTimer;
    const stage = opts.stage || { width: 1560, height: 720 };
    const upsGateway = createUPSGateway({ port: opts.upsPort || 8766, origin: 'http://localhost:' + port });
    const museGateway=createMuseGateway({port:()=>server.address()?.port || port, getModule:()=>moduleManager.snapshot().muse, getChat:opts.getMuseChat, sendMessage:opts.sendMuseMessage, preview:opts.musePreview===true});
    const server = http.createServer((req, res) => {
        syncClock();
        const url = new URL(req.url, 'http://x');
        let p = decodeURIComponent(url.pathname);
        if (museGateway(req,res,p)) return;
        if (p === '/') p = '/index.html';
        if ((p === '/__ups' || p.startsWith('/__ups/')) && !moduleManager.desired().ups) {
            req.resume(); res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            return res.end(JSON.stringify({ error: 'module_disabled' }));
        }
        if (upsGateway(req, res, p)) return;
        if (p === '/__health') {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            return res.end(JSON.stringify({ core: { status: 'ready', uptime: Math.floor(process.uptime()), pid: process.pid }, timer: { mode: curMode, left: curLeft, paused: curPaused }, clocks: clock.snapshot(), modules: moduleManager.snapshot(), components: opts.getRuntimeStatus ? opts.getRuntimeStatus() : {} }));
        }
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
        if (p === '/__journal') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(journalTail(Math.min(200, parseInt(url.searchParams.get('lines')) || 16))); }
        if (p === '/__jquery.js') { res.writeHead(200, { 'Content-Type': TYPES['.js'] }); return res.end(fs.readFileSync(path.join(__dirname, 'vendor', 'jquery-3.5.1.min.js'))); }
        if (p === '/__bridge.js') { res.writeHead(200, { 'Content-Type': TYPES['.js'] }); return res.end(fs.readFileSync(path.join(__dirname, 'bridge.js'))); }
        const file = path.join(ROOT, p);
        if (!file.startsWith(ROOT) || p.startsWith('/cast-app') || p.startsWith('/.git') || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            res.writeHead(404); return res.end('not found');
        }
        let body = fs.readFileSync(file);
        if (p === '/index.html') {
            if (!url.searchParams.has('mode')) { url.searchParams.set('mode', curMode); res.writeHead(302, { Location: '/index.html?' + url.searchParams.toString(), 'Cache-Control': 'no-store' }); return res.end(); }
            switchMode(url.searchParams.get('mode') === 'dev' ? 'dev' : 'live');
            const requested = Number(url.searchParams.get('seconds'));
            if (curMode === 'dev' && url.searchParams.has('seconds') && [10,60,240,6480].includes(requested)) { clock.reset(requested); saveState(); publishClock(); }
        }
        if (p === '/index.html' || p === '/console.html')
            body = Buffer.from(body.toString()
                .replace(/https:\/\/ajax\.googleapis\.com\/ajax\/libs\/jquery\/[\d.]+\/jquery\.min\.js/, '/__jquery.js')
                .replace('</head>', `<script>window.__LOST_MODULES=${JSON.stringify(moduleManager.snapshot())};window.__LOST_CLOCK=${JSON.stringify(clock.sample())};window.__LOST_STAGE=${JSON.stringify({ w: stage.width, h: stage.height, scale: stage.scale || 1 })};window.__LOST_RESUME=${JSON.stringify({ left: curLeft > 0 ? curLeft : null, paused: curPaused })}</script><script src="/__bridge.js"></script></head>`));
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(body);
    });

    const wss = new WebSocketServer({ noServer: true });
    const peers = { tv: new Set(), console: new Set() };
    const stateFile = opts.stateFile || path.join(__dirname, '.state.json');
    let audioMode = opts.audioDefault || 'mac';
    const saved = loadState(stateFile);
    const moduleManager = createModules({ saved: saved.modules, persist: saveState, apply: opts.applyModule, installed: opts.moduleInstalled,
        publish: modules => { const msg = JSON.stringify({ type: '__modules', modules }); for (const set of Object.values(peers)) for (const ws of set) if (ws.readyState === 1) ws.send(msg); } });
    audioMode = saved.audio || audioMode;
    // Где остановился таймер: продолжаем с того же места после перезапуска LOST и при переключении Dev/Live.
    // Downtime is excluded; failure phase and both independent slots resume atomically.
    // У Live и Dev — свои таймеры: уходя в Dev, Live замораживается на своём месте и при возврате продолжает с него.
    const clock = new StationClock(saved, { ...(opts.clockNow ? { now: opts.clockNow } : {}), liveInDev: opts.liveInDev === true });
    let curMode, curLeft, curPaused, savedAt = 0;
    function syncClock() { const s = clock.sample(); curMode = s.mode; curLeft = s.left; curPaused = s.paused; return s; }
    syncClock();
    function saveState() {
        savedAt = Date.now(); syncClock();
        return writeState(stateFile, { audio: audioMode, ...clock.snapshot(), modules: moduleManager.desired() });
    }
    function switchMode(mode) {
        if (mode === clock.mode) return;
        clock.setMode(mode); syncClock();
        if (typeof journalFailure === 'function') journalFailure(false);
        sleepOn = curPaused;
        delete last.enable; delete last.state;
        saveState();
        console.log('[режим]', mode, ':', curLeft, 'с; пауза:', curPaused);
        publishClock();
    }
    // The exit hook is registered only after this process owns the listening socket.
    // process.on('exit', saveState); // при выходе — точное место, а не 10-секундной давности
    // Физический выход звука (динамики Мака / монитор по HDMI) переключает macOS-помощник bin/lost-audio
    const AUDIO_BIN = path.join(__dirname, 'bin', 'lost-audio');
    function applyAudioDevice(mode) {
        const args = mode === 'monitor' ? ['set', 'display', opts.display || ''] : mode === 'speakers' ? ['set', 'builtin'] : null;
        if (opts.audioDevice === false || !args || !fs.existsSync(AUDIO_BIN)) return;
        execFile(AUDIO_BIN, args.filter(Boolean), (e, out, err) => {
            if (e) console.log('[audio] не удалось переключить (' + mode + '):', (err || e.message).trim());
            else { try { console.log('[audio] выход звука:', JSON.parse(out).name); } catch (_) {} }
        });
    }
    if (audioMode !== 'monitor' && audioMode !== 'off') audioMode = 'speakers'; // прежние значения (on/tv/mac) = динамики Мака
    applyAudioDevice(audioMode);
    const audioMsg = () => JSON.stringify({ type: '__audio', mode: audioMode });
    const last = {}; // последние enableConsole/__state от ТВ — чтобы новая консоль сразу их получила
    let sleepOn = curPaused; // последняя удалённая команда паузы — заново отправляется таймеру после перезагрузки его страницы
    const sleepMsg = () => JSON.stringify({ type: '__cmd', cmd: 'sleep', on: sleepOn });
    function setSleep(on, source) {
        clock.setPaused(on); syncClock(); sleepOn = curPaused; saveState(); publishClock();
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
        const sample = syncClock();
        return { left: sample.left, open: sample.phase === 'countdown' && sample.left > 0 && sample.left <= 240, paused: sample.paused };
    }
    let lastClockKey = '', lastClockSentAt = 0;
    function publishClock() {
        const sample = syncClock();
        clearTimeout(clockTimer);
        // Reschedule after every control change as well as every broadcast.
        // Keep a 1s checkpoint while paused; active clocks wake at the next boundary.
        const fraction = sample.rawLeft - Math.floor(sample.rawLeft);
        const delay = sample.paused ? 1000 : Math.max(1, Math.ceil((fraction || 1) * 1000));
        clockTimer = setTimeout(() => { publishClock(); if (Date.now() - savedAt >= 1000) saveState(); }, delay);
        const live = clock.snapshot().live; journalFailure(live.left <= -timeline.failure.zeroHold && !live.paused);
        const key = [sample.mode,sample.left,sample.paused,sample.phase,sample.failureAge,sample.cycle].join(':');
        if (key === lastClockKey && Date.now() - lastClockSentAt < 10000) return; lastClockKey = key; lastClockSentAt = Date.now();
        const control = JSON.stringify({ type: '__clock', ...sample });
        const enable = JSON.stringify({ type: 'enableConsole', mode: sample.mode, enabled: sample.phase === 'countdown' && sample.left > 0 && sample.left <= 240, remainingTime: sample.left });
        const state = JSON.stringify({ type: '__state', mode: sample.mode, label: sample.paused ? '▶ Старт' : '⏸ Пауза' });
        last.enable = enable; last.state = state;
        for (const set of Object.values(peers)) for (const ws of set) if (ws.readyState === 1) ws.send(control);
        for (const ws of peers.console) if (ws.readyState === 1) { ws.send(enable); ws.send(state); }

    }
    function statusText() {
        const t = timerInfo(), L = t.left;
        const left = L == null ? '?' : L > 240 ? Math.ceil(L / 60) + ' мин' : Math.floor(L / 60) + ':' + String(L % 60).padStart(2, '0');
        const snd = { speakers: 'динамики', monitor: 'монитор', off: 'выкл' }[audioMode] || audioMode;
        return `LOST: ${t.paused ? 'пауза' : 'идёт'}, осталось ${left}${t.open ? ' — можно вводить код' : ''}. Звук: ${snd}.`;
    }

    // ===== Журнал станции «Лебедь» — как распечатка в сериале =====
    // ОДНА бесконечная строка: слова через пробел, без переносов — переносит по ширине тот, кто показывает
    // (матричный принтер — по краю листа, терминал — по ширине окна).
    //   верный код → «<время> accepted», где время = месяц (без нуля) день(2) час(2) минута (без нуля) :секунды(2) — 922041:52;
    //   сбой → «SYSTEM FAILURE» каждую секунду, пока таймер не сбросят (не больше 108 раз). Только Live, паузы не пишутся.
    const journalFile = path.join(__dirname, 'journal.txt');
    // журнал прежнего формата (с переносами по 80) — склеить в одну строку
    // Existing history is never rewritten; new words are appended below.
    function jWrite(word) {
        let empty = true; try { empty = fs.statSync(journalFile).size === 0; } catch (_) {}
        try { fs.appendFileSync(journalFile, (empty ? '' : ' ') + word); } catch (_) {}
    }
    function stamp(d = new Date()) {
        const p2 = n => String(n).padStart(2, '0');
        return `${d.getMonth() + 1}${p2(d.getDate())}${p2(d.getHours())}${d.getMinutes()}:${p2(d.getSeconds())}`;
    }
    function journalAccepted() { if (curMode !== 'live') return; jWrite(stamp()); jWrite('accepted'); console.log('[журнал]', stamp(), 'accepted'); }
    let failTimer = null, failCount = 0;
    function journalFailure(on) {
        if (on && !failTimer) {
            failCount = 0;
            const tick = () => { if (++failCount > 108) { clearInterval(failTimer); return; } jWrite('SYSTEM'); jWrite('FAILURE'); };
            console.log('[журнал] SYSTEM FAILURE');
            tick(); failTimer = setInterval(tick, 1000);
        } else if (!on && failTimer) { clearInterval(failTimer); failTimer = null; }
    }
    // хвост журнала примерно на n строк по 80 знаков, начиная с целого слова
    function journalTail(n) {
        try {
            const t = fs.readFileSync(journalFile, 'utf8'), max = n * 80;
            if (t.length <= max) return t;
            const cut = t.slice(-max); return cut.slice(cut.indexOf(' ') + 1);
        } catch (_) { return ''; }
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
            if(code !== '4 8 15 16 23 42') for (const o of peers.tv) if (o.readyState === 1) o.send(msg);
            console.log('[пульт] код:', code);
            if (code === '4 8 15 16 23 42') { journalAccepted(); clock.reset(); saveState(); publishClock(); }
            return 'Код отправлен.';
        }
        // Своя команда из «Команд» этого Мака: текст сообщения точно совпадает с её названием (без учёта регистра).
        // Так любое слово с iPhone может запустить что угодно в системе — достаточно создать команду с таким именем.
        const sc = findShortcut(text);
        if (sc) {
            console.log('[пульт] запускаю команду «' + sc + '» (' + via + ')');
            // ввод закрываем сразу: при открытом stdin `shortcuts run` ждёт входные данные для команды и висит
            const child = execFile('shortcuts', ['run', sc], { timeout: 120000 }, (e, out) => {
                const res = e ? 'ошибка: ' + (e.message || '').split('\n')[0] : (String(out || '').trim() || 'готово');
                console.log('[пульт] команда «' + sc + '»: ' + res);
                if (sender) reply(sender, 'Команда «' + sc + '»: ' + res.slice(0, 500));
            });
            child.stdin.end();
            return 'Запускаю команду «' + sc + '».';
        }
        if (/^журнал|^journal/.test(t)) return 'Журнал станции:\n' + (journalTail(6) || '(пусто)') + '\n';
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
    let shortcutNames = [], shortcutsAt = 0, shortcutsRefreshing = false;
    function refreshShortcuts() {
        if (shortcutsRefreshing || Date.now() - shortcutsAt < 60000) return;
        shortcutsRefreshing = true; shortcutsAt = Date.now();
        execFile('shortcuts', ['list'], { encoding: 'utf8', timeout: 10000 }, (error, output) => {
            shortcutsRefreshing = false;
            if (!error) shortcutNames = output.split('\n').map(x => x.trim()).filter(Boolean);
        });
    }
    function findShortcut(text) {
        refreshShortcuts();
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
            ws.send(JSON.stringify({ type: '__modules', modules: moduleManager.snapshot() }));
            ws.send(JSON.stringify({type:'__clock', ...syncClock()}));
            if (role === 'console') Object.values(last).forEach(m => ws.send(m));
            ws.on('message', m => {
                const s = m.toString();
                let data; try { data = JSON.parse(s); } catch (_) { return; }
                if (!data || typeof data !== 'object') return;
                if (data.type === '__cmd' && data.cmd === 'quit') { events.emit('quit'); return; }
                if (data.type === '__audio') { if (['speakers','monitor','off'].includes(data.mode)) setAudio(data.mode); return; }
                if (data.type === '__alive') { events.emit('client-alive', { ...data, role }); if (role === 'tv') events.emit('tv-alive', data); return; }
                if (data.type === '__log') { console.log('[' + role + ' log]', data.msg); return; }
                if (data?.type === '__module') { if (role === 'console') { if (!moduleManager.set(data.id, data.enabled)) ws.send(JSON.stringify({ type: '__module_error', id: data.id, error: data.id === 'muse' ? 'not_installed' : 'invalid_module_request' })); } return; }
                if (!data || typeof data !== 'object') return;
                if (data.type === '__cmd' && data.cmd === 'mode' && role === 'console' && ['live','dev'].includes(data.value)) {
                    switchMode(data.value);
                    for (const tv of peers.tv) if (tv.readyState === 1) tv.send(s);
                    return;
                }
                if (data.type === '__timer') {
                    if (role !== 'tv' || data.mode !== clock.mode) return;
                    if (data.op === 'pause' && typeof data.paused === 'boolean') clock.setPaused(data.paused);
                    else if (data.op === 'reset') clock.reset();
                    else if (data.op === 'failure' && clock.mode === 'dev') clock.reset(0);
                    else if (data.op === 'set' && clock.mode === 'dev' && [10,60,240,6480].includes(data.seconds)) clock.reset(data.seconds);
                    else return;
                    syncClock(); sleepOn = curPaused; saveState(); publishClock(); return;
                }
                if (role === 'console' && data.type === 'numberSubmitted' && data.value === '4 8 15 16 23 42') {
                    if (timerInfo().open) { journalAccepted(); clock.reset(); saveState(); publishClock(); }
                    return;
                }
                // Browser rendering reports are never a time source.
                if (role === 'tv' && (data.type === 'enableConsole' || data.type === '__state')) return;
                const to = role === 'tv' ? 'console' : 'tv';
                for (const o of peers[to]) if (o.readyState === 1) o.send(s);
            });
            events.emit('peers', { tv: peers.tv.size, console: peers.console.size });
            ws.on('close', () => { peers[role].delete(ws); events.emit('peers', { tv: peers.tv.size, console: peers.console.size }); console.log(`[bridge] ${role} left`); });
        });
    });

    return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, opts.host || '0.0.0.0', async () => {
        await moduleManager.initialize();
        process.on('exit', saveState);
        publishClock();
        server.once('close', () => clearTimeout(clockTimer));
        const ip = lanIp();
        console.log(`LOST server: http://${ip}:${port}/index.html  |  console: http://localhost:${port}/console.html`);
        resolve({ server, port, ip, getModules: moduleManager.snapshot, updateUPS: moduleManager.updateUPS, updateMuse: moduleManager.updateMuse, reconcileUPS: moduleManager.reconcileUPS, getMode: () => clock.mode, saveState, getTimer: () => { const c = syncClock(); return { mode: c.mode, left: c.left, paused: c.paused }; } });
    }); });
}

module.exports = { start, lanIp, events };
if (require.main === module) start(parseInt(process.env.PORT) || 8765, { host: process.env.LOST_BIND_HOST || '0.0.0.0' });
