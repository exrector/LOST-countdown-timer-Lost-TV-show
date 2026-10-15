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
    // «Сон» — всегда пауза, «Утро» — всегда старт (какой бы ни была пауза до этого)
    function applySleep(on) {
        var b = document.getElementById('pauseResume');
        var drawn = document.querySelector('.lost-timer-number-1 .lost-flipper-prev .lost-flipper-number-table-cell');
        // страница ещё собирается или таймер ещё не создан (jQuery 3 запускает его асинхронно) — кнопка пока ничего не делает
        if (!b || document.readyState !== 'complete' || !drawn || drawn.textContent.trim() === '') return setTimeout(function () { applySleep(on); }, 300);
        var paused = b.textContent.indexOf('Старт') !== -1;
        if (on && !paused) { b.click(); log('сон: таймер на паузе'); }
        else if (!on && paused) { b.click(); log('утро: таймер идёт'); }
        setTimeout(reportState, 50);
    }
    function runCommand(d) {
        if (role !== 'tv') return;
        if (d.cmd === 'sleep') return applySleep(!!d.on);
        if (d.cmd === 'mode') { location.href = '?mode=' + encodeURIComponent(d.value); return; }
        if (d.cmd === 'click' && /^(#pauseResume|\.lost-timer-[\w-]+(\[data-seconds="\d+"\])?)$/.test(d.sel)) {
            var el = document.querySelector(d.sel);
            if (el) el.click(); else log('нет элемента ' + d.sel);
            setTimeout(reportState, 50);
        }
    }

    // Продолжить с того же места: сервер подставляет, где остановился таймер. Явный ?seconds= (кнопки Dev-панели) важнее.
    if (role === 'tv' && window.__LOST_RESUME) {
        var R = window.__LOST_RESUME, q = new URLSearchParams(location.search);
        var resumed = R.left > 0 && !q.get('seconds');
        if (resumed) { q.set('seconds', R.left); history.replaceState(null, '', '?' + q.toString()); }
        if (R.paused) document.addEventListener('DOMContentLoaded', function () { applySleep(true); });
        // сброс по коду возвращает таймер к стартовому времени (initialSeconds), а при продолжении стартовым стал остаток —
        // поэтому после продолжения сброс снова ведёт к 108:00, как в исходной логике
        if (resumed && window.lostTimer && lostTimer.prototype.reset) {
            var origReset = lostTimer.prototype.reset;
            lostTimer.prototype.reset = function () { this.initialSeconds = 60 * 108; return origReset.apply(this, arguments); };
        }
        // исходный таймер при старте рисует и секунды, а выше 4 минут их больше не обновляет (там всегда 00):
        // при продолжении с 107:27 на панели оставалось бы 108:27 — обнуляем секундные цифры, время не меняется
        // jQuery 3 запускает код таймера асинхронно, уже после 'load' — ждём, пока цифры нарисуются, и тогда обнуляем
        if (resumed && R.left > 240) {
            var zt = setInterval(function () {
                var sec = document.querySelector('.lost-timer-number-5 .lost-flipper-prev .lost-flipper-number-table-cell');
                if (!sec || sec.textContent.trim() === '') return;
                clearInterval(zt);
                document.querySelectorAll('.lost-timer-number-4 .lost-flipper-number-table-cell, .lost-timer-number-5 .lost-flipper-number-table-cell')
                    .forEach(function (c) { c.textContent = '0'; });
            }, 50);
            setTimeout(function () { clearInterval(zt); }, 10000);
        }
        // в журнал запуска: что реально показано на панели после продолжения
        window.addEventListener('load', function () {
            setTimeout(function () {
                var d = [1, 2, 3, 4, 5].map(function (n) { var c = document.querySelector('.lost-timer-number-' + n + ' .lost-flipper-prev .lost-flipper-number-table-cell') || document.querySelector('.lost-timer-number-' + n + ' .lost-flipper-number-table-cell'); return c ? c.textContent.trim() : '?'; });
                log('на панели: ' + d.slice(0, 3).join('') + ':' + d.slice(3).join('') + ' (осталось ' + R.left + ' с)');
            }, 1500);
        });
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
        ui.quit = item(main, 'Выход', { type: '__cmd', cmd: 'quit' });
        ui.live = item(main, 'Live Mode', { type: '__cmd', cmd: 'mode', value: 'live' });
        ui.devBtn = item(main, 'Dev Mode', { type: '__cmd', cmd: 'mode', value: 'dev' });

        var prompt = document.querySelector('.console-prompt');
        if (prompt) {
            prompt.title = 'Техническое меню (M)';
            prompt.addEventListener('mousedown', function (e) { e.preventDefault(); }); // фокус остаётся в поле ввода
            prompt.addEventListener('click', function () { box.classList.toggle('open'); });
        }
        (document.querySelector('.console-container') || document.body).appendChild(box);
        setupKeyboard(box);
    }

    // ================= Консоль: клавиатура (у компьютера нет мыши) =================
    // Код набирается цифрами и пробелами, поэтому буквы свободны под команды. Клавиши ловятся по физическому
    // положению (e.code), так что работают и в русской раскладке. Стрелки ходят по меню, Enter выбирает, Esc закрывает.
    function setupKeyboard(box) {
        var st = document.createElement('style');
        st.textContent = '.ctl a[data-key]::after{content:" [" attr(data-key) "]";opacity:.55}' +
            '.ctl a.sel{opacity:1;outline:1px solid #33ff88;outline-offset:3px}';
        document.head.appendChild(st);
        ui.pause.dataset.key = 'P'; ui.audio.dataset.key = 'S'; ui.quit.dataset.key = 'Q';
        ui.live.dataset.key = 'L'; ui.devBtn.dataset.key = 'D';

        var selEl = null, swallowEnter = false, quitArmed = 0, quitTimer;
        function isOpen() { return box.classList.contains('open'); }
        function select(el) { if (selEl) selEl.classList.remove('sel'); selEl = el; if (el) el.classList.add('sel'); }
        function open(on) { box.classList.toggle('open', on); if (!on) select(null); }
        function rows() {
            return Array.prototype.filter.call(box.querySelectorAll('.row'), function (r) { return r.style.display !== 'none'; })
                .map(function (r) { return Array.prototype.slice.call(r.querySelectorAll('a')); });
        }
        function move(dr, dc) {
            if (!isOpen()) open(true);
            var R = rows(), r = -1, c = 0;
            R.forEach(function (row, i) { var j = row.indexOf(selEl); if (j !== -1) { r = i; c = j; } });
            if (r === -1) return select(R[R.length - 1][0]); // первым выбирается «Пауза» в основной строке
            if (dr) { r = Math.max(0, Math.min(R.length - 1, r + dr)); c = Math.min(c, R[r].length - 1); }
            else c = (c + dc + R[r].length) % R[r].length;
            select(R[r][c]);
        }
        function quitPress() {
            if (Date.now() - quitArmed < 3000) return ui.quit.click();
            quitArmed = Date.now(); open(true); select(ui.quit);
            ui.quit.textContent = 'Выход — ещё раз Q';
            clearTimeout(quitTimer);
            quitTimer = setTimeout(function () { ui.quit.textContent = 'Выход'; quitArmed = 0; }, 3000);
        }
        var KEYS = {
            KeyP: function () { ui.pause.click(); },
            KeyS: function () { ui.audio.click(); },
            KeyD: function () { ui.devBtn.click(); },
            KeyL: function () { ui.live.click(); },
            KeyM: function () { open(!isOpen()); },
            KeyQ: quitPress,
            Escape: function () { open(false); },
            ArrowUp: function () { move(-1, 0); }, ArrowDown: function () { move(1, 0); },
            ArrowLeft: function () { move(0, -1); }, ArrowRight: function () { move(0, 1); }
        };
        // в журнал запуска (/tmp/lost-start.log): есть ли у окна терминала фокус клавиатуры
        log('клавиатура готова, фокус у страницы: ' + document.hasFocus());
        window.addEventListener('focus', function () { log('окно терминала получило фокус'); });
        window.addEventListener('blur', function () { log('окно терминала потеряло фокус'); });
        var lastCode = '', lastAt = 0; // клавиатура Informer (Teensy) дребезжит: одно нажатие иногда приходит дважды подряд
        document.addEventListener('keydown', function (e) {
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            if (e.key === 'Enter' && isOpen() && selEl) { e.preventDefault(); swallowEnter = true; selEl.click(); return; }
            var f = KEYS[e.code];
            if (!f) return;
            e.preventDefault(); // буква-команда не попадает в строку ввода кода
            if (e.repeat) return;
            var now = Date.now();
            if (e.code === lastCode && now - lastAt < 250) return;
            lastCode = e.code; lastAt = now;
            f();
        }, true);
        // console.html отправляет код по keyup Enter — если Enter выбрал пункт меню, код не отправляем
        document.addEventListener('keyup', function (e) {
            if (e.key === 'Enter' && swallowEnter) { swallowEnter = false; e.stopPropagation(); e.preventDefault(); }
        }, true);
    }
    if (role === 'console') document.addEventListener('DOMContentLoaded', buildPanel);

    // Терминал: курсор мыши прячется через 2 с без движения и возвращается при движении (меню >: — мышью)
    if (role === 'console') {
        var idleCss = document.createElement('style');
        idleCss.textContent = 'body.mouse-idle,body.mouse-idle *{cursor:none!important}';
        document.head.appendChild(idleCss);
        var idleTimer;
        function wake() {
            document.body.classList.remove('mouse-idle');
            clearTimeout(idleTimer);
            idleTimer = setTimeout(function () { document.body.classList.add('mouse-idle'); }, 2000);
        }
        ['mousemove', 'mousedown', 'wheel'].forEach(function (ev) { document.addEventListener(ev, wake, true); });
        document.addEventListener('DOMContentLoaded', wake);
    }
})();
