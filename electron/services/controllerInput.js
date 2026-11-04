'use strict'

// When a controller was last used, so controller play isn't counted as AFK:
// powerMonitor.getSystemIdleTime() only reflects keyboard and mouse. There's no
// Node API for XInput and the renderer's Gamepad API can't poll while the window
// sits behind a fullscreen game, so desktopProbe.js does the reading and reports
// a line (at most every 2 s) while a controller is in use: a button held, a
// trigger pulled, or a stick past a deadzone, so stick drift doesn't count.

let lastInputAt = 0

function noteInput() { lastInputAt = Date.now() }

// Milliseconds since the controller was last used. Infinity = not seen yet, so
// callers fall back to the keyboard and mouse idle time.
function msSinceInput() { return lastInputAt ? Date.now() - lastInputAt : Infinity }

module.exports = { noteInput, msSinceInput }
