// LOST: одна команда — сервер, таймер на Chromecast, окно терминала на этом компьютере.
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { start, events } = require('./server');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const children = [];
function track(child) { children.push(child); return child; }

function openTerminalWindow(url) {
    // чистое окно без адресной строки, если есть Chrome; иначе обычный браузер по умолчанию
    if (fs.existsSync(CHROME)) {
        const profile = path.join(require('os').tmpdir(), 'lost-terminal-profile');
        fs.rmSync(profile, { recursive: true, force: true }); // чистый профиль каждый запуск — без старого кэша страниц
        // на весь главный экран, как таймер на втором (главный — первый в списке macOS)
        const main = listScreens()[0];
        const place = main ? [`--window-position=${main.x},${main.y}`, `--window-size=${main.w},${main.h}`] : ['--window-size=800,600'];
        track(spawn(CHROME, [`--app=${url}`, ...place, '--start-fullscreen', `--user-data-dir=${profile}`, '--no-first-run', '--autoplay-policy=no-user-gesture-required'], { stdio: 'ignore', detached: true })).unref();
    } else {
        execFileSync('open', [url]);
    }
}

// Координаты экранов macOS (через JXA). Chrome ждёт левый верхний угол, Cocoa даёт левый нижний.
function listScreens() {
    try {
        const out = execFileSync('osascript', ['-l', 'JavaScript', '-e', `
            ObjC.import("AppKit"); const s = $.NSScreen.screens, r = [];
            for (let i = 0; i < s.count; i++) { const sc = s.objectAtIndex(i), f = sc.frame;
              r.push({ name: ObjC.unwrap(sc.localizedName), x: f.origin.x, y: f.origin.y, w: f.size.width, h: f.size.height }); }
            JSON.stringify(r)`], { encoding: 'utf8' });
        const list = JSON.parse(out), H0 = list[0].h;
        return list.map(d => ({ name: d.name, x: Math.round(d.x), y: Math.round(H0 - (d.y + d.h)), w: Math.round(d.w), h: Math.round(d.h) }));
    } catch (e) { return []; }
}

function findDisplay(name) {
    const list = listScreens();
    return list.find(d => d.name === name) || (list.length > 1 ? list[list.length - 1] : null);
}

function openTimerOnDisplay(url, display) {
    if (!fs.existsSync(CHROME)) { console.log('⚠ Нужен Google Chrome для окна таймера на втором экране.'); return false; }
    const profile = path.join(require('os').tmpdir(), 'lost-timer-profile');
    fs.rmSync(profile, { recursive: true, force: true });
    track(spawn(CHROME, [`--app=${url}`, `--window-position=${display.x},${display.y}`, `--window-size=${display.w},${display.h}`,
        '--start-fullscreen', `--user-data-dir=${profile}`, '--no-first-run', '--autoplay-policy=no-user-gesture-required',
        // таймер идёт в окне на втором экране: без этих флагов Chrome притормаживает скрытые/перекрытые окна
        '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
        '--disable-features=CalculateNativeWinOcclusion',
        '--force-device-scale-factor=1'], // 1 CSS-пиксель = 1 физический: размер таймера не зависит от масштаба экрана macOS
        { stdio: 'ignore', detached: true })).unref();
    return true;
}

(async () => {
    const { ip, port } = await start(cfg.port, { audioDefault: 'speakers', stage: cfg.stage, display: cfg.display, sleepFile: cfg.sleepFile });
    // не даём Маку и экрану заснуть, пока идёт таймер
    const caf = spawn('caffeinate', ['-d', '-i', '-w', String(process.pid)], { stdio: 'ignore' }); caf.unref();
    const timerUrl = `http://${ip}:${port}/index.html`;
    let session;
    const out = cfg.output || 'chromecast';

    if (out === 'external') console.log(`Таймер показывает внешнее устройство (Raspberry Pi): страница http://${ip}:${port}/index.html`);

    if (out === 'local' || out === 'both') {
        const d = findDisplay(cfg.display);
        if (d) {
            console.log(`Таймер — на экране «${d.name}» (${d.w}×${d.h}).`);
            openTimerOnDisplay(`http://localhost:${port}/index.html`, d);
        } else {
            console.log(`⚠ Второй экран «${cfg.display}» не найден. Подключите его и отключите зеркалирование`);
            console.log('  (Системные настройки → Мониторы → выберите панель → «Использовать как» → «Расширенный дисплей»).');
            console.log('  Таймер не открыт; когда экран появится, перезапустите программу.');
        }
    }

    if (out === 'chromecast' || out === 'both') try {
        console.log(`Открываю таймер на Chromecast (${cfg.chromecast})…`);
        const { castSite } = require('./cast'); // castv2 нужен только для Chromecast
        session = await castSite(cfg.chromecast, timerUrl, { onClose: () => console.log('⚠ Chromecast разорвал соединение отправителя — страница на ТВ может остановиться.') });
        console.log('Таймер запущен на ТВ.');
    } catch (e) {
        console.log('⚠ Не удалось открыть таймер на Chromecast:', e.message);
        console.log('  Проверьте, что он включён и в той же сети. Терминал всё равно откроется; таймер можно открыть вручную:', timerUrl);
    }

    // Слежение: ТВ шлёт пульс раз в 10 с. Если молчит дольше 40 с — страница, вероятно, зависла.
    let lastAlive = 0, warned = false;
    events.on('tv-alive', a => { lastAlive = Date.now(); if (warned) console.log('✔ ТВ снова отвечает (страница работает уже', a.up, 'с)'); warned = false; });
    setInterval(() => {
        if (lastAlive && !warned && Date.now() - lastAlive > 40000) {
            warned = true;
            console.log('⚠ ТВ не присылает пульс больше 40 с — страница таймера зависла или Chromecast пропал из сети.');
        }
    }, 5000);

    // Закрыли окно терминала (кнопкой, ⌘W или ⌘Q) — программа завершается целиком, вместе с окном таймера.
    // Небольшая пауза, чтобы не завершиться при перезагрузке страницы терминала.
    let consoleGoneSince = 0, hadConsole = false;
    events.on('peers', p => { if (p.console > 0) { hadConsole = true; consoleGoneSince = 0; } else if (hadConsole && !consoleGoneSince) consoleGoneSince = Date.now(); });
    setInterval(() => { if (consoleGoneSince && Date.now() - consoleGoneSince > 10000) { console.log('Окно терминала закрыто — завершаю работу.'); bye(); } }, 2000);
    events.on('quit', () => { console.log('Выход (по команде).'); bye(); });

    openTerminalWindow(`http://localhost:${port}/console.html`);
    console.log('Терминал открыт. Остановить: Ctrl+C или закрыть это окно.');

    const bye = () => {
        try { session && session.close(); } catch (_) {}
        children.forEach(c => { try { process.kill(c.pid, 'SIGTERM'); } catch (_) {} });      // окна таймера и терминала
        try { execFileSync('pkill', ['-f', 'lost-(timer|terminal)-profile']); } catch (_) {}  // на случай оставшихся процессов Chrome
        // закрыть и значок LOST в Dock (сам он больше не опрашивает сервер каждые 4 с); не ждём — у значка свой обработчик выхода
        try { spawn('osascript', ['-e', 'if application "LOST" is running then tell application "LOST" to quit'], { stdio: 'ignore', detached: true }).unref(); } catch (_) {}
        process.exit(0);
    };
    process.on('SIGINT', bye);
    process.on('SIGTERM', bye);
    process.on('SIGHUP', bye);
})();
