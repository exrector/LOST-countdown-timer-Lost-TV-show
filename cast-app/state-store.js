'use strict';
const fs = require('fs');
const path = require('path');
function slot(s = {}) { return { left: Number.isFinite(s.left) ? s.left : null, paused: s.paused === true }; }
function loadState(file) {
    let s = {}; try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
    if (!s || typeof s !== 'object') s = {};
    return { audio: ['speakers','monitor','off'].includes(s.audio) ? s.audio : null,
        mode: s.mode === 'dev' ? 'dev' : 'live', live: slot(s.live || s), dev: slot(s.dev) };
}
function writeState(file, state) {
    const temp = file + '.' + process.pid + '.tmp';
    let fd;
    try {
        fd = fs.openSync(temp, 'w', 0o600);
        fs.writeFileSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); fs.closeSync(fd); fd = null;
        fs.renameSync(temp, file);
        return true;
    } catch (error) {
        if (fd != null) fs.closeSync(fd);
        try { fs.unlinkSync(temp); } catch (_) {}
        console.error('[state] не удалось сохранить состояние:', error.code || 'write failed');
        return false;
    }
}
module.exports = { loadState, writeState };
