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

    fake.postMessage = function (data) {
        // таймер шлёт остаток каждую секунду — помечаем режимом, чтобы сервер не путал таймеры Live и Dev
        if (role === 'tv' && data && data.type === 'enableConsole') data.mode = new URLSearchParams(location.search).get('mode') === 'dev' ? 'dev' : 'live';
        send(data);
    };
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
    function nativeSound() { return audioMode === 'speakers' || audioMode === 'monitor'; }
    function setAudioMode(m) {
        audioMode = m;
        if (role === 'console' && ui.render) ui.render();
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
        css.textContent = '.timer-modes,.lost-timer-dev{display:none!important}' +
            // Chromecast 1: mask на 3D-слоях давал заминки до ~1 с при сбросе; clip-path даёт тот же вид, но заметно дешевле
            '.lost-flipper-number-before,.lost-flipper-number-after{-webkit-mask:none!important;mask:none!important}' +
            '.lost-flipper-number-before{-webkit-clip-path:inset(0 0 50% 0);clip-path:inset(0 0 50% 0)}' +
            '.lost-flipper-number-after{-webkit-clip-path:inset(50% 0 0 0);clip-path:inset(50% 0 0 0)}';
        document.head.appendChild(css);

        // ЖЁСТКАЯ СЦЕНА: таймер всегда того же размера и на том же месте, что бы ни было с окном/экраном.
        var ST = window.__LOST_STAGE || { w: 1560, h: 720 };
        var stCss = document.createElement('style');
        stCss.textContent = 'body.timer-page{display:block!important;overflow:hidden!important;height:100vh!important}' +
            '.my-timer-container{position:fixed!important;left:50%;top:50%;width:' + ST.w + 'px;height:' + ST.h + 'px;margin:-' + (ST.h / 2) + 'px 0 0 -' + (ST.w / 2) + 'px!important;display:flex;align-items:center;justify-content:center}';
        document.head.appendChild(stCss);
        window.addEventListener('resize', function (e) { e.stopImmediatePropagation(); }, true); // не пересчитывать масштаб при изменении окна
        function fixScale() {
            var el = document.querySelector('.lost-timer'); if (!el || !el.offsetWidth) return;
            var s = (ST.w / el.offsetWidth) * 0.98 * (ST.scale || 1); // scale — config.json → stage.scale (1 = по ширине панели)
            el.style.transformOrigin = 'center center';
            el.style.transform = 'scale(' + s + ')';
            // исходная вёрстка смещает цифры (зазор между минутами и секундами, поля): центрируем по реальным границам блоков
            var f = el.querySelectorAll('.lost-flipper'); if (!f.length) return;
            var L = 1e9, R = -1e9, T = 1e9, B = -1e9;
            Array.prototype.forEach.call(f, function (x) { var r = x.getBoundingClientRect(); L = Math.min(L, r.left); R = Math.max(R, r.right); T = Math.min(T, r.top); B = Math.max(B, r.bottom); });
            var dx = innerWidth / 2 - (L + R) / 2, dy = innerHeight / 2 - (T + B) / 2;
            el.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(' + s + ')';
            fixScale.size = Math.round(R - L) + '×' + Math.round(B - T);
        }
        setTimeout(function () { log('таймер: блок цифр ' + fixScale.size + ' из ' + ST.w + '×' + ST.h + ' (масштаб ' + (ST.scale || 1) + ')'); }, 2600);
        setTimeout(function () { log('окно таймера: x=' + screenX + ' y=' + screenY + ' ' + innerWidth + '×' + innerHeight); }, 2700);
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

    // ================= Консоль: меню в стиле старого файлового менеджера =================
    // Вертикальный список в рамке, папки <DIR>, путь в заголовке (LOST:\МЕНЮ\…), выбранная строка — инверсия.
    // ↑↓ — по строкам, Enter/→ — войти/выполнить, ←/Esc — назад, M — открыть/закрыть; буквы-команды работают всегда.
    var ui = { paused: false, mode: 'live' };
    function applyState(d) {
        if (d.label) ui.paused = d.label.indexOf('Старт') !== -1;
        if (d.mode) ui.mode = d.mode;
        if (ui.render) ui.render();
        if (ui.onPause) ui.onPause(ui.paused);
    }
    function buildPanel() {
        var st = document.createElement('style');
        st.textContent = '.console-prompt{cursor:pointer;-webkit-user-select:none;user-select:none;line-height:1;display:block}' +
            // строка ввода: >: и поле на одной вертикальной оси
            '.console-container{display:flex;flex-wrap:wrap;align-items:center;align-content:flex-start}' +
            '.console-input{flex:1;width:auto;margin-left:8px;display:block}' +
            '.my-console{padding:0;margin:0;display:block;line-height:1.2}' +
            // верхняя подпись остаётся над рамкой, но получает ту же «развёртку», что и экран терминала
            '.timer-status{position:relative;filter:brightness(.83)}' +
            '.timer-status::before{content:"";position:absolute;left:0;right:0;top:0;bottom:0;pointer-events:none;' +
            'background:repeating-linear-gradient(0deg,rgba(0,0,0,.15) 0,rgba(0,0,0,.15) 1px,transparent 1px,transparent 3px)}' +
            // меню
            '.ctl{flex-basis:100%;position:relative;z-index:2;margin-top:18px;display:none;font-family:"Courier New",Courier,monospace}' +
            '.ctl.open{display:block}' +
            '.ctl .win{display:inline-block;min-width:440px;border:2px double #33ff88;background:#09120d;' +
            'box-shadow:0 0 8px rgba(51,255,136,.35);color:#33ff88;text-shadow:0 0 5px rgba(51,255,136,.6)}' +
            '.ctl .ttl{padding:3px 10px;border-bottom:1px solid #33ff88;font-size:15px;letter-spacing:1px;opacity:.85}' +
            '.ctl .row{display:flex;justify-content:space-between;gap:24px;padding:3px 10px;font-size:17px;cursor:pointer;white-space:nowrap}' +
            '.ctl .row .k{opacity:.6}' +
            '.ctl .row.sel{background:#33ff88;color:#09120d;text-shadow:none}' +
            '.ctl .row.sel .k{opacity:.8}' +
            '.ctl .ft{padding:3px 10px;border-top:1px solid #33ff88;font-size:13px;opacity:.6}' +
            '.ctl .view{margin:0;padding:6px 10px;font:15px/1.35 "Courier New",Courier,monospace;white-space:pre-wrap;width:80ch;max-width:80vw;min-height:120px}';
        document.head.appendChild(st);

        function click(sel) { return function () { send({ type: '__cmd', cmd: 'click', sel: sel }); }; }
        function mode(v) { return function () { send({ type: '__cmd', cmd: 'mode', value: v }); }; }
        var AUDIO = { speakers: 'ДИНАМИКИ', monitor: 'МОНИТОР', off: 'ВЫКЛ' };
        var quitArmed = 0, quitTimer;
        function quit() {
            if (Date.now() - quitArmed < 3000) return send({ type: '__cmd', cmd: 'quit' });
            quitArmed = Date.now(); clearTimeout(quitTimer);
            quitTimer = setTimeout(function () { quitArmed = 0; render(); }, 3000);
            render();
        }
        // дерево меню: label — строка или функция; dir — вложенная папка; key — подсказка клавиши
        var TIMERS = { label: 'ТАЙМЕР', dir: [['108 МИН', 6480], ['4 МИН', 240], ['1 МИН', 60], ['10 СЕК', 10]].map(function (p) {
            return { label: p[0], act: click('.lost-timer-dev-action-set[data-seconds="' + p[1] + '"]') }; }) };
        var SOUNDS_DIR = { label: 'ЗВУКИ', dir: SOUNDS.map(function (s) { return { label: s.toUpperCase(), act: click('.lost-timer-play-' + s) }; }) };
        var DEV = { label: 'РАЗРАБОТКА', dir: [TIMERS,
            { label: 'СБРОС ТАЙМЕРА', act: click('.lost-timer-dev-action-reset') },
            { label: 'ИЕРОГЛИФЫ', act: click('.lost-timer-dev-action-glyphs') },
            SOUNDS_DIR] };
        var ROOT = { label: 'МЕНЮ', dir: [
            { label: function () { return ui.paused ? 'СТАРТ' : 'ПАУЗА'; }, key: 'P', act: click('#pauseResume') },
            { label: function () { return 'ЗВУК: ' + (AUDIO[audioMode] || 'ДИНАМИКИ'); }, key: 'S', act: function () {
                send({ type: '__audio', mode: { speakers: 'monitor', monitor: 'off', off: 'speakers' }[audioMode] || 'speakers' }); } },
            { label: function () { return 'РЕЖИМ: ' + (ui.mode === 'dev' ? 'DEV' : 'LIVE'); }, key: 'D/L', act: function () { mode(ui.mode === 'dev' ? 'live' : 'dev')(); } },
            { label: 'ЖУРНАЛ', view: true },
            { label: 'ЭНЕРГОКОНТУР', key: 'U', act: function () { open(false); if (window.LostUPS) window.LostUPS.openMenu(); } },
            { label: 'РАЗРАБОТКА', dir: DEV.dir, devOnly: true },
            { label: function () { return quitArmed ? 'ВЫХОД? ЕЩЁ РАЗ' : 'ВЫХОД'; }, key: 'Q Q', act: quit }
        ] };

        var box = document.createElement('div'); box.className = 'ctl';
        var win = document.createElement('div'); win.className = 'win'; box.appendChild(win);
        var path = [ROOT], sel = 0;
        function items() { var n = path[path.length - 1]; return n.view ? [] : n.dir.filter(function (it) { return !it.devOnly || ui.mode === 'dev'; }); }
        function text(v) { return typeof v === 'function' ? v() : v; }
        function render() {
            var list = items(); if (sel >= list.length) sel = list.length - 1; if (sel < 0) sel = 0;
            win.innerHTML = '';
            var ttl = document.createElement('div'); ttl.className = 'ttl';
            ttl.textContent = 'LOST:\\' + path.map(function (n) { return text(n.label); }).join('\\');
            win.appendChild(ttl);
            var node = path[path.length - 1];
            if (node.view) {
                var pre = document.createElement('pre'); pre.className = 'view'; pre.textContent = node.text || 'ЗАГРУЗКА...';
                win.appendChild(pre);
                var f = document.createElement('div'); f.className = 'ft'; f.textContent = '← НАЗАД  ESC ЗАКРЫТЬ'; win.appendChild(f);
                return;
            }
            list.forEach(function (it, i) {
                var r = document.createElement('div'); r.className = 'row' + (i === sel ? ' sel' : '');
                var l = document.createElement('span'); l.textContent = text(it.label);
                var k = document.createElement('span'); k.className = 'k'; k.textContent = it.dir ? '<DIR>' : it.view ? '<ФАЙЛ>' : (it.key ? '[' + it.key + ']' : '');
                r.appendChild(l); r.appendChild(k);
                r.addEventListener('mousedown', function (e) { e.preventDefault(); }); // фокус остаётся в поле ввода
                r.addEventListener('click', function () { sel = i; enter(); });
                win.appendChild(r);
            });
            var ft = document.createElement('div'); ft.className = 'ft';
            ft.textContent = path.length > 1 ? '↑↓ ВЫБОР  ENTER ОК  ← НАЗАД  ESC ВЫХОД' : '↑↓ ВЫБОР  ENTER ОК  ESC ЗАКРЫТЬ';
            win.appendChild(ft);
        }
        function isOpen() { return box.classList.contains('open'); }
        function open(on) { box.classList.toggle('open', on); if (on) { path = [ROOT]; sel = 0; render(); } }
        function enter() {
            var it = items()[sel]; if (!it) return;
            if (it.dir) { path.push(it); sel = 0; render(); return; }
            if (it.view) {
                it.text = ''; path.push(it); render();
                fetch('/__journal?lines=14').then(function (r) { return r.text(); }).then(function (t) {
                    it.text = t || '(ЖУРНАЛ ПУСТ)'; render();
                });
                return;
            }
            if (it.act) it.act();
            setTimeout(render, 150);
        }
        function back() { if (path.length > 1) { var from = path.pop(); sel = Math.max(0, items().indexOf(from)); render(); } else open(false); }
        function move(d) { if (!isOpen()) return open(true); var n = items().length; if (!n) return; sel = (sel + d + n) % n; render(); }
        ui.render = render;

        var prompt = document.querySelector('.console-prompt');
        if (prompt) {
            prompt.title = 'Меню (M)';
            prompt.addEventListener('mousedown', function (e) { e.preventDefault(); }); // фокус остаётся в поле ввода
            prompt.addEventListener('click', function () { open(!isOpen()); });
        }
        (document.querySelector('.console-container') || document.body).appendChild(box);
        render();

        // ===== Клавиатура (у компьютера нет мыши) =====
        // Код набирается цифрами и пробелами, поэтому буквы свободны под команды. Клавиши ловятся по физическому
        // положению (e.code), так что работают и в русской раскладке.
        var KEYS = {
            KeyP: click('#pauseResume'),
            KeyS: ROOT.dir[1].act,
            KeyD: mode('dev'),
            KeyL: mode('live'),
            KeyM: function () { open(!isOpen()); },
            KeyQ: function () { if (!isOpen()) open(true); sel = items().length - 1; quit(); },
            Escape: function () { if (isOpen()) { path = [ROOT]; open(false); } },
            ArrowUp: function () { move(-1); }, ArrowDown: function () { move(1); },
            ArrowRight: function () { if (isOpen()) enter(); else open(true); },
            ArrowLeft: function () { if (isOpen()) back(); }
        };
        // в журнал запуска (/tmp/lost-start.log): есть ли у окна терминала фокус клавиатуры
        log('клавиатура готова, фокус у страницы: ' + document.hasFocus());
        log('окно терминала: x=' + screenX + ' y=' + screenY + ' ' + innerWidth + '×' + innerHeight);
        window.addEventListener('focus', function () { log('окно терминала получило фокус'); });
        window.addEventListener('blur', function () { log('окно терминала потеряло фокус'); });
        var swallowEnter = false, lastCode = '', lastAt = 0; // клавиатура Informer (Teensy) дребезжит: одно нажатие иногда приходит дважды
        document.addEventListener('keydown', function (e) {
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            if (e.key === 'Enter' && isOpen()) { e.preventDefault(); swallowEnter = true; if (!e.repeat) enter(); return; }
            var f = KEYS[e.code];
            if (!f) return;
            e.preventDefault(); // буква-команда не попадает в строку ввода кода
            if (e.repeat) return;
            var now = Date.now();
            if (e.code === lastCode && now - lastAt < 250) return;
            lastCode = e.code; lastAt = now;
            f();
        }, true);
        // console.html отправляет код по keyup Enter — если Enter сработал в меню, код не отправляем
        document.addEventListener('keyup', function (e) {
            if (e.key === 'Enter' && swallowEnter) { swallowEnter = false; e.stopPropagation(); e.preventDefault(); }
        }, true);
    }
    if (role === 'console') document.addEventListener('DOMContentLoaded', buildPanel);

    // ================= Консоль: загрузка станции при запуске =================
    // Один раз при открытии терминала строки печатаются как у старого компьютера, потом экран уходит и остаётся >:
    // Любая клавиша — пропустить.
    if (role === 'console') document.addEventListener('DOMContentLoaded', function () {
        var BOOT = [
            ['DHARMA INITIATIVE', ''],
            ['СТАНЦИЯ 3: «ЛЕБЕДЬ»', ''],
            ['', ''],
            ['ПРОВЕРКА ПАМЯТИ', '64K ОК'],
            ['ЭЛЕКТРОМАГНИТНЫЙ ЭКРАН', 'В НОРМЕ'],
            ['СВЯЗЬ С «ЖЕМЧУЖИНОЙ»', 'ОК'],
            ['ПРОТОКОЛ 108', 'АКТИВЕН'],
            ['', ''],
            ['ГОТОВ.', '']
        ];
        var st = document.createElement('style');
        st.textContent = '.boot{position:fixed;inset:0;z-index:50;background:#030906;color:#33ff88;' +
            'font:20px/1.5 "Courier New",Courier,monospace;text-shadow:0 0 5px rgba(51,255,136,.6),0 0 15px rgba(51,255,136,.2);' +
            'padding:60px 70px;white-space:pre;transition:opacity .6s}' +
            '.boot::before{content:"";position:absolute;inset:0;pointer-events:none;' +
            'background:repeating-linear-gradient(0deg,rgba(0,0,0,.15) 0,rgba(0,0,0,.15) 1px,transparent 1px,transparent 3px)}' +
            '.boot .cur{display:inline-block;width:12px;height:22px;background:#33ff88;vertical-align:-4px;animation:blink 1s step-end infinite}';
        document.head.appendChild(st);
        var boot = document.createElement('div'); boot.className = 'boot';
        var out = document.createElement('span'), cur = document.createElement('span'); cur.className = 'cur';
        boot.appendChild(out); boot.appendChild(cur); document.body.appendChild(boot);
        var W = 32, i = 0, timers = [], done = false;
        function finish() {
            if (done) return; done = true;
            timers.forEach(clearTimeout);
            boot.style.opacity = '0';
            setTimeout(function () { boot.remove(); }, 650);
        }
        function line() {
            if (done) return;
            if (i >= BOOT.length) return timers.push(setTimeout(finish, 900));
            var name = BOOT[i][0], res = BOOT[i][1]; i++;
            if (!res) { out.textContent += name + '\n'; return timers.push(setTimeout(line, name ? 260 : 120)); }
            // точки «бегут» до результата, как при проверке оборудования
            var dots = Math.max(3, W - name.length), d = 0;
            out.textContent += name + ' ';
            (function step() {
                if (done) return;
                if (d++ < dots) { out.textContent += '.'; timers.push(setTimeout(step, 18)); }
                else { out.textContent += ' ' + res + '\n'; timers.push(setTimeout(line, 220)); }
            })();
        }
        timers.push(setTimeout(line, 400));
        document.addEventListener('keydown', function skip() { finish(); document.removeEventListener('keydown', skip, true); }, true);
    });

    // ПАУЗА — служебное уведомление по центру обоих экранов.
    // Источник истины один: кнопка #pauseResume на странице таймера («Старт» в подписи = стоим).
    // Поэтому неважно, чем поставлена пауза — меню, клавишей P, «Сном» по iMessage или мышью:
    // всё в итоге нажимает эту кнопку. Терминал узнаёт то же самое из __state.
    // ТЕКСТ УВЕДОМЛЕНИЯ — здесь. Строка вида [что, результат] печатается с точками, как при загрузке станции.
    // Форма — как у консоли IBM OS/360: код сообщения (3 буквы компонента + номер + буква важности,
    // W = система ждёт) и короткая строка оператору. SELF-TEST и STAND BY — живой язык тех машин;
    // про паузу прямо не сказано. ТЕКСТ МЕНЯТЬ ЗДЕСЬ.
    var PAUSE_NOTE = 'MAINFRAME STANDBY';
    var PAUSE_WIDTH = 0.72; // какую долю ширины экрана занимает плашка — размер шрифта считается от неё
    (function pauseNotice() {
        var st = document.createElement('style');
        st.textContent = '@keyframes lostPzBlink{50%{opacity:0}}' +
            '.pz{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;' +
            'pointer-events:none;opacity:0;transition:opacity .25s;font-family:"Courier New",Courier,monospace}' +
            '.pz.on{opacity:1}' +
            // рамка нарисована знаками (╔═╗), как на машинах той эпохи. Чёрное поле — ровно по рамке
            // (у <pre> нет полей, коробка равна блоку знаков), поэтому цифры таймера за ней не мешаются.
            // Courier New и разрядка .06em — как во всей программе. Разрядка раздвигает знаки ═ и ║,
            // отчего двойная рамка получается прерывистой: так и задумано, это вид старых экранов.
            // Размер шрифта ставится из fit(), от ширины экрана.
            '.pz .win{position:relative;margin:0;padding:0;white-space:pre;line-height:1.45;letter-spacing:.06em;' +
            'font-family:"Courier New",Courier,monospace;color:#ff3b30;' +
            'text-shadow:0 0 8px rgba(255,59,48,.55)}' +
            // чёрное поле — ровно по нарисованной рамке. Поля внутри знака зависят от шрифта и кегля,
            // поэтому срез не константа: fit() замеряет краску знаков на холсте и кладёт её в переменные.
            '.pz .win::before{content:"";position:absolute;z-index:-1;background:#000;' +
            'top:var(--pz-top,0);bottom:var(--pz-bottom,0);left:var(--pz-left,0);right:var(--pz-right,0);' +
            'box-shadow:0 0 22px rgba(255,59,48,.3)}' +
            // та же «развёртка» строк, что у терминала и экрана загрузки, — поверх текста, по полю рамки
            '.pz .win::after{content:"";position:absolute;pointer-events:none;' +
            'top:var(--pz-top,0);bottom:var(--pz-bottom,0);left:var(--pz-left,0);right:var(--pz-right,0);' +
            'background:repeating-linear-gradient(0deg,rgba(0,0,0,.15) 0,rgba(0,0,0,.15) 1px,transparent 1px,transparent 3px)}' +
            '.pz .cur{animation:lostPzBlink 1s step-end infinite}';
        document.head.appendChild(st);

        var box;
        function build() {
            box = document.createElement('div'); box.className = 'pz';
            var win = document.createElement('pre'); win.className = 'win';
            // курсор — такой же знак внутри рамки, иначе он торчал бы за чёрным полем
            // поля по краям одинаковые: слева три клетки, справа пробел + курсор + пробел — фраза ровно по центру
            var inner = PAUSE_NOTE.length + 6, bar = function (l, r) { return l + new Array(inner + 1).join('\u2550') + r; };
            var cur = document.createElement('span'); cur.className = 'cur'; cur.textContent = '\u2588';
            win.appendChild(document.createTextNode(bar('\u2554', '\u2557') + '\n\u2551   ' + PAUSE_NOTE + ' '));
            win.appendChild(cur);
            win.appendChild(document.createTextNode(' \u2551\n' + bar('\u255a', '\u255d')));
            box.appendChild(win); document.body.appendChild(box);
            fit();
        }
        // ширина строки известна в знаках, у Courier знак равен 0.6em (+0.06em разрядки) —
        // значит размер шрифта считается прямо из ширины экрана, без потолка в пикселях
        function fit() {
            if (!box) return;
            var win = box.firstChild;
            var chars = PAUSE_NOTE.length + 8; // ║ + три клетки + текст + пробел + курсор + пробел + ║
            var ADV = 0.66, LH = 1.45; // знак Courier = 0.6em + 0.06em разрядки; межстрочное — как в CSS выше
            var fs = PAUSE_WIDTH * window.innerWidth / (chars * ADV);
            win.style.fontSize = fs + 'px';
            // Замер краски: сколько пустого места у знака рамки сверху, снизу и сбоку внутри его ячейки.
            // Ровно на столько и срезается чёрное поле, иначе оно торчит из-под красной окантовки.
            try {
                var g = (fit.cv || (fit.cv = document.createElement('canvas'))).getContext('2d');
                g.font = fs + 'px "Courier New", Courier, monospace';
                var h = g.measureText('\u2550'), v = g.measureText('\u2551');
                var base = (LH * fs - (h.fontBoundingBoxAscent + h.fontBoundingBoxDescent)) / 2 + h.fontBoundingBoxAscent;
                win.style.setProperty('--pz-top', (base - h.actualBoundingBoxAscent) + 'px');
                win.style.setProperty('--pz-bottom', (LH * fs - base - h.actualBoundingBoxDescent) + 'px');
                win.style.setProperty('--pz-left', (-v.actualBoundingBoxLeft) + 'px');
                // справа к знаку добавляется ещё и разрядка — её тоже срезаем
                win.style.setProperty('--pz-right', (ADV * fs - v.actualBoundingBoxRight) + 'px');
            } catch (e) { /* старый браузер — поле просто будет по строке */ }
        }
        var want = false;
        function show(on) {
            want = !!on;
            if (!document.body) return; // состояние могло прийти раньше, чем появилась страница — покажем на DOMContentLoaded
            if (!box) build();
            fit(); // экран мог смениться, пока плашка была скрыта
            box.classList.toggle('on', want);
        }
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { show(want); });

        if (role === 'console') { ui.onPause = show; return; } // терминал: состояние приходит в __state

        // Страница таймера: следим за самой кнопкой — она меняется при любом способе паузы
        function watch() {
            var b = document.getElementById('pauseResume'); if (!b) return setTimeout(watch, 300);
            function check() { show(b.textContent.indexOf('Старт') !== -1); reportState(); }
            new MutationObserver(check).observe(b, { childList: true, characterData: true, subtree: true });
            check();
        }
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch);
        else watch();
    })();

    // Курсор мыши — на обеих страницах (терминал и таймер): спрятан, пока мышь не трогают,
    // появляется от любого движения и снова прячется через 2,5 с покоя.
    // На панели без мыши он так и остаётся невидимым; на Mac mini, где таймер — обычное окно
    // на втором экране, мышь больше не теряется при переходе на него.
    (function hideIdleCursor() {
        var idleCss = document.createElement('style');
        idleCss.textContent = 'body.mouse-idle,body.mouse-idle *{cursor:none!important}';
        document.head.appendChild(idleCss);
        var idleTimer;
        function sleep() { if (document.body) document.body.classList.add('mouse-idle'); }
        function wake() {
            if (!document.body) return;
            document.body.classList.remove('mouse-idle');
            clearTimeout(idleTimer);
            idleTimer = setTimeout(sleep, 2500);
        }
        ['mousemove', 'mousedown', 'wheel'].forEach(function (ev) { document.addEventListener(ev, wake, true); });
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sleep);
        else sleep();
    })();
})();
