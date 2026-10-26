(function () {
    'use strict';
    if (!document.body || !document.body.classList.contains('console-page')) return;
    var opened = false, priority = false, snapshot = { module: (window.__LOST_MODULES || {}).muse || { enabled: false, installed: false, status: 'not_installed' }, chat: { phase: 'idle', messages: [] } };
    var microphone = { available: false, supported: false, recording: false, level: 0, elapsed: 0 };
    var held = false, posting = false, polling = false, pollTimer = null, readController = null, epoch = 0, noticeText = '', consumedEnter = false;
    var statuses = { ready: 'НА СВЯЗИ', connecting: 'СОЕДИНЕНИЕ', starting: 'ЗАПУСК', reconnecting: 'ПЕРЕПОДКЛЮЧЕНИЕ', disabled: 'ВЫКЛЮЧЕН', not_installed: 'НЕ УСТАНОВЛЕН', unavailable: 'НЕТ СВЯЗИ', error: 'ОШИБКА', revoked: 'ПАРА ОТОЗВАНА', stopping: 'ОСТАНОВКА' };
    var phases = { idle: 'ГОТОВ К РАЗГОВОРУ', sending: 'ОТПРАВЛЯЮ', waiting: 'ОЖИДАЮ ОТВЕТ', thinking: 'ОЖИДАЮ ОТВЕТ', streaming: 'MUSE ОТВЕЧАЕТ', replying: 'MUSE ОТВЕЧАЕТ', responding: 'MUSE ОТВЕЧАЕТ', recording: 'СЛУШАЮ' };
    function node(tag, className, text) { var e = document.createElement(tag); if (className) e.className = className; if (text !== undefined) e.textContent = text; return e; }
    // AI uses the same station surface, prompt and input as the numeric console.
    var panel = document.querySelector('.console-container'), input = panel.querySelector('.my-console');
    var originalPlaceholder = input.placeholder, originalMaxLength = input.maxLength, originalDisabled = input.disabled, originalReadOnly = input.readOnly;
    var transcript = node('div', 'muse-transcript'); transcript.hidden = true;
    transcript.setAttribute('role', 'log'); transcript.setAttribute('aria-label', 'Разговор Muse'); transcript.setAttribute('aria-live', 'polite'); transcript.tabIndex = 0;
    var form = node('form', 'muse-compose');
    form.appendChild(panel.querySelector('.console-prompt')); form.appendChild(panel.querySelector('.console-input'));
    panel.appendChild(form); panel.appendChild(transcript);
    var notice = node('div', 'muse-notice'); notice.hidden = true; notice.setAttribute('role', 'status'); panel.appendChild(notice);
    var footer = node('div', 'muse-hint'); footer.hidden = true; panel.appendChild(footer);
    function emit(name, detail) { window.dispatchEvent(new CustomEvent(name, { detail: detail })); }
    function moduleInfo() { return snapshot.module || {}; }
    function phase() { return (snapshot.chat || {}).phase || 'idle'; }
    function busy() { return posting || held || microphone.recording || microphone.uploading || microphone.requesting || ['sending', 'waiting', 'thinking', 'streaming', 'replying', 'responding'].indexOf(phase()) !== -1; }
    function connected() { var m = moduleInfo(); return m.installed !== false && m.enabled === true && m.status === 'ready'; }
    function canRecord() { return opened && !priority && connected() && microphone.available === true && microphone.supported === true && !posting && !microphone.uploading && !microphone.requesting && ['sending', 'waiting', 'thinking', 'streaming', 'replying', 'responding'].indexOf(phase()) === -1; }
    function resetCommand() { if (window.LostConsoleInput) window.LostConsoleInput.reset(); }
    function tellMicUnavailable() { noticeText = microphone.error || (microphone.available ? 'ГОЛОСОВОЙ АДАПТЕР ЕЩЁ НЕ ПОДКЛЮЧЁН. ПОКА ДОСТУПЕН ТЕКСТ.' : 'МИКРОФОН НЕ ПОДКЛЮЧЁН. ПОКА ДОСТУПЕН ТЕКСТ.'); render(); }
    function recordStart() {
        if (held || microphone.recording) return;
        if (!canRecord()) { if (!microphone.available || !microphone.supported) tellMicUnavailable(); else { noticeText = 'ДОЖДИТЕСЬ ГОТОВНОСТИ MUSE'; render(); } return; }
        held = true; noticeText = 'ВКЛЮЧАЮ МИКРОФОН…'; render(); emit('lost-muse-record', { on: true });
    }
    function recordStop(cancel) { if (!held && !microphone.recording) return; held = false; microphone.recording = false; microphone.level = 0; noticeText = cancel ? 'Запись отменена' : 'Завершаю запись…'; emit('lost-muse-record', { on: false, cancel: !!cancel }); render(); }
    // The journal is an enhancement, never a reason to disable the assistant if
    // an older cached page happens to miss timeline.js during an update.
    var timelineApi = window.LostMuseTimeline || { Timeline: function () { this.update = function (messages) {
        return (Array.isArray(messages) ? messages.slice(-100) : []).map(function (m, index) { return { kind:'message', id:'message:'+(m.id || 'legacy-'+index), role:m.role === 'user' ? 'user' : 'assistant', text:typeof m.text === 'string' ? m.text.slice(0,40000) : '', pending:m.pending === true }; }).reverse();
    }; }, describe: function () { return { label:'', text:'', failed:false }; } };
    var timeline = new timelineApi.Timeline();
    function renderMessages() {
        var chat = snapshot.chat || {}, rows = timeline.update(chat.messages, (chat.audit || {}).events);
        var key = JSON.stringify(rows); if (key === transcript._messagesKey) return; transcript._messagesKey = key;
        var previous = transcript.scrollTop, anchor = null, anchorOffset = 0;
        var bounds = function (element) { return element && typeof element.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : { top:0, bottom:0 }; };
        var top = bounds(transcript).top;
        if (previous >= 48) Array.prototype.some.call(transcript.children, function (child) {
            var rect = bounds(child); if (rect.bottom > top) { anchor = child.dataset.timelineId; anchorOffset = rect.top - top; return true; } return false;
        });
        var old = transcript._rows || Object.create(null), current = Object.create(null);
        rows.forEach(function (m, index) {
            var row = old[m.id];
            if (!row) { row = node('article'); row.dataset = row.dataset || {}; row.dataset.timelineId = m.id; row._label = node('div', 'muse-message-role'); row._body = node('div', 'muse-message-text'); row.appendChild(row._label); row.appendChild(row._body); }
            current[m.id] = row;
            if (m.kind === 'audit') {
                var detail = timelineApi.describe(m);
                row.className = 'muse-message muse-audit' + (detail.failed ? ' muse-audit-error' : '');
                row._label.textContent = detail.label; row._body.textContent = detail.text;
            } else {
                row.className = 'muse-message muse-message-' + m.role;
                row._label.textContent = m.role === 'user' ? '>:' : 'muse:';
                if (row._body.textContent !== m.text) row._body.textContent = m.text;
            }
            row._body.classList.toggle('muse-message-pending', m.pending === true);
            if (transcript.children[index] !== row) {
                if (typeof transcript.insertBefore === 'function') transcript.insertBefore(row, transcript.children[index] || null);
                else transcript.appendChild(row);
            }
        });
        Object.keys(old).forEach(function (id) { if (!current[id]) old[id].remove(); });
        transcript._rows = current;
        if (previous < 48) transcript.scrollTop = 0;
        else if (anchor && current[anchor]) transcript.scrollTop += bounds(current[anchor]).top - bounds(transcript).top - anchorOffset;
        else transcript.scrollTop = previous;
    }
    function render() {
        if (!opened) return;
        var active = connected(), m = moduleInfo(), currentPhase = phase();
        var elapsed = Math.max(0, Math.floor(Number(microphone.elapsed) || 0));
        var hint = 'RESET — удерживать для записи · Enter — отправить · → — меню · Esc — назад';
        if (snapshot.preview) hint = 'Тест интерфейса · ' + hint;
        if (microphone.recording) hint = 'Запись ' + elapsed + ' с · Отпустите RESET, затем Enter · Esc — отменить';
        else if (microphone.draftReady) hint = 'Запись ' + elapsed + ' с готова · Enter — отправить · RESET — перезаписать · Esc — отменить';
        else if (microphone.uploading || posting) hint = 'Отправляю…';
        else if (microphone.requesting) hint = 'Разрешите микрофон в macOS';
        else if (!active) hint = m.enabled === false ? 'mUse выключен · Меню → Модули' : (statuses[m.status] || 'Нет связи с Muse');
        else if (['sending', 'waiting', 'thinking', 'streaming', 'replying', 'responding'].indexOf(currentPhase) !== -1) hint = currentPhase === 'replying' ? 'Muse отвечает…' : 'Ожидаю ответ…';
        footer.textContent = hint;
        input.disabled = !active || busy(); input.placeholder = microphone.draftReady ? 'Голосовая запись готова' : '';
        input.readOnly = microphone.draftReady === true;
        emit('lost-console-command-change', {});
        notice.textContent = noticeText || (snapshot.chat || {}).error || m.error || ''; notice.hidden = !notice.textContent;
        renderMessages();
        if (!input.disabled && (document.activeElement === document.body || document.activeElement === panel)) input.focus();
    }
    function receive(value) { if (!value || typeof value !== 'object') return; if (value.module) snapshot.module = value.module; if (value.chat) snapshot.chat = value.chat; if (typeof value.preview === 'boolean') snapshot.preview = value.preview; if (value.microphone) setMicrophone(value.microphone); if (held && !connected()) recordStop(true); render(); }
    async function poll() {
        if (!opened || polling) return; polling = true; var current = epoch; readController = new AbortController(); var ownController = readController, timeout = setTimeout(function () { ownController.abort(); }, 5000);
        try { var response = await fetch('/__muse/state', { cache: 'no-store', signal: ownController.signal }); if (!response.ok) throw new Error('state'); var value = await response.json(); if (current === epoch && opened) { if (noticeText === 'СОСТОЯНИЕ MUSE НЕДОСТУПНО') noticeText = ''; receive(value); } }
        catch (e) { if (current === epoch && opened) { noticeText = 'СОСТОЯНИЕ MUSE НЕДОСТУПНО'; snapshot.module = Object.assign({}, snapshot.module, { status: 'unavailable' }); render(); } }
        finally { clearTimeout(timeout); if (readController === ownController) readController = null; polling = false; }
    }
    function canOpen() { return !opened && !priority && !window.LostBootActive; }
    function open() {
        if (!canOpen() || menuOpen()) return false; var ups = document.querySelector('.ups-panel'); if (ups && !ups.hidden) return false;
        originalDisabled = input.disabled; originalReadOnly = input.readOnly; resetCommand(); input.value = ''; input.maxLength = 4000; opened = true; epoch++; transcript.hidden = false; transcript.scrollTop = 0; footer.hidden = false; document.body.classList.add('lost-muse-active'); emit('lost-muse-open', {}); render(); poll(); pollTimer = setInterval(poll, 1000); if (!input.disabled) input.focus(); else transcript.focus(); return true;
    }
    function close() { if (!opened) return; recordStop(true); emit('lost-muse-record', { on: false, cancel: true }); opened = false; epoch++; clearInterval(pollTimer); pollTimer = null; if (readController) readController.abort(); transcript.hidden = true; footer.hidden = true; notice.hidden = true; input.value = ''; input.readOnly = originalReadOnly; input.disabled = originalDisabled; input.placeholder = originalPlaceholder; if (originalMaxLength >= 0) input.maxLength = originalMaxLength; else input.removeAttribute('maxlength'); document.body.classList.remove('lost-muse-active'); resetCommand(); emit('lost-muse-close', {}); var original = document.querySelector('.my-console'); if (original && !original.disabled && !document.hidden) original.focus(); }
    function setMicrophone(value) {
        if (!value || typeof value !== 'object') return; microphone = Object.assign({}, microphone, value); window.__LOST_MUSE_MIC = microphone;
        if(value.finished || value.error){held=false;}
        if(typeof value.error==='string')noticeText=value.error; if (value.draftReady) noticeText='';
        if (microphone.recording && (!held || !opened || priority)) { microphone.recording = false; emit('lost-muse-record', { on: false, cancel: true }); }
        if (held && (!microphone.available || !microphone.supported)) recordStop(true); render();
    }
    async function submit(e) {
        if (e) e.preventDefault(); if (microphone.draftReady && connected() && !busy()) { noticeText = ''; emit('lost-muse-send-voice', {}); return; } var text = input.value.trim(); if (!text || !connected() || busy()) return;
        posting = true; noticeText = ''; render(); var controller = new AbortController(), timeout = setTimeout(function () { controller.abort(); }, 30000);
        try { var response = await fetch('/__muse/message', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-LOST-Muse': '1' }, body: JSON.stringify({ message: text }), signal: controller.signal }); var value = await response.json(); if (!response.ok || value.ok === false) throw new Error('send'); if (input.value.trim() === text) input.value = ''; if (value.chat || value.module) receive(value); poll(); }
        catch (_) { noticeText = 'НЕ УДАЛОСЬ ПОДТВЕРДИТЬ ОТПРАВКУ. ПРОВЕРЬТЕ ИСТОРИЮ ПЕРЕД ПОВТОРОМ.'; }
        finally { clearTimeout(timeout); posting = false; render(); if (opened && !input.disabled) input.focus(); }
    }
    form.addEventListener('submit', function(e){e.preventDefault(); if(opened)submit();}); input.addEventListener('input', render);
    function block(e) { e.preventDefault(); e.stopImmediatePropagation(); }
    function menuOpen() { return !!document.querySelector('.ctl.open'); }
    window.addEventListener('keydown', function (e) {
        if (window.LostBootActive) return;
        if (e.code === 'F6') return;
        if (opened) {
            if (e.key === 'ArrowRight' && !e.metaKey && !e.ctrlKey && !e.altKey) { close(); return; }
            if (e.code === 'Pause') return;
            e.stopImmediatePropagation();
            if (e.code === 'F3') { e.preventDefault(); if (!e.repeat) close(); return; }
            if (e.code === 'ControlLeft') { e.preventDefault(); if (!e.repeat) recordStart(); return; }
            if (e.key === 'Escape') { e.preventDefault(); if (!e.repeat) { if (held || microphone.recording) recordStop(true); else if (microphone.draftReady) { noticeText = 'Запись отменена'; emit('lost-muse-record', { on: false, cancel: true }); } else close(); } return; }
            if (e.key === 'Enter' && (e.target === input || microphone.draftReady)) { consumedEnter = true; e.preventDefault(); if (!e.repeat && !e.isComposing) submit(); return; }
            if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && (e.target === transcript || e.target === panel || (e.target === input && !input.value))) { e.preventDefault(); transcript.scrollBy(0, e.key === 'ArrowUp' ? -55 : 55); return; }
            return;
        }
        if (priority) { resetCommand(); return; }
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.code === 'F3') { block(e); if (!e.repeat) open(); return; }
    }, true);
    window.addEventListener('keyup', function (e) {
        if (e.key === 'Enter' && consumedEnter) { consumedEnter = false; block(e); return; }
        if (e.code === 'ControlLeft' && (held || microphone.recording)) { block(e); recordStop(false); return; }
        if (opened && e.code !== 'F6') e.stopImmediatePropagation();
    }, true);
    window.addEventListener('blur', function () { recordStop(true); });
    document.addEventListener('visibilitychange', function () { if (document.hidden) recordStop(true); });
    window.addEventListener('lost-muse-code-priority', function (e) { priority = !!(e.detail && e.detail.active); if (priority) { resetCommand(); close(); } });
    window.addEventListener('lost-keyboard-lock', function (e) { if (!e.detail || e.detail.locked !== false) { recordStop(true); emit('lost-muse-record', { on:false, cancel:true }); resetCommand(); } });
    window.addEventListener('lost-modules', function (e) { if (e.detail && e.detail.muse) receive({ module: e.detail.muse }); });
    window.addEventListener('lost-muse-microphone', function (e) { setMicrophone(e.detail); });
    window.addEventListener('message', function (e) { if (e.data && e.data.type === 'enableConsole') { priority = !!e.data.enabled || (Number(e.data.remainingTime) > 0 && Number(e.data.remainingTime) <= 480) || !!(window.__LOST_CLOCK && window.__LOST_CLOCK.phase && window.__LOST_CLOCK.phase !== 'countdown'); if (priority) { resetCommand(); close(); } } });
    var clock = window.__LOST_CLOCK; if (clock && clock.phase === 'countdown' && clock.left > 0 && clock.left <= 480) priority = true;
    window.addEventListener('lost-muse-record', function(e){
        if(window.LostStation && window.LostStation.microphone)window.LostStation.microphone({op:e.detail.on?'start':e.detail.cancel?'cancel':'stop'});
    });
    window.addEventListener('lost-muse-send-voice', function(){if(window.LostStation && window.LostStation.microphone)window.LostStation.microphone({op:'send'});});
    window.addEventListener('lost-muse-open', function(){if(window.LostStation && window.LostStation.microphone){window.LostStation.microphone({op:'query'});window.LostStation.microphone({op:'authorize'});}});
    if(window.LostStation && window.LostStation.microphone)window.LostStation.microphone({op:'query'});
    if (window.LostConsoleInput) window.LostConsoleInput.register('AI', open);
    window.LostMuse = { canOpen: canOpen, open: open, close: close, isOpen: function () { return opened; }, receive: receive, setMicrophone: setMicrophone,
        commandHistory: function () { var a = (snapshot.chat || {}).audit || {}; return { shown: Array.isArray(a.events) ? a.events.length : 0, limit: a.limit || 120, maxBytes: a.maxBytes || 262144, truncated: a.truncated === true, available: a.available !== false }; } };
    render();
})();
