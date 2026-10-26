'use strict';
// Пульт LOST: два канала с собственными настройками. iMessage — глобально, только с разрешённых номеров;
// Siri — «Команды» iPhone по адресу станции, только из домашней сети. Каждую команду можно выключить
// для каждого канала; запуск команд «Команд» Mac по точному названию — отдельный переключатель.
const { COMMANDS, parse } = require('./commands.cjs');

const CHANNELS = { imessage: 'iMessage', siri: 'Siri' };
const LABEL = Object.fromEntries(COMMANDS.map(c => [c.id, c.label]));
function normalizeSettings(value) {
    return Object.fromEntries(Object.keys(CHANNELS).map(channel => {
        const v = value && typeof value === 'object' && value[channel] && typeof value[channel] === 'object' ? value[channel] : {};
        const commands = v.commands && typeof v.commands === 'object' ? v.commands : {};
        return [channel, { commands: Object.fromEntries(COMMANDS.map(c => [c.id, commands[c.id] !== false])), shortcuts: v.shortcuts !== false }];
    }));
}
function createRemote({ saved, persist = () => true, actions, shortcuts = { find: () => null, run: () => '' }, active = () => true }) {
    let settings = normalizeSettings(saved);
    const help = channel => 'Команды: ' + COMMANDS.filter(c => settings[channel].commands[c.id]).map(c => c.phrases.join('/')).join(', ') +
        (settings[channel].shortcuts ? ' — или точное название команды из «Команд» Mac mini.' : '.');
    // Ответ: строка для отправителя ('' — только состояние станции) или null, если канал выключен.
    function run(text, channel, sender) {
        if (!Object.hasOwn(CHANNELS, channel) || !active(channel)) return null;
        const own = settings[channel], command = parse(text), said = String(text || '').trim();
        if (command && command.id === 'code') return own.commands.code ? actions.code(command.code, channel) : 'Код по ' + CHANNELS[channel] + ' не принимается.';
        if (own.shortcuts) { const name = shortcuts.find(text); if (name) return shortcuts.run(name, channel, sender); }
        if (!command) return 'Не понял «' + said + '». ' + help(channel);
        if (!own.commands[command.id]) return 'Команда «' + LABEL[command.id] + '» по ' + CHANNELS[channel] + ' выключена.';
        return actions[command.id](channel, said);
    }
    function set(channel, key, enabled) {
        if (!Object.hasOwn(CHANNELS, channel) || typeof enabled !== 'boolean') return false;
        if (key !== 'shortcuts' && !Object.hasOwn(LABEL, key)) return false;
        const previous = settings;
        settings = normalizeSettings(JSON.parse(JSON.stringify(settings)));
        if (key === 'shortcuts') settings[channel].shortcuts = enabled; else settings[channel].commands[key] = enabled;
        if (!persist()) { settings = previous; return false; }
        return true;
    }
    function snapshot() {
        return Object.fromEntries(Object.keys(CHANNELS).map(channel => [channel, {
            name: CHANNELS[channel], shortcuts: settings[channel].shortcuts,
            commands: COMMANDS.map(c => ({ id: c.id, label: c.label, phrases: c.phrases, enabled: settings[channel].commands[c.id] })),
        }]));
    }
    return { run, set, snapshot, settings: () => JSON.parse(JSON.stringify(settings)), help };
}
// Siri — только домашняя сеть: петля и частные IPv4 (RFC 1918). Tailnet (100.64/10) и всё прочее — нет.
function isHomeNetwork(address) {
    const a = String(address || '').replace(/^::ffff:/, '');
    if (a === '::1' || a === '127.0.0.1') return true;
    const p = a.split('.').map(Number);
    if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    return p[0] === 10 || p[0] === 192 && p[1] === 168 || p[0] === 172 && p[1] >= 16 && p[1] <= 31 || p[0] === 127;
}
module.exports = { createRemote, normalizeSettings, isHomeNetwork, CHANNELS };
