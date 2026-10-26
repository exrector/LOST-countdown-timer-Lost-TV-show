/* «Пламя»: экран связи со станциями DHARMA INITIATIVE. Только показ, без команд узлам.
   Экран по-английски, как оригинальные названия станций и строки мейнфрейма. */
(function (root, factory) {
    var Flame = factory();
    if (typeof module === 'object' && module.exports) module.exports = Flame;
    if (root && root.document) root.LostFlame = Flame;
})(typeof window === 'undefined' ? null : window, function () {
    'use strict';
    function pad(value, size) { value = String(value); return value.length >= size ? value.slice(0, size) : value + new Array(size - value.length + 1).join(' '); }
    function two(n) { return (n < 10 ? '0' : '') + n; }
    function contact(time) { if (!time) return ''; var d = new Date(time); return 'LAST SEEN ' + two(d.getDate()) + '.' + two(d.getMonth() + 1) + ' ' + two(d.getHours()) + ':' + two(d.getMinutes()); }
    // Колонки на 78 знаков панели 820 px; длинное имя обрезается, между колонками всегда отступ.
    function cell(value, size, gap) { return pad(String(value).slice(0, size), size + gap); }
    function row(s) {
        var note = s.self ? 'THIS STATION' : s.online ? '' : contact(s.lastSeen);
        return (cell(s.number || '–', 2, 1) + cell(s.station || 'UNKNOWN STATION', 19, 2) + cell(s.device, 22, 2) + cell(s.online ? 'ONLINE' : 'OFFLINE', 7, 1) + note).replace(/\s+$/, '');
    }
    function format(raw) {
        var d; try { d = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { return 'ДАННЫЕ НЕДОСТУПНЫ. ←/ESC НАЗАД; ОТКРОЙТЕ СНОВА ДЛЯ ПОВТОРА.'; }
        var head = 'DHARMA INITIATIVE · THE SWAN → ALL STATIONS\n\n';
        if (!d || d.enabled === false) return head + 'MODULE OFFLINE. МЕНЮ → МОДУЛИ → ПЛАМЯ.';
        if (d.installed === false) return head + 'NO LINK: TAILSCALE NOT FOUND ON THIS STATION.';
        if (d.status !== 'ready') return head + 'THE LOOKING GLASS IS BLOCKING ALL SIGNALS.\n' + (d.error || 'Нет ответа Tailscale на станции');
        var list = Array.isArray(d.stations) ? d.stations : [], online = list.filter(function (s) { return s.online; }).length;
        return head + 'ONLINE ' + online + ' OF ' + list.length + '\n\n' + list.map(row).join('\n');
    }
    return { format: format, row: row };
});
