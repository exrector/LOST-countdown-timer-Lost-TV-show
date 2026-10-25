(function () {
    'use strict';
    if (!document.body || !document.body.classList.contains('console-page')) return;
    var opened = false, priority = false, snapshot = { module: (window.__LOST_MODULES || {}).muse || { enabled: false, installed: false, status: 'not_installed' }, chat: { phase: 'idle', messages: [] } };
    var microphone = { available: false, supported: false, recording: false, level: 0, elapsed: 0 };
    var held = false, posting = false, polling = false, pollTimer = null, readController = null, epoch = 0, noticeText = '', ghostText = '', ghostTimer = null, swallowedEnter = false;
    var statuses = { ready: 'НА СВЯЗИ', connecting: 'СОЕДИНЕНИЕ', starting: 'ЗАПУСК', reconnecting: 'ПЕРЕПОДКЛЮЧЕНИЕ', disabled: 'ВЫКЛЮЧЕН', not_installed: 'НЕ УСТАНОВЛЕН', unavailable: 'НЕТ СВЯЗИ', error: 'ОШИБКА', revoked: 'ПАРА ОТОЗВАНА', stopping: 'ОСТАНОВКА' };
    var phases = { idle: 'ГОТОВ К РАЗГОВОРУ', sending: 'ОТПРАВЛЯЮ', waiting: 'ОЖИДАЮ ОТВЕТ', thinking: 'ОЖИДАЮ ОТВЕТ', streaming: 'MUSE ОТВЕЧАЕТ', replying: 'MUSE ОТВЕЧАЕТ', responding: 'MUSE ОТВЕЧАЕТ', recording: 'СЛУШАЮ' };
    function node(tag, className, text) { var e = document.createElement(tag); if (className) e.className = className; if (text !== undefined) e.textContent = text; return e; }
    function button(text, fn) { var b = node('button', 'muse-button', text); b.type = 'button'; b.addEventListener('click', fn); return b; }
    var panel = node('section', 'muse-panel'); panel.hidden = true; panel.setAttribute('aria-label', 'Ассистент Muse'); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true');
    var header = node('header', 'muse-header'), title = node('span', 'muse-title', 'LOST:\\AI'), connection = node('span', 'muse-connection'), preview = node('span', 'muse-preview', 'ТЕСТОВЫЙ РЕЖИМ'); preview.hidden = true;
    var closeButton = button('ESC НАЗАД', close); header.appendChild(title); header.appendChild(preview); header.appendChild(connection); header.appendChild(closeButton); panel.appendChild(header);
    var statusLine = node('div', 'muse-state-line'), phaseText = node('span', 'muse-phase'), micText = node('span', 'muse-microphone'); statusLine.appendChild(phaseText); statusLine.appendChild(micText); panel.appendChild(statusLine);
    var transcript = node('div', 'muse-transcript'); transcript.setAttribute('role', 'log'); transcript.setAttribute('aria-label', 'Разговор'); transcript.setAttribute('aria-live', 'polite'); transcript.setAttribute('aria-relevant', 'additions text'); transcript.tabIndex = 0; panel.appendChild(transcript);
    var recorder = node('div', 'muse-recorder'); recorder.hidden = true; var recordLabel = node('span', '', 'ЗАПИСЬ'), meter = node('span', 'muse-meter'), level = node('span', 'muse-meter-level'), duration = node('span', 'muse-duration', '00:00'); meter.appendChild(level); recorder.appendChild(recordLabel); recorder.appendChild(meter); recorder.appendChild(duration); panel.appendChild(recorder);
    var notice = node('div', 'muse-notice'); notice.setAttribute('role', 'status'); panel.appendChild(notice);
    var form = node('form', 'muse-compose'), prompt = node('label', 'muse-input-label', '>'); prompt.htmlFor = 'lost-muse-input'; var input = node('input', 'muse-input'); input.id = 'lost-muse-input'; input.type = 'text'; input.maxLength = 4000; input.autocomplete = 'off'; input.spellcheck = false; input.setAttribute('aria-label', 'Сообщение Muse'); input.placeholder = 'Сообщение';
    var sendButton = node('button', 'muse-button muse-send', 'ENTER ОТПРАВИТЬ'); sendButton.type = 'submit'; form.appendChild(prompt); form.appendChild(input); form.appendChild(sendButton); panel.appendChild(form);
    var footer = node('footer', 'muse-footer'), voiceButton = button('RESET УДЕРЖИВАТЬ — ГОЛОС', function () { if (!canRecord()) tellMicUnavailable(); }), footerText = node('span', '', 'PF3 — НАЗАД   ↑↓ — ИСТОРИЯ'); footer.appendChild(voiceButton); footer.appendChild(footerText); panel.appendChild(footer);
    var ghost = node('div', 'muse-command'); ghost.hidden = true; ghost.setAttribute('aria-live', 'polite'); document.body.appendChild(ghost); document.body.appendChild(panel);
    function emit(name, detail) { window.dispatchEvent(new CustomEvent(name, { detail: detail })); }
    function moduleInfo() { return snapshot.module || {}; }
    function phase() { return (snapshot.chat || {}).phase || 'idle'; }
    function busy() { return posting || held || microphone.recording || microphone.uploading || microphone.requesting || ['sending', 'waiting', 'thinking', 'streaming', 'replying', 'responding'].indexOf(phase()) !== -1; }
    function connected() { var m = moduleInfo(); return m.installed !== false && m.enabled === true && m.status === 'ready'; }
    function canRecord() { return opened && !priority && connected() && microphone.available === true && microphone.supported === true && !posting && !microphone.uploading && !microphone.requesting && ['sending', 'waiting', 'thinking', 'streaming', 'replying', 'responding'].indexOf(phase()) === -1; }
    function clearGhost() { clearTimeout(ghostTimer); ghostTimer = null; ghostText = ''; ghost.hidden = true; ghost.textContent = ''; }
    function commandLetter(letter) { ghostText = ghostText === 'A' && letter === 'I' ? 'AI' : letter === 'A' ? 'A' : ''; ghost.hidden = !ghostText; ghost.textContent = '> ' + ghostText + (ghostText === 'AI' ? '  ENTER' : ''); clearTimeout(ghostTimer); ghostTimer = setTimeout(clearGhost, 3000); }
    function tellMicUnavailable() { noticeText = microphone.error || (microphone.available ? 'ГОЛОСОВОЙ АДАПТЕР ЕЩЁ НЕ ПОДКЛЮЧЁН. ПОКА ДОСТУПЕН ТЕКСТ.' : 'МИКРОФОН НЕ ПОДКЛЮЧЁН. ПОКА ДОСТУПЕН ТЕКСТ.'); render(); }
    function recordStart() {
        if (held || microphone.recording) return;
        if (!canRecord()) { if (!microphone.available || !microphone.supported) tellMicUnavailable(); else { noticeText = 'ДОЖДИТЕСЬ ГОТОВНОСТИ MUSE'; render(); } return; }
        held = true; noticeText = 'ВКЛЮЧАЮ МИКРОФОН…'; render(); emit('lost-muse-record', { on: true });
    }
    function recordStop(cancel) { if (!held && !microphone.recording) return; held = false; microphone.recording = false; microphone.level = 0; noticeText = cancel ? 'ЗАПИСЬ ОТМЕНЕНА' : 'ЗАПИСЬ ЗАВЕРШЕНА'; emit('lost-muse-record', { on: false, cancel: !!cancel }); render(); }
    function renderMessages() {
        var messages = Array.isArray((snapshot.chat || {}).messages) ? snapshot.chat.messages.slice(-100) : [];
        var key = JSON.stringify(messages); if (key === transcript._messagesKey) return; transcript._messagesKey = key;
        var bottom = transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop < 48, previous = transcript.scrollTop; transcript.replaceChildren();
        if (!messages.length) { var empty = node('div', 'muse-empty'); empty.appendChild(node('div', 'muse-empty-title', 'mUse')); empty.appendChild(node('p', '', 'Разговор появится здесь.')); empty.appendChild(node('p', '', 'Введите сообщение или удерживайте RESET, когда микрофон будет подключён.')); transcript.appendChild(empty); }
        messages.forEach(function (m) { var role = m.role === 'user' ? 'user' : m.role === 'assistant' ? 'assistant' : 'system', row = node('article', 'muse-message muse-message-' + role), label = node('div', 'muse-message-role', role === 'user' ? 'ВЫ' : role === 'assistant' ? 'MUSE' : 'СИСТЕМА'), body = node('div', 'muse-message-text', typeof m.text === 'string' ? m.text.slice(0, 40000) : ''); if (m.pending) body.classList.add('muse-message-pending'); row.appendChild(label); row.appendChild(body); transcript.appendChild(row); });
        transcript.scrollTop = bottom ? transcript.scrollHeight : previous;
    }
    function render() {
        var inputWasDisabled = input.disabled;
        var m = moduleInfo(), active = connected(), currentPhase = phase(); panel.classList.toggle('muse-offline', !active); panel.classList.toggle('muse-recording', microphone.recording === true); connection.textContent = statuses[m.status] || 'ОЖИДАНИЕ'; connection.dataset.status = m.status || 'unknown'; preview.hidden = snapshot.preview !== true;
        phaseText.textContent = microphone.recording ? 'СЛУШАЮ — ОТПУСТИТЕ RESET ДЛЯ ОТПРАВКИ' : held ? 'ВКЛЮЧАЮ МИКРОФОН' : posting ? 'ОТПРАВЛЯЮ' : active ? phases[currentPhase] || 'ГОТОВ К РАЗГОВОРУ' : m.enabled === false ? 'ВКЛЮЧИТЕ mUse В МЕНЮ → МОДУЛИ' : 'СВЯЗЬ С MUSE НЕ ГОТОВА';
        micText.textContent = microphone.requesting ? 'РАЗРЕШИТЕ МИКРОФОН В macOS' : microphone.uploading ? 'ОТПРАВКА ГОЛОСА' : !microphone.available ? 'МИКРОФОН НЕ ПОДКЛЮЧЁН' : !microphone.supported ? 'ГОЛОС ЕЩЁ НЕ ПОДКЛЮЧЁН' : microphone.recording ? '● REC' : 'RESET — УДЕРЖИВАТЬ ДЛЯ РЕЧИ';
        recorder.hidden = microphone.recording !== true; var elapsed = Math.max(0, Math.floor(Number(microphone.elapsed) || 0)); duration.textContent = String(Math.floor(elapsed / 60)).padStart(2, '0') + ':' + String(elapsed % 60).padStart(2, '0'); level.style.width = Math.round(Math.max(0, Math.min(1, Number(microphone.level) || 0)) * 100) + '%';
        input.disabled = !active || busy(); sendButton.disabled = !active || busy() || !input.value.trim(); voiceButton.disabled = !canRecord() && !held; voiceButton.title = !microphone.available ? 'Нужен микрофон' : !microphone.supported ? 'Нативная запись ещё не подключена' : 'Нажмите и удерживайте RESET, отпустите для отправки';
        notice.textContent = noticeText || (snapshot.chat || {}).error || m.error || ''; notice.hidden = !notice.textContent; renderMessages();
        if (opened && inputWasDisabled && !input.disabled && (document.activeElement === closeButton || document.activeElement === document.body)) input.focus();
    }
    function receive(value) { if (!value || typeof value !== 'object') return; if (value.module) snapshot.module = value.module; if (value.chat) snapshot.chat = value.chat; if (typeof value.preview === 'boolean') snapshot.preview = value.preview; if (value.microphone) setMicrophone(value.microphone); if (held && !connected()) recordStop(true); render(); }
    async function poll() {
        if (!opened || polling) return; polling = true; var current = epoch; readController = new AbortController(); var ownController = readController, timeout = setTimeout(function () { ownController.abort(); }, 5000);
        try { var response = await fetch('/__muse/state', { cache: 'no-store', signal: ownController.signal }); if (!response.ok) throw new Error('state'); var value = await response.json(); if (current === epoch && opened) { if (noticeText === 'СОСТОЯНИЕ MUSE НЕДОСТУПНО') noticeText = ''; receive(value); } }
        catch (e) { if (current === epoch && opened) { noticeText = 'СОСТОЯНИЕ MUSE НЕДОСТУПНО'; snapshot.module = Object.assign({}, snapshot.module, { status: 'unavailable' }); render(); } }
        finally { clearTimeout(timeout); if (readController === ownController) readController = null; polling = false; }
    }
    function open() {
        if (opened || priority || window.LostBootActive) return false; var ups = document.querySelector('.ups-panel'); if (ups && !ups.hidden) return false;
        opened = true; epoch++; clearGhost(); panel.hidden = false; document.body.classList.add('lost-muse-active'); emit('lost-muse-open', {}); render(); poll(); pollTimer = setInterval(poll, 1000); if (!input.disabled) input.focus(); else closeButton.focus(); return true;
    }
    function close() { if (!opened) return; recordStop(true); opened = false; epoch++; clearInterval(pollTimer); pollTimer = null; if (readController) readController.abort(); panel.hidden = true; document.body.classList.remove('lost-muse-active'); clearGhost(); emit('lost-muse-close', {}); var original = document.querySelector('.my-console'); if (original && !original.disabled && !document.hidden) original.focus(); }
    function setMicrophone(value) {
        if (!value || typeof value !== 'object') return; microphone = Object.assign({}, microphone, value);
        if(value.finished || value.error){held=false;}
        if(typeof value.error==='string')noticeText=value.error;
        if (microphone.recording && (!held || !opened || priority)) { microphone.recording = false; emit('lost-muse-record', { on: false, cancel: true }); }
        if (held && (!microphone.available || !microphone.supported)) recordStop(true); render();
    }
    async function submit(e) {
        if (e) e.preventDefault(); var text = input.value.trim(); if (!text || !connected() || busy()) return;
        posting = true; noticeText = ''; render(); var controller = new AbortController(), timeout = setTimeout(function () { controller.abort(); }, 30000);
        try { var response = await fetch('/__muse/message', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-LOST-Muse': '1' }, body: JSON.stringify({ message: text }), signal: controller.signal }); var value = await response.json(); if (!response.ok || value.ok === false) throw new Error('send'); if (input.value.trim() === text) input.value = ''; if (value.chat || value.module) receive(value); poll(); }
        catch (_) { noticeText = 'НЕ УДАЛОСЬ ПОДТВЕРДИТЬ ОТПРАВКУ. ПРОВЕРЬТЕ ИСТОРИЮ ПЕРЕД ПОВТОРОМ.'; }
        finally { clearTimeout(timeout); posting = false; render(); if (opened && !input.disabled) input.focus(); }
    }
    form.addEventListener('submit', submit); input.addEventListener('input', render);
    voiceButton.addEventListener('pointerdown', function (e) { if (voiceButton.disabled || e.button !== 0) return; e.preventDefault(); voiceButton.setPointerCapture(e.pointerId); recordStart(); });
    voiceButton.addEventListener('pointerup', function () { recordStop(false); }); voiceButton.addEventListener('pointercancel', function () { recordStop(true); });
    function block(e) { e.preventDefault(); e.stopImmediatePropagation(); }
    function menuOpen() { return !!document.querySelector('.ctl.open'); }
    window.addEventListener('keydown', function (e) {
        if (window.LostBootActive) return;
        if (e.code === 'F6') return;
        if (opened) {
            e.stopImmediatePropagation();
            if (e.code === 'F3') { e.preventDefault(); if (!e.repeat) close(); return; }
            if (e.code === 'ControlLeft') { e.preventDefault(); if (!e.repeat) recordStart(); return; }
            if (e.key === 'Escape') { e.preventDefault(); if (!e.repeat) { if (held || microphone.recording) recordStop(true); else close(); } return; }
            if (e.key === 'Enter' && e.target === input) { e.preventDefault(); if (!e.repeat && !e.isComposing) submit(); return; }
            if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && (e.target === transcript || e.target === panel || (e.target === input && !input.value))) { e.preventDefault(); transcript.scrollBy(0, e.key === 'ArrowUp' ? -55 : 55); return; }
            if (e.key === 'Tab') { var focusable = Array.prototype.filter.call(panel.querySelectorAll('button,input,[tabindex="0"]'), function (n) { return !n.disabled && n.getClientRects().length; }), index = focusable.indexOf(document.activeElement); if (focusable.length && ((e.shiftKey && index <= 0) || (!e.shiftKey && (index < 0 || index === focusable.length - 1)))) { e.preventDefault(); focusable[e.shiftKey ? focusable.length - 1 : 0].focus(); } }
            return;
        }
        if (priority || e.ctrlKey || e.metaKey || e.altKey) { clearGhost(); return; }
        if (e.code === 'F3') { block(e); if (!e.repeat) open(); return; }
        var original = document.querySelector('.my-console'); if (menuOpen() || !original || !original.disabled) { clearGhost(); return; }
        if (e.repeat) return;
        if (e.key === 'Enter' && ghostText === 'AI') { block(e); swallowedEnter = true; clearGhost(); open(); return; }
        if (e.code === 'KeyA' || e.code === 'KeyI') { block(e); commandLetter(e.code === 'KeyA' ? 'A' : 'I'); return; }
        clearGhost();
    }, true);
    window.addEventListener('keyup', function (e) {
        if (e.code === 'ControlLeft' && (held || microphone.recording)) { block(e); recordStop(false); return; }
        if (e.key === 'Enter' && swallowedEnter) { swallowedEnter = false; block(e); return; }
        if (opened && e.code !== 'F6') e.stopImmediatePropagation();
    }, true);
    window.addEventListener('blur', function () { recordStop(true); clearGhost(); });
    document.addEventListener('visibilitychange', function () { if (document.hidden) { recordStop(true); clearGhost(); } });
    window.addEventListener('lost-muse-code-priority', function (e) { priority = !!(e.detail && e.detail.active); if (priority) { clearGhost(); close(); } });
    window.addEventListener('lost-keyboard-lock', function (e) { if (!e.detail || e.detail.locked !== false) { recordStop(true); clearGhost(); } });
    window.addEventListener('lost-modules', function (e) { if (e.detail && e.detail.muse) receive({ module: e.detail.muse }); });
    window.addEventListener('lost-muse-microphone', function (e) { setMicrophone(e.detail); });
    window.addEventListener('message', function (e) { if (e.data && e.data.type === 'enableConsole') { priority = !!e.data.enabled || !!(window.__LOST_CLOCK && window.__LOST_CLOCK.phase && window.__LOST_CLOCK.phase !== 'countdown'); if (priority) { clearGhost(); close(); } } });
    var clock = window.__LOST_CLOCK; if (clock && clock.phase === 'countdown' && clock.left > 0 && clock.left <= 240) priority = true;
    window.addEventListener('lost-muse-record', function(e){
        if(window.LostStation && window.LostStation.microphone)window.LostStation.microphone({op:e.detail.on?'start':e.detail.cancel?'cancel':'stop'});
    });
    window.addEventListener('lost-muse-open', function(){if(window.LostStation && window.LostStation.microphone)window.LostStation.microphone({op:'query'});});
    if(window.LostStation && window.LostStation.microphone)window.LostStation.microphone({op:'query'});
    window.LostMuse = { open: open, close: close, isOpen: function () { return opened; }, receive: receive, setMicrophone: setMicrophone };
    render();
})();
