/* Раздел «AI» в меню станции: данные ассистента Muse и его возможности. Растёт вместе с модулем:
   новые настройки (голосовые ответы, своя диктовка Whisper и т. д.) добавляются сюда пунктами. */
(function (root, factory) {
    var Menu = factory();
    if (typeof module === 'object' && module.exports) module.exports = Menu;
    if (root && root.document) root.LostMuseMenu = Menu;
})(typeof window === 'undefined' ? null : window, function () {
    'use strict';
    var STATUS = { ready: 'НА СВЯЗИ', connecting: 'СОЕДИНЕНИЕ', starting: 'ЗАПУСК', reconnecting: 'ПЕРЕПОДКЛЮЧЕНИЕ', disabled: 'ВЫКЛЮЧЕН', not_installed: 'НЕ УСТАНОВЛЕН', unavailable: 'НЕТ СВЯЗИ', error: 'ОШИБКА', revoked: 'ПАРА ОТОЗВАНА', stopping: 'ОСТАНОВКА' };
    var PHASE = { idle: 'ГОТОВ К РАЗГОВОРУ', sending: 'ОТПРАВЛЯЕТ', waiting: 'ЖДЁТ ОТВЕТ', thinking: 'ЖДЁТ ОТВЕТ', streaming: 'ОТВЕЧАЕТ', replying: 'ОТВЕЧАЕТ', responding: 'ОТВЕЧАЕТ' };
    function parse(raw) { try { return typeof raw === 'string' ? JSON.parse(raw) : raw || {}; } catch (_) { return null; } }
    function line(name, value) { return (name + '                      ').slice(0, 20) + value; }
    function status(raw) {
        var d = parse(raw); if (!d) return 'ДАННЫЕ НЕДОСТУПНЫ. ←/ESC НАЗАД; ОТКРОЙТЕ СНОВА ДЛЯ ПОВТОРА.';
        var m = d.module || {}, c = d.chat || {}, messages = Array.isArray(c.messages) ? c.messages : [];
        var mic = (typeof window !== 'undefined' && window.__LOST_MUSE_MIC) || null;
        return [
            line('АССИСТЕНТ', 'Muse Gadget'),
            line('МОДУЛЬ', m.enabled === false ? 'ВЫКЛЮЧЕН' : STATUS[m.status] || String(m.status || 'НЕТ ДАННЫХ').toUpperCase()),
            line('РАЗГОВОР', PHASE[c.phase] || String(c.phase || '—').toUpperCase()),
            line('СООБЩЕНИЙ', String(messages.length)),
            line('МИКРОФОН', mic ? (mic.available ? (mic.device || 'ЕСТЬ') : 'НЕ ПОДКЛЮЧЁН') : 'ДАННЫЕ ПОЯВЯТСЯ ПОСЛЕ ОТКРЫТИЯ AI'),
            line('РАСПОЗНАВАНИЕ', 'СЕРВЕР MUSE (СВОЯ ДИКТОВКА WHISPER — ПОСЛЕ MAC MINI M4)'),
            line('ПОСЛЕДНЯЯ ОШИБКА', (c.error || m.error || '—')),
            d.preview ? '\nТЕСТ ИНТЕРФЕЙСА: ответы Muse имитируются.' : ''
        ].join('\n');
    }
    function history(raw) {
        var d = parse(raw); if (!d) return 'ДАННЫЕ НЕДОСТУПНЫ. ←/ESC НАЗАД; ОТКРОЙТЕ СНОВА ДЛЯ ПОВТОРА.';
        var messages = (d.chat && Array.isArray(d.chat.messages) ? d.chat.messages : []).slice(-30).reverse();
        if (!messages.length) return 'ИСТОРИЯ ПУСТА.';
        return 'ПОСЛЕДНИЕ ' + messages.length + ', НОВЫЕ СВЕРХУ\n\n' + messages.map(function (m) {
            return (m.role === 'user' ? '>:    ' : m.role === 'assistant' ? 'muse: ' : '      ') + String(m.text || '').slice(0, 2000);
        }).join('\n\n');
    }
    var CONTROLS = [
        'ВЫЗОВ          набрать AI и Enter (или пункт «ОТКРЫТЬ ДИАЛОГ»)',
        'ТЕКСТ          ввести и Enter — уходит Muse',
        'ГОЛОС          удерживать RESET — запись до 45 с; отпустить — черновик; Enter — отправить',
        'ОТМЕНА         Esc — отменить запись; ещё Esc — выйти из AI',
        'МЕНЮ           → — выйти из AI в меню станции',
        'ПРОКРУТКА      ↑/↓ при пустой строке ввода',
        '',
        'В последние 8 минут цикла AI закрывается сам, недоотправленная запись отменяется:',
        'терминал оставлен для кода.'
    ].join('\n');
    var CAPABILITIES = [
        'ЕСТЬ',
        '  текстовый разговор, лента от новых к старым',
        '  голосовой запрос с микрофона станции (WAV 16 кГц, моно)',
        '  переподключение к Muse, сохранённая пара',
        '',
        'ДАЛЬШЕ (будут пунктами этого раздела)',
        '  своя диктовка Whisper large-v3 на Mac mini M4 — muse/DICTATION-WHISPER.md',
        '  ответы голосом (Muse умеет MP3-ответ)',
        '  аватар и состояния персонажа в цветах терминала'
    ].join('\n');
    function menu(openDialog) {
        return { description: 'Ассистент Muse в терминале станции. Выключить модуль — «МОДУЛИ → mUse».', dir: [
            { label: 'ОТКРЫТЬ ДИАЛОГ', key: 'AI', act: openDialog },
            { label: 'СОСТОЯНИЕ', view: true, endpoint: '/__muse/state', format: status },
            { label: 'ИСТОРИЯ', view: true, endpoint: '/__muse/state', format: history },
            { label: 'УПРАВЛЕНИЕ', view: true, staticText: CONTROLS },
            { label: 'ВОЗМОЖНОСТИ', view: true, staticText: CAPABILITIES }
        ] };
    }
    return { menu: menu, status: status, history: history };
});
