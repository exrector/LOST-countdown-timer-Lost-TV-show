/* Пульт в меню станции: iMessage и Siri со своими списками команд. Переключатели сохраняются ядром. */
(function () {
    'use strict';
    if (!document.body || !document.body.classList.contains('console-page')) return;
    var state = { remote: null, senders: 0, address: '' };
    window.addEventListener('message', function (e) {
        if (!e.data || e.data.type !== '__remote') return;
        state = { remote: e.data.remote, senders: e.data.senders || 0, address: e.data.address || '' };
        window.dispatchEvent(new CustomEvent('lost-remote'));
    });
    function modules() { return window.__LOST_MODULES || {}; }
    function set(channel, key, enabled) { window.dispatchEvent(new CustomEvent('lost-remote-set', { detail: { channel: channel, key: key, enabled: enabled } })); }
    function own(channel) { return state.remote && state.remote[channel]; }
    function onOff(v) { return v ? 'ВКЛ' : 'ВЫКЛ'; }
    function channelDir(channel, title, description) {
        var dir = function () {
            var c = own(channel); if (!c) return [{ label: 'НЕТ ДАННЫХ ОТ ЯДРА', view: true, staticText: 'Ядро ещё не прислало настройки пульта. ←/ESC НАЗАД.' }];
            var rows = c.commands.map(function (cmd) {
                return { label: function () { var x = own(channel), now = x && x.commands.filter(function (y) { return y.id === cmd.id; })[0]; return cmd.label + ': ' + onOff(now && now.enabled); },
                    act: function () { var x = own(channel), now = x && x.commands.filter(function (y) { return y.id === cmd.id; })[0]; set(channel, cmd.id, !(now && now.enabled)); } };
            });
            rows.push({ label: function () { var x = own(channel); return 'КОМАНДЫ SIRI ПО НАЗВАНИЮ: ' + onOff(x && x.shortcuts); },
                act: function () { var x = own(channel); set(channel, 'shortcuts', !(x && x.shortcuts)); } });
            rows.push({ label: 'СПРАВКА', view: true, staticText: help(channel) });
            return rows;
        };
        return { label: function () { var m = modules()[channel]; return title + ': ' + (m && m.enabled ? 'ВКЛ' : 'ВЫКЛ'); }, pathLabel: title, description: description, dir: [], onEnter: null, build: dir };
    }
    function help(channel) {
        var c = own(channel); if (!c) return 'НЕТ ДАННЫХ';
        var lines = c.commands.map(function (cmd) { return (cmd.enabled ? '  ' : '✕ ') + cmd.label + new Array(Math.max(2, 16 - cmd.label.length)).join(' ') + cmd.phrases.join(', '); });
        return 'КОМАНДЫ ' + c.name.toUpperCase() + ' (✕ — выключена):\n\n' + lines.join('\n') +
            (c.shortcuts ? '\n\nСообщение, точно совпадающее с названием разрешённой команды Siri на Mac mini, запускает её (список — «ПУЛЬТ → SIRI»).' : '\n\nЗапуск команд Siri по названию выключен.') +
            '\n\nЕсли станция не поняла текст, она отвечает этой справкой.';
    }
    function menu() {
        var address = state.address || 'адрес-станции';
        var im = channelDir('imessage', 'iMESSAGE', 'Глобально, откуда угодно. Сообщения на Apple ID станции принимаются только от разрешённых номеров (' + state.senders + ' в config.json → sleepFrom); ответ приходит сообщением с состоянием станции.' + (state.senders ? '' : ' Разрешённых номеров нет — канал молчит.'));
        var lan = channelDir('siri', 'КОМАНДЫ LOST ПО АДРЕСУ СТАНЦИИ', 'Для команд Siri на iPhone и HomePod дома: «Получить содержимое URL» http://' + address + ':8765/__cmd?text=Пауза (или /__sleep?on=1|0 для «Сна»). Из tailnet запросы не принимаются.');
        lan.label = 'КОМАНДЫ LOST ПО АДРЕСУ СТАНЦИИ';
        var siri = { label: function () { var m = modules().siri; return 'SIRI: ' + (m && m.enabled ? 'ВКЛ' : 'ВЫКЛ'); }, pathLabel: 'SIRI',
            description: 'Команды Siri — команды приложения «Команды» на Mac mini. Голосом Siri они работают дома сами по себе; по iMessage их запускает LOST, если слово совпало с названием. Здесь — какие из них станции разрешено запускать.', dir: [] };
        siri.onEnter = function () {
            var list = (state.remote && state.remote.siriCommands) || [];
            siri.dir = list.map(function (cmd) {
                return { label: function () { var now = ((state.remote && state.remote.siriCommands) || []).filter(function (x) { return x.name === cmd.name; })[0]; return cmd.name.toUpperCase() + ': ' + onOff(now && now.enabled); },
                    act: function () { var now = ((state.remote && state.remote.siriCommands) || []).filter(function (x) { return x.name === cmd.name; })[0]; set('siri-command', cmd.name, !(now && now.enabled)); } };
            });
            if (!list.length) siri.dir.push({ label: 'КОМАНД SIRI НА MAC MINI НЕТ', view: true, staticText: 'Приложение «Команды» на станции не вернуло ни одной команды.' });
            siri.dir.push(lan);
        };
        [im, lan].forEach(function (node) { node.onEnter = function () { node.dir = node.build(); }; });
        return { description: 'Пульт станции: iMessage — отовсюду; Siri — команды «Команд» Mac mini. Выключить целиком — «МОДУЛИ».', dir: [im, siri] };
    }
    window.LostRemote = { menu: menu, state: function () { return state; } };
})();
