/* Пульт iMessage в меню станции (слова команд LOST правятся строкой через запятую)
   и раздел «КОМАНДЫ MAC MINI»: команды из «Команд» запускаются с терминала (K, ↑↓, Enter). */
(function () {
    'use strict';
    if (!document.body || !document.body.classList.contains('console-page')) return;
    var state = { remote: null, senders: 0 }, runs = {}, nextRun = 1, saves = Object.create(null), nextSave = 1;
    window.addEventListener('message', function (e) {
        if (!e.data) return;
        if (e.data.type === '__shortcut_result') { var shown = runs[e.data.id]; if (!shown) return; delete runs[e.data.id]; shown.text = result(e.data.text); window.dispatchEvent(new CustomEvent('lost-remote')); return; }
        if (e.data.type === '__remote_set_result') {
            var save = saves[e.data.requestId]; if (!save || e.data.id !== save.command) return;
            var valid = e.data.ok === true && Array.isArray(e.data.words) && e.data.words.length > 0 && e.data.words.length <= 40 && e.data.words.every(function (word) { return typeof word === 'string' && word.length > 0 && word.length <= 60; });
            if (!valid && e.data.ok !== false) return;
            delete saves[e.data.requestId]; clearTimeout(save.timer);
            save.shown.label = valid ? 'СОХРАНЕНО' : 'ОШИБКА';
            save.shown.text = valid ? save.label + ': ' + e.data.words.join(', ') : 'НЕ УДАЛОСЬ СОХРАНИТЬ СЛОВА. Прежние слова остаются.';
            window.dispatchEvent(new CustomEvent('lost-remote')); return;
        }
        if (e.data.type === '__remote_reply_set_result') {
            var put = saves[e.data.requestId]; if (!put || e.data.id !== put.reply) return;
            var good = e.data.ok === true && typeof e.data.text === 'string';
            if (!good && e.data.ok !== false) return;
            delete saves[e.data.requestId]; clearTimeout(put.timer);
            put.shown.label = good ? 'СОХРАНЕНО' : 'ОШИБКА';
            put.shown.text = good ? put.label + ':\n\n' + (e.data.text || '(пусто — только состояние станции)') : 'НЕ УДАЛОСЬ СОХРАНИТЬ ОТВЕТ. Прежний текст остаётся.';
            window.dispatchEvent(new CustomEvent('lost-remote')); return;
        }
        if (e.data.type !== '__remote') return;
        state = { remote: e.data.remote, senders: e.data.senders || 0 };
        window.dispatchEvent(new CustomEvent('lost-remote'));
    });
    if (window.__LOST_REMOTE) state = { remote: window.__LOST_REMOTE.remote, senders: window.__LOST_REMOTE.senders || 0 };
    function result(text) { text = String(text || ''); return /^ошибка/i.test(text) ? 'ОШИБКА.\n\n' + text.replace(/^ошибка:\s*/i, '') : 'ВЫПОЛНЕНО.' + (text && text !== 'готово' ? '\n\n' + text : ''); }
    function command(id) { return state.remote && state.remote.commands.filter(function (c) { return c.id === id; })[0]; }
    function words(id) { var c = command(id); return c ? c.words.join(', ') : ''; }
    function editor(cmd) {
        var node = { editor: true, confirmLabel: 'СОХРАНИТЬ', label: function () { return cmd.label + ': ' + words(cmd.id); }, pathLabel: cmd.label, draft: words(cmd.id),
            description: 'Слова через запятую. Сообщение, совпадающее со словом или содержащее его, выполняет команду «' + cmd.label + '». Enter — сохранить.',
            prepare: function (value) {
                var shown = { label: 'СОХРАНЕНИЕ', view: true, text: 'СОХРАНЕНИЕ…' };
                if (typeof value !== 'string' || value.length > 2000 || !value.split(',').some(function (word) { return word.trim() && word.trim().replace(/\s+/g, ' ').length <= 60; })) {
                    shown.label = 'ОШИБКА'; shown.text = 'Введите непустые слова через запятую. Прежние слова остаются.'; return shown;
                }
                var requestId = 'remote-set-' + nextSave++;
                saves[requestId] = { shown: shown, command: cmd.id, label: cmd.label, timer: setTimeout(function () {
                    if (!saves[requestId]) return; delete saves[requestId];
                    shown.label = 'НЕ ПОДТВЕРЖДЕНО'; shown.text = 'СОХРАНЕНИЕ НЕ ПОДТВЕРЖДЕНО. Проверьте слова в меню перед повтором.';
                    window.dispatchEvent(new CustomEvent('lost-remote'));
                }, 8000) };
                window.dispatchEvent(new CustomEvent('lost-remote-set', { detail: { id: cmd.id, words: value, requestId: requestId } }));
                node.draft = value;
                return shown;
            } };
        return node;
    }
    // Тексты ответов пульта (remote/replies.cjs). Поле однострочное: перенос строки пишется как \n.
    function reply(id) { return state.remote && (state.remote.replies || []).filter(function (r) { return r.id === id; })[0]; }
    function oneLine(text) { return String(text || '').replace(/\n/g, '\\n'); }
    function replyEditor(r) {
        var node = { editor: true, maxLength: 1000, confirmLabel: 'СОХРАНИТЬ', label: function () { var now = reply(r.id) || r; return r.label + (now.text === now.standard ? '' : ' *'); }, pathLabel: r.label, draft: oneLine((reply(r.id) || r).text),
            description: r.about + ' \\n — перенос строки. Пустая строка — стандартный текст: «' + (oneLine(r.standard) || 'пусто') + '». Enter — сохранить.',
            prepare: function (value) {
                var shown = { label: 'СОХРАНЕНИЕ', view: true, text: 'СОХРАНЕНИЕ…' };
                if (typeof value !== 'string' || value.length > 1000) { shown.label = 'ОШИБКА'; shown.text = 'Не длиннее 1000 знаков. Прежний текст остаётся.'; return shown; }
                var requestId = 'remote-reply-' + nextSave++;
                saves[requestId] = { shown: shown, reply: r.id, label: r.label, timer: setTimeout(function () {
                    if (!saves[requestId]) return; delete saves[requestId];
                    shown.label = 'НЕ ПОДТВЕРЖДЕНО'; shown.text = 'СОХРАНЕНИЕ НЕ ПОДТВЕРЖДЕНО. Проверьте текст в меню перед повтором.';
                    window.dispatchEvent(new CustomEvent('lost-remote'));
                }, 8000) };
                window.dispatchEvent(new CustomEvent('lost-remote-reply-set', { detail: { id: r.id, text: value.replace(/\\n/g, '\n'), requestId: requestId } }));
                node.draft = value;
                return shown;
            } };
        return node;
    }
    function replies() {
        var list = state.remote && state.remote.replies ? state.remote.replies.map(replyEditor) : [];
        if (!list.length) list.push({ label: 'НЕТ ДАННЫХ', view: true, staticText: 'СПИСОК ОТВЕТОВ ЕЩЁ НЕ ПОЛУЧЕН ОТ СТАНЦИИ.' });
        return { label: 'ОТВЕТЫ', dir: list, description: 'Что станция отвечает по iMessage и «Командам» iPhone. * — текст изменён. Состояние станции и список команд собираются из данных; меняются их заголовки.' };
    }
    function menu() {
        var list = state.remote ? state.remote.commands.map(editor) : [];
        list.push({ label: 'КОД: 4 8 15 16 23 42', view: true, staticText: 'Код принимается только в последние 4 минуты цикла: сообщение из одних цифр.' });
        list.push(replies());
        return { description: 'Станция читает iMessage от разрешённых номеров (' + state.senders + ') и выполняет команду LOST по её словам или команду из «Команд» Mac mini с тем же названием (список — МЕНЮ → МОДУЛИ → КОМАНДЫ MAC MINI, клавиша K). Ответ — сообщением с состоянием станции.', dir: list };
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
