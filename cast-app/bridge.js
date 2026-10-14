// Транспортный адаптер: подменяет window.open/window.opener + postMessage на WebSocket.
// Логика index.html / console.html не меняется — они по-прежнему «говорят» через postMessage.
//
// ТВ (index.html):  показывает ТОЛЬКО таймер. Нижнее меню и Dev-панель скрыты CSS-ом (остаются в DOM).
// Консоль (console.html): терминал + всё управление; нажатия уходят на ТВ и превращаются в клики по скрытым элементам.
(function () {
    var role = location.pathname.indexOf('console') !== -1 ? 'console' : 'tv';
    var ws, queue = [], fake = { closed: false };
    var SOUNDS = ['alarm', 'beep', 'discharge', 'keypress', 'reset', 'spinup', 'systemfailure', 'thud', 'tick', 'timeout'];

    function raw(s) { if (ws && ws.readyState === 1) ws.send(s); else queue.push(s); }
    function send(data) { raw(JSON.stringify(data)); }
    function log(msg) { send({ type: '__log', role: role, msg: String(msg) }); }
    window.addEventListener('error', function (e) { log('JS error: ' + e.message + ' @' + e.filename + ':' + e.lineno); });

    fake.postMessage = function (data) { send(data); };
    fake.focus = function () {};

    function connect() {
        ws = new WebSocket('ws://' + location.host + '/bridge?role=' + role);
        ws.onopen = function () {
            queue.splice(0).forEach(function (s) { ws.send(s); });
            if (role === 'tv') reportState();
        };
        ws.onmessage = function (e) {
            var d = JSON.parse(e.data);
            if (d.type === '__cmd') return runCommand(d);
            if (d.type === '__state') return applyState(d);
            window.dispatchEvent(new MessageEvent('message', { data: d }));
        };
        ws.onclose = function () { setTimeout(connect, 1000); };
    }
    connect();

    // ================= ТВ =================
    function tvMode() { return new URLSearchParams(location.search).get('mode') || 'live'; }
    function reportState() {
        var b = document.getElementById('pauseResume');
        send({ type: '__state', mode: tvMode(), label: b ? b.textContent : '' });
    }
    function runCommand(d) {
        if (role !== 'tv') return;
        if (d.cmd === 'mode') { location.href = '?mode=' + encodeURIComponent(d.value); return; }
        if (d.cmd === 'click' && /^(#pauseResume|\.lost-timer-[\w-]+(\[data-seconds="\d+"\])?)$/.test(d.sel)) {
            var el = document.querySelector(d.sel);
            if (el) el.click(); else log('нет элемента ' + d.sel);
            setTimeout(reportState, 50);
        }
    }

    if (role === 'tv') {
        var css = document.createElement('style');
        css.textContent = '.timer-modes,.lost-timer-dev{display:none!important}html,body{cursor:none!important}';
        document.head.appendChild(css);

        var opened = false, tries = 0;
        var t = setInterval(function () {
            var b = document.getElementById('openConsole');
            if (b && !opened) { b.click(); opened = true; log('канал консоли открыт'); }
            if (opened || ++tries > 20) clearInterval(t);
        }, 500);
        window.open = function () { return fake; }; // index.html «открывает консоль» — на ТВ это WebSocket
    } else {
        Object.defineProperty(window, 'opener', { value: fake, configurable: true }); // console.html шлёт в opener
    }

    // ================= Консоль: панель управления =================
    var ui = {};
    function applyState(d) {
        if (d.label && ui.pause) ui.pause.textContent = d.label;
        if (d.mode && ui.dev) {
            ui.live.style.opacity = d.mode === 'live' ? 1 : .55;
            ui.devBtn.style.opacity = d.mode === 'dev' ? 1 : .55;
            ui.dev.style.display = d.mode === 'dev' ? 'flex' : 'none';
        }
    }
    function buildPanel() {
        var st = document.createElement('style');
        st.textContent = '.ctl{position:relative;z-index:2;margin-top:18px;font-family:"Courier New",Courier,monospace}' +
            '.ctl a{color:#00ff00;text-shadow:0 0 5px rgba(0,255,0,.6);font-size:14px;cursor:pointer;white-space:nowrap;text-decoration:none;opacity:.6}' +
            '.ctl a:hover{opacity:1;text-decoration:none}' +
            '.ctl .body{display:none}.ctl.open .body{display:block}' +
            '.ctl .row{display:flex;flex-wrap:wrap;gap:6px 24px;padding:4px 0}' +
            '.console-prompt{cursor:pointer;-webkit-user-select:none;user-select:none;line-height:1;display:block}' +
            // строка ввода: >: и поле на одной вертикальной оси
            '.console-container{display:flex;flex-wrap:wrap;align-items:center;align-content:flex-start}' +
            '.console-input{flex:1;width:auto;margin-left:8px;display:block}' +
            '.my-console{padding:0;margin:0;display:block;line-height:1.2}' +
            '.ctl{flex-basis:100%}' +
            // верхняя подпись остаётся над рамкой, но получает ту же «развёртку», что и экран терминала
            '.timer-status{position:relative;filter:brightness(.83)}' +
            '.timer-status::before{content:"";position:absolute;left:0;right:0;top:0;bottom:0;pointer-events:none;' +
            'background:repeating-linear-gradient(0deg,rgba(0,0,0,.15) 0,rgba(0,0,0,.15) 1px,transparent 1px,transparent 3px)}';
        document.head.appendChild(st);

        var box = document.createElement('div');
        box.className = 'ctl';
        var body = document.createElement('div'); body.className = 'body'; box.appendChild(body);
        function row(parent) { var r = document.createElement('div'); r.className = 'row'; parent.appendChild(r); return r; }
        function item(parent, text, msg) {
            var a = document.createElement('a'); a.textContent = text;
            a.addEventListener('mousedown', function (e) { e.preventDefault(); }); // не уводить фокус из поля ввода
            if (msg) a.addEventListener('click', function () { send(msg); });
            parent.appendChild(a); return a;
        }
        function click(sel) { return { type: '__cmd', cmd: 'click', sel: sel }; }

        ui.dev = row(body); ui.dev.style.display = 'none'; // Dev-панель: только в Dev Mode
        [['108 минут', 6480], ['4 минуты', 240], ['1 минута', 60], ['10 секунд', 10]].forEach(function (p) {
            item(ui.dev, 'Таймер: ' + p[0], click('.lost-timer-dev-action-set[data-seconds="' + p[1] + '"]'));
        });
        item(ui.dev, 'Звук вкл/выкл', click('.lost-timer-dev-action-sound'));
        item(ui.dev, 'Сброс таймера', click('.lost-timer-dev-action-reset'));
        item(ui.dev, 'Прокрутить иероглифы', click('.lost-timer-dev-action-glyphs'));
        SOUNDS.forEach(function (s) { item(ui.dev, '▶ ' + s, click('.lost-timer-play-' + s)); });

        var main = row(body);
        ui.pause = item(main, '⏸ Пауза', click('#pauseResume'));
        ui.live = item(main, 'Live Mode', { type: '__cmd', cmd: 'mode', value: 'live' });
        ui.devBtn = item(main, 'Dev Mode', { type: '__cmd', cmd: 'mode', value: 'dev' });

        var prompt = document.querySelector('.console-prompt');
        if (prompt) {
            prompt.title = 'Техническое меню';
            prompt.addEventListener('mousedown', function (e) { e.preventDefault(); }); // фокус остаётся в поле ввода
            prompt.addEventListener('click', function () { box.classList.toggle('open'); });
        }
        (document.querySelector('.console-container') || document.body).appendChild(box);
    }
    if (role === 'console') document.addEventListener('DOMContentLoaded', buildPanel);
})();
