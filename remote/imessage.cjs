'use strict';
// Канал iMessage: сообщения на Apple ID этого Мака от разрешённых номеров (config.json → sleepFrom) читаются из базы
// «Сообщений» раз в 10 с; ответ уходит сообщением. Пока модуль выключен, новые сообщения пропускаются, а не копятся.
const path = require('node:path');
const os = require('node:os');
const { execFile: execDefault } = require('node:child_process');

// Ответ пульта: текст команды и состояние станции. { text, bare: true } — только текст (справка, команды Mac mini).
// answer может быть Promise — ответ уходит, когда команда завершится.
// status может вернуть строку или Promise; если состояние не собралось, уходит один текст команды.
function compose(answer, status) {
    return Promise.resolve(answer).then(answer => {
        const own = answer && typeof answer === 'object', text = own ? answer.text : answer;
        return Promise.resolve().then(() => own && answer.bare ? '' : status()).catch(() => '')
            .then(state => [text, state].filter(Boolean).join('\n\n') || 'НЕТ ДАННЫХ');
    });
}
function createIMessage({ senders = [], run, status, active = () => true, db = path.join(os.homedir(), 'Library/Messages/chat.db'), exec = execDefault, log = console.log, intervalMs = 10000, delayMs = 1500, setTimer = setInterval, later = setTimeout }) {
    const list = senders.map(x => String(x).replace(/'/g, '')).filter(Boolean);
    const from = list.map(x => "'" + x + "'").join(',');
    let lastId = null, warned = false, timer = null;
    function reply(to, text) {
        const script = 'on run argv\n tell application "Messages"\n set s to 1st account whose service type = iMessage\n' +
            ' send (item 2 of argv) to participant (item 1 of argv) of s\n end tell\nend run';
        exec('osascript', ['-e', script, to, text], e => { if (e) log('[пульт] ответ не отправлен:', (e.message || '').split('\n')[0]); });
    }
    function check() {
        const q = lastId === null ? 'select max(ROWID) from message;'
            : `select m.ROWID, h.id, m.text from message m join handle h on h.ROWID = m.handle_id where m.ROWID > ${lastId} and m.is_from_me = 0 and h.id in (${from}) order by m.ROWID;`;
        exec('/usr/bin/sqlite3', ['-readonly', '-separator', '\t', db, q], (e, out) => {
            if (e) { if (!warned) log('[пульт] не читается база «Сообщений» — дайте LOST.app «Полный доступ к диску»:', (e.message || '').split('\n')[0]); warned = true; return; }
            if (warned) { log('[пульт] доступ к «Сообщениям» есть'); warned = false; }
            if (lastId === null) { lastId = parseInt(out) || 0; return; } // старые сообщения не трогаем
            for (const line of String(out).split('\n').filter(Boolean)) {
                const [id, sender, ...rest] = line.split('\t'); lastId = Math.max(lastId, parseInt(id));
                if (!active()) continue;
                const answer = run(rest.join(' '), 'imessage', sender);
                if (answer === null) continue;
                // ответ — после того, как таймер успеет отработать команду и прислать новое состояние
                later(() => compose(answer, status).then(text => reply(sender, text)), delayMs);
            }
        });
    }
    function start() {
        if (!list.length || timer !== null) return false;
        log('[пульт] жду iMessage от:', list.length, list.length === 1 ? 'номера' : 'номеров');
        check(); timer = setTimer(check, intervalMs); timer?.unref?.();
        return true;
    }
    return { start, check, reply, senders: () => list.slice(), configured: () => list.length > 0 };
}
module.exports = { compose, createIMessage };
