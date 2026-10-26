/* Local presentation only. Audit rows never enter the Muse conversation. */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.LostMuseTimeline = api;
})(typeof window === 'undefined' ? null : window, function () {
    'use strict';
    var methods = ['device.health', 'system.run', 'file.read', 'file.write'];
    var stages = ['received', 'completed', 'sent', 'send_failed', 'failed', 'cancelled'];
    function time(value) { return typeof value === 'number' && isFinite(value) && value > 0 && value < 9e15 ? value : 0; }
    function audit(value) {
        if (!value || methods.indexOf(value.method) < 0 || stages.indexOf(value.stage) < 0 ||
            !/^[a-f0-9]{32}$/.test(value.id || '') || !/^[a-f0-9]{16}$/.test(value.ref || '') || !time(value.createdAt)) return null;
        var row = { kind: 'audit', id: 'audit:' + value.id, createdAt: value.createdAt,
            method: value.method, ref: value.ref, stage: value.stage, ok: value.ok === true, timedOut: value.timedOut === true };
        if (Number.isInteger(value.durationMs) && value.durationMs >= 0 && value.durationMs <= 86400000) row.durationMs = value.durationMs;
        if (Number.isInteger(value.exitCode) && value.exitCode >= -255 && value.exitCode <= 255) row.exitCode = value.exitCode;
        return row;
    }
    function describe(row) {
        var failed = row.stage === 'failed' || row.stage === 'send_failed' || row.stage === 'cancelled' ||
            row.stage === 'completed' && (!row.ok || row.timedOut || typeof row.exitCode === 'number' && row.exitCode !== 0);
        var labels = { received: 'получена', completed: failed ? row.timedOut ? 'тайм-аут' : 'выполнена · ОШИБКА' : 'выполнена · OK',
            sent: 'ответ отправлен', send_failed: 'ответ не отправлен', failed: 'ошибка выполнения', cancelled: 'отменена' };
        var text = row.method + ' · ' + labels[row.stage];
        if (typeof row.exitCode === 'number') text += ' · exit ' + row.exitCode;
        if (typeof row.durationMs === 'number') text += ' · ' + row.durationMs + ' мс';
        text += ' · #' + row.ref.slice(0, 8);
        return { label: row.stage === 'received' ? 'MUSE→' : 'MINI→', text: text, failed: failed };
    }
    function Timeline() { this.known = Object.create(null); }
    Timeline.prototype.update = function (messages, events) {
        var previous = this.known, next = Object.create(null), rows = [];
        (Array.isArray(messages) ? messages.slice(-100) : []).forEach(function (m, index) {
            if (!m || (m.role !== 'user' && m.role !== 'assistant')) return;
            var id = 'message:' + (typeof m.id === 'string' ? m.id : 'legacy-' + index);
            if (next[id]) return;
            var row = { kind: 'message', id: id, role: m.role, text: typeof m.text === 'string' ? m.text.slice(0, 40000) : '',
                pending: m.pending === true, createdAt: previous[id] ? previous[id].createdAt : time(m.createdAt), legacyOrder: index };
            next[id] = row; rows.push(row);
        });
        (Array.isArray(events) ? events.slice(-120) : []).forEach(function (value) {
            var row = audit(value); if (!row || next[row.id]) return;
            if (previous[row.id]) row.createdAt = previous[row.id].createdAt;
            next[row.id] = row; rows.push(row);
        });
        rows.sort(function (a, b) { return b.createdAt - a.createdAt || (b.legacyOrder || 0) - (a.legacyOrder || 0) || a.id.localeCompare(b.id); });
        this.known = next;
        return rows;
    };
    return { Timeline: Timeline, describe: describe };
});
