// LOST: одна команда — сервер, таймер на Chromecast, окно терминала на этом компьютере.
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { start } = require('./server');
const { castSite } = require('./cast');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function openTerminalWindow(url) {
    // чистое окно без адресной строки, если есть Chrome; иначе обычный браузер по умолчанию
    if (fs.existsSync(CHROME)) {
        const profile = path.join(require('os').tmpdir(), 'lost-terminal-profile');
        spawn(CHROME, [`--app=${url}`, '--window-size=800,600', `--user-data-dir=${profile}`, '--no-first-run'], { stdio: 'ignore', detached: true }).unref();
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
        session = await castSite(cfg.chromecast, timerUrl);
        console.log('Таймер запущен на ТВ.');
    } catch (e) {
        console.log('⚠ Не удалось открыть таймер на Chromecast:', e.message);
        console.log('  Проверьте, что он включён и в той же сети. Терминал всё равно откроется; таймер можно открыть вручную:', timerUrl);
    }

    openTerminalWindow(`http://localhost:${port}/console.html`);
    console.log('Терминал открыт. Остановить: Ctrl+C или закрыть это окно.');

    const bye = () => { try { session && session.close(); } catch (_) {} process.exit(0); };
    process.on('SIGINT', bye);
    process.on('SIGTERM', bye);
    process.on('SIGHUP', bye);
})();
