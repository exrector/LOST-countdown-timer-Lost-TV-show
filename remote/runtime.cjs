'use strict';
// Пульт LOST по iMessage. Станция читает входящие сообщения от разрешённых номеров и выполняет:
// код, команду из «Команд» Mac mini с таким же названием или команду LOST по её словам.
// Слова команд LOST хранятся в состоянии станции и правятся в меню строкой через запятую.
const { COMMANDS, parseWords, match } = require('./commands.cjs');

const LABEL = Object.fromEntries(COMMANDS.map(c => [c.id, c.label]));
function normalizeSettings(value) {
    const words = value && typeof value === 'object' && value.words && typeof value.words === 'object' ? value.words : {};
    return { words: Object.fromEntries(COMMANDS.map(c => {
        const own = Array.isArray(words[c.id]) ? parseWords(words[c.id].join(',')) : null;
        return [c.id, own && own.length ? own : c.words.slice()];
    })) };
}
function createRemote({ saved, persist = () => true, actions, shortcuts = { find: () => null, run: () => '', list: () => [] } }) {
    let settings = normalizeSettings(saved);
    const help = () => 'Команды: ' + COMMANDS.map(c => settings.words[c.id].join('/')).join(', ') + ', код 4 8 15 16 23 42 — или точное название команды из «Команд» Mac mini.';
    // Ответ отправителю; '' — только состояние станции.
    function run(text, channel, sender) {
        const said = String(text || '').trim(), found = match(said, settings.words);
        if (found && found.id === 'code') return actions.code(found.code, channel);
        const name = shortcuts.find(said);
        if (name) return shortcuts.run(name, channel, sender);
        if (!found) return 'Не понял «' + said + '». ' + help();
        return actions[found.id](channel, said);
    }
    // Новые слова команды из меню; пустая строка отклоняется, прежние слова остаются.
    function setWords(id, line) {
        if (!Object.hasOwn(LABEL, id) || typeof line !== 'string' || line.length > 2000) return false;
        const words = parseWords(line);
        if (!words.length) return false;
        const previous = settings;
        settings = { words: { ...settings.words, [id]: words } };
        if (!persist()) { settings = previous; return false; }
        return true;
    }
    function snapshot() {
        return {
            commands: COMMANDS.map(c => ({ id: c.id, label: c.label, words: settings.words[c.id].slice() })),
            shortcuts: (typeof shortcuts.list === 'function' && shortcuts.list()) || [],
        };
    }
    return { run, setWords, snapshot, settings: () => JSON.parse(JSON.stringify(settings)), help };
}
// /__cmd и /__sleep для «Команд» iPhone дома: только домашняя сеть, не tailnet и не интернет.
function isHomeNetwork(address) {
    const a = String(address || '').replace(/^::ffff:/, '');
    if (a === '::1' || a === '127.0.0.1') return true;
    const p = a.split('.').map(Number);
    if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    return p[0] === 10 || p[0] === 192 && p[1] === 168 || p[0] === 172 && p[1] >= 16 && p[1] <= 31 || p[0] === 127;
}
module.exports = { createRemote, normalizeSettings, isHomeNetwork };
