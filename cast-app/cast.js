// Открывает URL на Chromecast через DashCast (тот же приёмник, что использует catt cast_site).
// Без Python и внешних программ — только Node + castv2.
const { Client } = require('castv2');

const DASHCAST_APP_ID = '84912283';
const DASHCAST_NS = 'urn:x-cast:com.madmod.dashcast';

function castSite(host, url, { timeout = 15000 } = {}) {
    return new Promise((resolve, reject) => {
        const client = new Client();
        let done = false;
        const close = () => { if (done) return; done = true; try { client.close(); } catch (_) {} };
        const timer = setTimeout(() => { close(); reject(new Error('таймаут: Chromecast не ответил на ' + host)); }, timeout);
        const fail = e => { clearTimeout(timer); close(); reject(e); };

        client.on('error', fail);
        client.connect({ host, port: 8009 }, () => {
            const conn = client.createChannel('sender-0', 'receiver-0', 'urn:x-cast:com.google.cast.tp.connection', 'JSON');
            const heartbeat = client.createChannel('sender-0', 'receiver-0', 'urn:x-cast:com.google.cast.tp.heartbeat', 'JSON');
            const receiver = client.createChannel('sender-0', 'receiver-0', 'urn:x-cast:com.google.cast.receiver', 'JSON');
            conn.send({ type: 'CONNECT' });
            heartbeat.send({ type: 'PING' });

            let sent = false;
            receiver.on('message', msg => {
                if (msg.type !== 'RECEIVER_STATUS' || sent) return;
                const app = (msg.status.applications || []).find(a => a.appId === DASHCAST_APP_ID);
                if (!app || !app.transportId) return;
                // приложение запущено — отдаём ему адрес страницы
                sent = true;
                setTimeout(() => {
                const appConn = client.createChannel('sender-0', app.transportId, 'urn:x-cast:com.google.cast.tp.connection', 'JSON');
                appConn.send({ type: 'CONNECT' });
                const dash = client.createChannel('sender-0', app.transportId, DASHCAST_NS, 'JSON');
                dash.send({ url, force: true, reload: false, reload_time: 0 });
                }, 1500); // даём приложению на ТВ подняться
                clearTimeout(timer);
                // соединение держим открытым (пульс), иначе Chromecast закрывает страницу вместе с отправителем
                const beat = setInterval(() => { try { heartbeat.send({ type: 'PING' }); } catch (_) {} }, 5000);
                client.on('close', () => clearInterval(beat));
                resolve({ close: () => { clearInterval(beat); close(); } });
            });
            receiver.send({ type: 'LAUNCH', appId: DASHCAST_APP_ID, requestId: 1 });
        });
    });
}

module.exports = { castSite };
if (require.main === module) castSite(process.argv[2], process.argv[3]).then(() => console.log('ok, держу соединение (Ctrl+C — выйти)'), e => { console.error(e.message); process.exit(1); });
