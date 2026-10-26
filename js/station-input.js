/* Hidden station commands: invisible recognition, explicit Enter, no timeout. */
(function (root, factory) {
    var HiddenCommands = factory();
    if (typeof module === 'object' && module.exports) module.exports = HiddenCommands;
    if (!root || !root.document) return;
    var document = root.document;
    if (!document.body || !document.body.classList.contains('console-page')) return;
    var input = document.querySelector('.my-console');
    if (!input) return;
    var commands = new HiddenCommands(), actions = Object.create(null), keyboardLocked = false, swallowedEnter = false;
    var clock = root.__LOST_CLOCK;
    var codeEnabled = !!(clock && clock.phase === 'countdown' && clock.left > 0 && clock.left <= 240);
    function insideTool() {
        var ups = document.querySelector('.ups-panel');
        return document.body.classList.contains('lost-muse-active') || !!document.querySelector('.ctl.open') || !!(ups && !ups.hidden);
    }
    function render() {
        if (insideTool() || codeEnabled) return;
        input.disabled = false; input.readOnly = true;
        input.value = commands.matched;
        root.dispatchEvent(new CustomEvent('lost-console-command-change'));
    }
    function reset() { commands.reset(); render(); }
    root.LostConsoleInput = {
        register: function (name, action) { commands.register(name); actions[name.toUpperCase()] = action; },
        reset: reset, refresh: render, codeOpen: function () { return codeEnabled; }
    };
    function block(e) { e.preventDefault(); e.stopImmediatePropagation(); }
    root.addEventListener('keydown', function (e) {
        if (root.LostBootActive || insideTool() || codeEnabled || keyboardLocked) return;
        if (root.__LOST_CLOCK && root.__LOST_CLOCK.phase !== 'countdown') { reset(); return; }
        if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
        if (e.key === 'Enter') {
            block(e); swallowedEnter = true;
            if (!e.repeat && commands.matched) {
                var name = commands.matched, action = actions[name];
                reset(); if (action) action();
            }
            return;
        }
        if (e.key === 'Escape' || e.key === 'Backspace' || e.key === 'Delete') {
            block(e); if (!e.repeat) reset(); return;
        }
        if (typeof e.key === 'string' && e.key.length === 1) {
            block(e);
            if (!e.repeat) {
                var letter = /^Key[A-Z]$/.test(e.code || '') ? e.code.slice(3) : e.key;
                commands.feed(letter); render();
            }
        }
    }, true);
    // A locked console must never submit a number from Enter's release.
    root.addEventListener('keyup', function (e) {
        if (e.key === 'Enter' && (swallowedEnter || !codeEnabled && !insideTool())) { swallowedEnter = false; block(e); }
    }, true);
    root.addEventListener('message', function (e) {
        if (!e.data || e.data.type !== 'enableConsole') return;
        var enabled = !!e.data.enabled;
        if (enabled !== codeEnabled) { commands.reset(); if (!insideTool()) input.value = ''; }
        codeEnabled = enabled; render();
    });
    ['lost-menu-change', 'lost-ups-open', 'lost-ups-close', 'lost-muse-close'].forEach(function (name) {
        root.addEventListener(name, function () { commands.reset(); render(); });
    });
    root.addEventListener('lost-keyboard-lock', function (e) { keyboardLocked = !e.detail || e.detail.locked !== false; reset(); });
    render();
})(typeof window === 'undefined' ? null : window, function () {
    'use strict';
    function HiddenCommands() { this.names = []; this.buffer = ''; this.matched = ''; }
    HiddenCommands.prototype.register = function (name) {
        name = String(name).toUpperCase();
        if (!/^[A-Z][A-Z0-9]{1,31}$/.test(name)) throw new TypeError('Invalid station command');
        if (this.names.indexOf(name) < 0) this.names.push(name);
    };
    HiddenCommands.prototype.reset = function () { this.buffer = ''; this.matched = ''; };
    HiddenCommands.prototype.feed = function (letter) {
        if (this.matched) return this.matched;
        letter = String(letter).toUpperCase();
        if (!/^[A-Z0-9]$/.test(letter)) { this.buffer = ''; return ''; }
        this.buffer = (this.buffer + letter).slice(-32);
        this.matched = this.names.find(function (name) { return this.buffer.endsWith(name); }, this) || '';
        return this.matched;
    };
    return HiddenCommands;
});
