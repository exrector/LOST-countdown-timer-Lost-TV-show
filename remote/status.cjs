'use strict';
// Ответ пульта «статус»: состояние станции несколькими строками — таймер, питание, VPN, AI, связь окон.
// Только то, что ядро знает само; выключенные модули не упоминаются.
const STATUS = { ready: 'готов', starting: 'запуск', stopping: 'остановка', error: 'ошибка', not_installed: 'не установлен', unavailable: 'нет данных', degraded: 'нет актуальных данных' };
const clock = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');

function timerLine({ mode, left, paused, phase }) {
    const head = 'LOST · ' + String(mode || 'live').toUpperCase();
    if (phase && phase !== 'countdown') return head + '\nТаймер: СБОЙ — нужен код 4 8 15 16 23 42';
    if (left == null) return head + '\nТаймер: нет данных';
    const open = left > 0 && left <= 240;
    const rest = open ? clock(left) + ' — можно вводить код' : Math.ceil(left / 60) + ' мин';
    return head + '\nТаймер: ' + (paused ? 'пауза, ' : 'идёт, ') + 'осталось ' + rest;
}
// ups — ответ агента ИБП (/state) или null, если его не спросить.
function powerLine(ups) {
    if (!ups || !ups.online || !ups.vars) return 'Питание: нет данных ИБП';
    const v = ups.vars, flags = String(v['ups.status'] || '').split(/\s+/);
    const source = flags.includes('OB') ? 'БАТАРЕЯ' : flags.includes('OL') ? 'сеть' : String(v['ups.status'] || '?');
    const parts = ['Питание: ' + source];
    if (v['battery.charge'] != null) parts.push('заряд ' + v['battery.charge'] + ' %');
    if (v['battery.runtime'] != null) parts.push('резерв ' + Math.round(Number(v['battery.runtime']) / 60) + ' мин');
    if (v['ups.load'] != null) parts.push('нагрузка ' + v['ups.load'] + ' %');
    return parts.join(' · ');
}
function moduleLine(label, m) {
    if (!m || m.enabled === false) return null;
    return label + ': ' + (STATUS[m.status] || m.status || 'нет данных') + (m.error ? ' (' + m.error + ')' : '');
}
function vpnLine(m) {
    if (!m || m.enabled === false) return null;
    if (m.status === 'ready') return 'VPN: ' + (m.location ? 'CONNECTED: ' + m.location : 'DISCONNECTED');
    return 'VPN: ' + (m.status === 'unavailable' ? 'NO DATA' : (STATUS[m.status] || m.status));
}
function windowsLine(components = {}) {
    const one = c => c && c.status === 'ready' ? 'на связи' : 'нет связи';
    return 'Терминал: ' + one(components.terminal) + ' · экран таймера: ' + one(components.timer);
}
function formatStatus({ timer, modules = {}, components, ups }) {
    const lines = [timerLine(timer)];
    if (modules.ups && modules.ups.enabled !== false) lines.push(powerLine(ups));
    lines.push(vpnLine(modules.vpn), moduleLine('AI (Kay)', modules.muse));
    if (components) lines.push(windowsLine(components));
    return lines.filter(Boolean).join('\n');
}
module.exports = { formatStatus };
