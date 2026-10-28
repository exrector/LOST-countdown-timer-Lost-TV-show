'use strict';
// Ответ пульта «статус» — единственный полный ответ: таймер Live, все включённые модули и работоспособность
// терминала (окна терминала и таймера, дисплей). Сухо, машинно, заглавными — терминал мейнфрейма 70-х (решение владельца 28.10).
// Dev в пульте не участвует; выключенные модули не упоминаются.
const STATUS = { ready: 'ГОТОВ', starting: 'ЗАПУСК', stopping: 'ОСТАНОВКА', error: 'ОШИБКА', not_installed: 'НЕ УСТАНОВЛЕН', unavailable: 'НЕТ ДАННЫХ', degraded: 'НЕТ СВЕЖИХ ДАННЫХ', connecting: 'СОЕДИНЕНИЕ', reconnecting: 'ПЕРЕПОДКЛЮЧЕНИЕ', revoked: 'ПАРА ОТОЗВАНА', disabled: 'ВЫКЛЮЧЕН' };
const MODULES = [['muse', 'AI'], ['flame', 'СТАНЦИИ'], ['imessage', 'iMESSAGE'], ['shortcuts', 'MAC MINI']];
// Время таймера — как на таймере станции, МММ.СС без единиц: от минуты — только минуты (103.00, 006.00),
// меньше минуты — только секунды (000.06). Формат — только для таймера; резерв ИБП — в минутах.
const mmss = s => { s = Math.max(0, Math.floor(Number(s) || 0)); return s >= 60 ? String(Math.floor(s / 60)).padStart(3, '0') + '.00' : '000.' + String(s).padStart(2, '0'); };
const upper = v => String(v).toUpperCase();

// live — clock.sample('live')
function timerLine({ left, paused, phase }) {
    if (phase && phase !== 'countdown') return 'ТАЙМЕР: СБОЙ';
    if (left == null) return 'ТАЙМЕР: НЕТ ДАННЫХ';
    const rest = mmss(left) + (left > 0 && left <= 240 ? ' · ВВОД КОДА' : '');
    return 'ТАЙМЕР: ' + (paused ? 'ПАУЗА ' : 'ОСТАЛОСЬ ') + rest;
}
// ups — ответ агента ИБП (/state) или null, если его не спросить.
function powerLine(ups) {
    if (!ups || !ups.online || !ups.vars) return 'ПИТАНИЕ: НЕТ ДАННЫХ';
    const v = ups.vars, flags = String(v['ups.status'] || '').split(/\s+/);
    const parts = [flags.includes('OB') ? 'БАТАРЕЯ' : flags.includes('OL') ? 'СЕТЬ' : upper(v['ups.status'] || '?')];
    if (v['battery.charge'] != null) parts.push('ЗАРЯД ' + v['battery.charge'] + '%');
    if (v['battery.runtime'] != null) parts.push('РЕЗЕРВ ' + Math.round(Number(v['battery.runtime']) / 60) + ' МИН');
    if (v['ups.load'] != null) parts.push('НАГРУЗКА ' + v['ups.load'] + '%');
    return 'ПИТАНИЕ: ' + parts.join(' · ');
}
function state(m) { return (STATUS[m.status] || upper(m.status || 'НЕТ ДАННЫХ')) + (m.error ? ' — ' + upper(m.error) : ''); }
function vpnLine(m) {
    if (m.status === 'ready') return 'VPN: ' + (m.location ? upper(m.location) : 'ОТКЛЮЧЁН');
    return 'VPN: ' + state(m);
}
const link = c => c && c.status === 'ready' ? 'НА СВЯЗИ' : 'НЕТ СВЯЗИ';

function formatStatus({ timer, modules = {}, components, ups }) {
    const on = id => modules[id] && modules[id].enabled !== false;
    const lines = [timerLine(timer || {})];
    if (on('ups')) lines.push(powerLine(ups));
    if (on('vpn')) lines.push(vpnLine(modules.vpn));
    for (const [id, label] of MODULES) if (on(id)) lines.push(label + ': ' + state(modules[id]));
    if (components) {
        lines.push('ТЕРМИНАЛ: ' + link(components.terminal), 'ЭКРАН ТАЙМЕРА: ' + link(components.timer));
        if (components.display) lines.push('ДИСПЛЕЙ: ' + (components.display.status === 'ready' && components.display.name ? upper(components.display.name) : 'НЕТ'));
    }
    return lines.join('\n');
}
module.exports = { formatStatus, mmss };
