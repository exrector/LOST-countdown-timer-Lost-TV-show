// LOST: одна команда — сервер, таймер на Chromecast, окно терминала на этом компьютере.
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { start, events } = require('./server');
const { castSite } = require('./cast');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function openTerminalWindow(url) {
    // чистое окно без адресной строки, если есть Chrome; иначе обычный браузер по умолчанию
    if (fs.existsSync(CHROME)) {
        const profile = path.join(require('os').tmpdir(), 'lost-terminal-profile');
        spawn(CHROME, [`--app=${url}`, '--window-size=800,600', `--user-data-dir=${profile}`, '--no-first-run', '--autoplay-policy=no-user-gesture-required'], { stdio: 'ignore', detached: true }).unref();
    } else {
        execFileSync('open', [url]);
    }
}

(async () => {
    const { ip, port } = await start(cfg.port);
    const timerUrl = `http://${ip}:${port}/index.html`;
    let session;

    try {
        console.log(`Открываю таймер на Chromecast (${cfg.chromecast})…`);
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

    openTerminalWindow(`http://localhost:${port}/console.html`);
    console.log('Терминал открыт. Остановить: Ctrl+C или закрыть это окно.');

    const bye = () => { try { session && session.close(); } catch (_) {} process.exit(0); };
    process.on('SIGINT', bye);
    process.on('SIGTERM', bye);
    process.on('SIGHUP', bye);
})();
