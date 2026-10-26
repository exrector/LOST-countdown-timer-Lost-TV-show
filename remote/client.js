/* Пульт iMessage в меню станции: слова команд LOST (правятся строкой через запятую) и команды Mac mini. */
(function () {
    'use strict';
    if (!document.body || !document.body.classList.contains('console-page')) return;
    var state = { remote: null, senders: 0 };
    window.addEventListener('message', function (e) {
        if (!e.data || e.data.type !== '__remote') return;
        state = { remote: e.data.remote, senders: e.data.senders || 0 };
        window.dispatchEvent(new CustomEvent('lost-remote'));
    });
    function command(id) { return state.remote && state.remote.commands.filter(function (c) { return c.id === id; })[0]; }
    function words(id) { var c = command(id); return c ? c.words.join(', ') : ''; }
    function editor(cmd) {
        var node = { editor: true, label: function () { return cmd.label + ': ' + words(cmd.id); }, pathLabel: cmd.label, draft: words(cmd.id),
            description: 'Слова через запятую. Сообщение, совпадающее со словом или содержащее его, выполняет команду «' + cmd.label + '». Enter — сохранить.',
            prepare: function (value) {
                window.dispatchEvent(new CustomEvent('lost-remote-set', { detail: { id: cmd.id, words: value } }));
                node.draft = value;
                return { label: 'СОХРАНЕНО', view: true, staticText: cmd.label + ': ' + value + '\n\nПустая строка не сохраняется — прежние слова остаются.' };
            } };
        return node;
    }
    function menu() {
        var list = state.remote ? state.remote.commands.map(editor) : [];
        list.push({ label: 'КОД: 4 8 15 16 23 42', view: true, staticText: 'Код принимается только в последние 4 минуты цикла: сообщение из одних цифр.' });
        list.push({ label: 'КОМАНДЫ MAC MINI', view: true, staticText: shortcutsText() });
        return { description: 'Станция читает iMessage от разрешённых номеров (' + state.senders + ') и выполняет команду LOST по её словам или команду из «Команд» Mac mini с тем же названием. Ответ — сообщением с состоянием станции.', dir: list };
    }
    function shortcutsText() {
        var names = state.remote ? state.remote.shortcuts : [];
        if (!names.length) return 'В приложении «Команды» на Mac mini нет ни одной команды.';
        return 'Команды из приложения «Команды» на Mac mini. Сообщение с точным названием запускает команду.\nСписок меняется в самом приложении «Команды».\n\n' + names.join('\n');
    }
    window.LostRemote = { menu: menu, state: function () { return state; } };
})();
