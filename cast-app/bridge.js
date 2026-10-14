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
            if (d.type === '__audio') return setAudioMode(d.mode);
            if (d.type === '__sound') return playOnConsole(d);
            window.dispatchEvent(new MessageEvent('message', { data: d }));
        };
        ws.onclose = function () { setTimeout(connect, 1000); };
    }
    connect();

    // ================= Звук: где играть (mac | tv | off) =================
    var audioMode = 'speakers';
    var audioLabels = { speakers: 'Звук: динамики Мака', monitor: 'Звук: монитор (HDMI)', off: 'Звук: выкл' };
    function nativeSound() { return audioMode === 'speakers' || audioMode === 'monitor'; }
    function setAudioMode(m) {
        audioMode = m;
        if (role === 'console' && ui.audio) ui.audio.textContent = audioLabels[m] || audioLabels.speakers;
        if (role === 'console' && m !== 'mac') stopConsoleSounds();
    }

    // Консоль: свои звуки из тех же файлов, что и на ТВ
    var consoleSounds = {};
    function consoleSound(key) {
        if (!consoleSounds[key]) { consoleSounds[key] = new Audio('assets/sounds/' + key + '.mp3'); consoleSounds[key].preload = 'auto'; }
        return consoleSounds[key];
    }
    function playOnConsole(d) {
        if (role !== 'console' || audioMode !== 'mac') return;
        var a = consoleSound(d.key);
        if (d.op === 'pause') { a.pause(); a.currentTime = 0; }
        else { var p = a.play(); if (p && p.catch) p.catch(function (e) { log('звук ' + d.key + ' заблокирован: ' + e.message); }); }
    }
    var unlocked = false;
    function unlockSounds() {
        if (unlocked || role !== 'console') return; unlocked = true;
        SOUNDS.forEach(function (k) { var a = consoleSound(k); a.muted = true; var p = a.play(); (p && p.then ? p : Promise.resolve()).then(function () { a.pause(); a.currentTime = 0; a.muted = false; }, function () { a.muted = false; unlocked = false; }); });
    }
    ['mousedown', 'keydown', 'touchstart'].forEach(function (ev) { document.addEventListener(ev, unlockSounds, true); });
    function stopConsoleSounds() { Object.keys(consoleSounds).forEach(function (k) { consoleSounds[k].pause(); consoleSounds[k].currentTime = 0; }); }

    // ТВ: play()/pause() звуковых элементов таймера уходят на компьютер, если играть не на ТВ
    if (role === 'tv') {
        var origPlay = HTMLMediaElement.prototype.play, origPause = HTMLMediaElement.prototype.pause;
        var keyOf = function (el) { var m = /\/([\w-]+)\.mp3/.exec(el.getAttribute('src') || ''); return m ? m[1] : null; };
        HTMLMediaElement.prototype.play = function () {
            var key = keyOf(this);
            if (key && !nativeSound()) { if (audioMode === 'mac') send({ type: '__sound', op: 'play', key: key }); return Promise.resolve(); }
            return origPlay.apply(this, arguments);
        };
        HTMLMediaElement.prototype.pause = function () {
            var key = keyOf(this);
            if (key && !nativeSound()) { if (audioMode === 'mac') send({ type: '__sound', op: 'pause', key: key }); return; }
            return origPause.apply(this, arguments);
        };
    }

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
        // пульс ТВ раз в 10 с: по нему сервер понимает, что страница не зависла
        var born = Date.now();
        setInterval(function () {
            var m = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : '?';
            send({ type: '__alive', up: Math.round((Date.now() - born) / 1000), heap: m });
        }, 10000);
    }
    if (role === 'tv') {
        var css = document.createElement('style');
        css.textContent = '.timer-modes,.lost-timer-dev{display:none!important}html,body{cursor:none!important}' +
            // Chromecast 1: mask на 3D-слоях давал заминки до ~1 с при сбросе; clip-path даёт тот же вид, но заметно дешевле
            '.lost-flipper-number-before,.lost-flipper-number-after{-webkit-mask:none!important;mask:none!important}' +
            '.lost-flipper-number-before{-webkit-clip-path:inset(0 0 50% 0);clip-path:inset(0 0 50% 0)}' +
            '.lost-flipper-number-after{-webkit-clip-path:inset(50% 0 0 0);clip-path:inset(50% 0 0 0)}';
        document.head.appendChild(css);

        // ЖЁСТКАЯ СЦЕНА: таймер всегда того же размера и на том же месте, что бы ни было с окном/экраном.
        var ST = window.__LOST_STAGE || { w: 1560, h: 720 };
        var stCss = document.createElement('style');
        stCss.textContent = 'body.timer-page{display:block!important;overflow:hidden!important;height:100vh!important}' +
            'body.timer-page,body.timer-page *{cursor:none!important}' + // на панели курсор мыши не нужен: всё управление — с терминала
            '.my-timer-container{position:fixed!important;left:50%;top:50%;width:' + ST.w + 'px;height:' + ST.h + 'px;margin:-' + (ST.h / 2) + 'px 0 0 -' + (ST.w / 2) + 'px!important;display:flex;align-items:center;justify-content:center}';
        document.head.appendChild(stCss);
        window.addEventListener('resize', function (e) { e.stopImmediatePropagation(); }, true); // не пересчитывать масштаб при изменении окна
        function fixScale() {
            var el = document.querySelector('.lost-timer'); if (!el || !el.offsetWidth) return;
            var s = (ST.w / el.offsetWidth) * 0.98;
            el.style.transformOrigin = 'center center';
            el.style.transform = 'scale(' + s + ')';
            // исходная вёрстка смещает цифры (зазор между минутами и секундами, поля): центрируем по реальным границам блоков
            var f = el.querySelectorAll('.lost-flipper'); if (!f.length) return;
            var L = 1e9, R = -1e9, T = 1e9, B = -1e9;
            Array.prototype.forEach.call(f, function (x) { var r = x.getBoundingClientRect(); L = Math.min(L, r.left); R = Math.max(R, r.right); T = Math.min(T, r.top); B = Math.max(B, r.bottom); });
            var dx = innerWidth / 2 - (L + R) / 2, dy = innerHeight / 2 - (T + B) / 2;
            el.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(' + s + ')';
        }
        [300, 800, 2000].forEach(function (ms) { setTimeout(fixScale, ms); }); // после того, как исходный код выставит свой масштаб

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
            '.ctl a{color:#33ff88;text-shadow:0 0 5px rgba(51,255,136,.6);font-size:14px;cursor:pointer;white-space:nowrap;text-decoration:none;opacity:.6}' +
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
        item(ui.dev, 'Сброс таймера', click('.lost-timer-dev-action-reset'));
        item(ui.dev, 'Прокрутить иероглифы', click('.lost-timer-dev-action-glyphs'));
        SOUNDS.forEach(function (s) { item(ui.dev, '▶ ' + s, click('.lost-timer-play-' + s)); });

        var main = row(body);
        ui.pause = item(main, '⏸ Пауза', click('#pauseResume'));
        ui.audio = item(main, audioLabels[audioMode], null);
        ui.audio.addEventListener('click', function () {
            var next = { speakers: 'monitor', monitor: 'off', off: 'speakers' }[audioMode] || 'speakers';
            send({ type: '__audio', mode: next });
        });
        item(main, 'Выход', { type: '__cmd', cmd: 'quit' });
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
