/* Пульт iMessage в меню станции (слова команд LOST правятся строкой через запятую)
   и раздел «КОМАНДЫ MAC MINI»: команды из «Команд» запускаются с терминала (K, ↑↓, Enter). */
(function () {
    'use strict';
    if (!document.body || !document.body.classList.contains('console-page')) return;
    var state = { remote: null, senders: 0 }, runs = {}, nextRun = 1;
    window.addEventListener('message', function (e) {
        if (!e.data) return;
        if (e.data.type === '__shortcut_result') { var shown = runs[e.data.id]; if (!shown) return; delete runs[e.data.id]; shown.text = result(e.data.text); window.dispatchEvent(new CustomEvent('lost-remote')); return; }
        if (e.data.type !== '__remote') return;
        state = { remote: e.data.remote, senders: e.data.senders || 0 };
        window.dispatchEvent(new CustomEvent('lost-remote'));
    });
    function result(text) { text = String(text || ''); return /^ошибка/i.test(text) ? 'ОШИБКА.\n\n' + text.replace(/^ошибка:\s*/i, '') : 'ВЫПОЛНЕНО.' + (text && text !== 'готово' ? '\n\n' + text : ''); }
    function command(id) { return state.remote && state.remote.commands.filter(function (c) { return c.id === id; })[0]; }
    function words(id) { var c = command(id); return c ? c.words.join(', ') : ''; }
    function editor(cmd) {
        var node = { editor: true, confirmLabel: 'СОХРАНИТЬ', label: function () { return cmd.label + ': ' + words(cmd.id); }, pathLabel: cmd.label, draft: words(cmd.id),
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
        return { description: 'Станция читает iMessage от разрешённых номеров (' + state.senders + ') и выполняет команду LOST по её словам или команду из «Команд» Mac mini с тем же названием (список — МЕНЮ → КОМАНДЫ MAC MINI, клавиша K). Ответ — сообщением с состоянием станции.', dir: list };
    }
    // Команды из «Команд» Mac mini. Запуск меняет что-то за пределами LOST, поэтому только Enter (подтверждение).
    function shortcuts() {
        var names = state.remote ? state.remote.shortcuts : [];
        var list = names.map(function (name) {
            return { label: name, confirm: true, run: function () {
                var id = nextRun++, shown = { label: name, view: true, text: 'ЗАПУСК…' };
                runs[id] = shown;
                window.dispatchEvent(new CustomEvent('lost-shortcut-run', { detail: { id: id, name: name } }));
                return shown;
            } };
        });
        if (!list.length) list.push({ label: 'НЕТ КОМАНД', view: true, staticText: state.remote ? 'В приложении «Команды» на Mac mini нет ни одной команды.' : 'СПИСОК ЕЩЁ НЕ ПОЛУЧЕН ОТ СТАНЦИИ.' });
        return { description: 'Команды из приложения «Команды» на Mac mini. Enter — запустить. Список меняется в самом приложении «Команды»; та же команда запускается сообщением iMessage с её точным названием.', dir: list };
    }
    window.LostRemote = { menu: menu, shortcuts: shortcuts, state: function () { return state; } };
})();
