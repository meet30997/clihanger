'use strict';

const pty = require('node-pty');
const os = require('os');
const t = require('./tmux');

/** sessionId → { p, tmuxName, onData, onExit } */
const ptys = new Map();

function open({ sessionId, tmuxName, cols, rows, onData, onExit }) {
  // already attached? update handlers, resize and trigger screen refresh
  if (ptys.has(sessionId)) {
    const entry = ptys.get(sessionId);
    entry.onData = onData;
    entry.onExit = onExit;
    resize(sessionId, cols, rows);
    // Force tmux to repaint the terminal buffer for the attached client
    t.tmux(['refresh-client', '-t', `=${tmuxName}`]).catch(() => {});
    return;
  }

  const p = pty.spawn(t.tmuxBin(), t.attachArgs(tmuxName), {
    name: 'xterm-256color',
    cols: Math.max(cols, 20),
    rows: Math.max(rows, 5),
    cwd: os.homedir(),
    env: t.tmuxEnv({
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      // Electron sets these and they confuse child processes
      ELECTRON_RUN_AS_NODE: undefined,
      NODE_OPTIONS: undefined,
    }),
  });

  const entry = { p, tmuxName, onData, onExit };
  ptys.set(sessionId, entry);

  p.onData((data) => {
    if (entry.onData) entry.onData(data);
  });

  p.onExit(() => {
    ptys.delete(sessionId);
    if (entry.onExit) entry.onExit();
  });

  // Request redraw on attach
  t.tmux(['refresh-client', '-t', `=${tmuxName}`]).catch(() => {});
}

function write(sessionId, data) {
  ptys.get(sessionId)?.p?.write(data);
}

function resize(sessionId, cols, rows) {
  const entry = ptys.get(sessionId);
  if (!entry || !entry.p) return;
  try {
    entry.p.resize(Math.max(cols, 20), Math.max(rows, 5));
  } catch {
    /* pty died between calls; harmless */
  }
}

/** Detach the viewer. The tmux session and the agent keep running. */
function close(sessionId) {
  const entry = ptys.get(sessionId);
  if (!entry) return;
  ptys.delete(sessionId);
  try { entry.p.kill(); } catch { /* already gone */ }
}

function closeAll() {
  for (const id of [...ptys.keys()]) close(id);
}

module.exports = { open, write, resize, close, closeAll, isOpen: (id) => ptys.has(id) };
