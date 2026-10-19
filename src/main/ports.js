'use strict';

const { execFile } = require('child_process');
const t = require('./tmux');
const store = require('./store');

function sh(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const errText = (stderr || '').trim();
      if (err) {
        // lsof exits 1 when it finds no listeners; if stderr is non-empty with permission warnings, reject
        if (cmd === 'lsof' && err.code === 1) {
          if (errText && !errText.includes('no file')) {
            return reject(new Error(`lsof warning/denied: ${errText}`));
          }
          return resolve('');
        }
        const msg = errText || err.message;
        return reject(new Error(`${cmd} failed: ${msg}`));
      }
      resolve(stdout || '');
    });
  });
}

/**
 * Parse lsof's field output.
 *
 *   p1234        <- process block starts, PID
 *   cnode        <- command name
 *   f7           <- a file descriptor
 *   n*:5173      <- the address it's bound to
 *   f9
 *   n127.0.0.1:3000
 */
async function listListeners() {
  const out = await sh('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn']);
  const rows = [];
  let pid = null;
  let command = null;

  for (const line of out.split('\n')) {
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') { pid = Number(value); command = null; }
    else if (tag === 'c') { command = value; }
    else if (tag === 'n' && pid) {
      const port = Number(value.slice(value.lastIndexOf(':') + 1));
      if (!port) continue;
      rows.push({ pid, command: command || '?', address: value, port });
    }
  }

  // one process can bind the same port on both IPv4 and IPv6 — collapse those
  const seen = new Set();
  return rows.filter((r) => {
    const key = `${r.pid}:${r.port}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** pid → ppid for every process on the machine. */
async function parentMap() {
  const out = await sh('ps', ['-Ao', 'pid=,ppid=']);
  const map = new Map();
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (m) map.set(Number(m[1]), Number(m[2]));
  }
  return map;
}

/** Walk up from pid until we hit a known pane pid, or give up. */
function findOwner(pid, parents, paneByPid) {
  let cur = pid;
  for (let depth = 0; depth < 40; depth++) {
    if (paneByPid.has(cur)) return paneByPid.get(cur);
    const parent = parents.get(cur);
    if (!parent || parent === cur || parent <= 1) return null;
    cur = parent;
  }
  return null;
}

/** Check if a PID belongs to Hangar / Electron main process tree */
function isHangarProcess(targetPid, parents) {
  if (targetPid === process.pid || targetPid === process.ppid) return true;
  // Check if targetPid is an ancestor of Hangar
  let cur = process.pid;
  for (let depth = 0; depth < 40; depth++) {
    if (cur === targetPid) return true;
    const parent = parents.get(cur);
    if (!parent || parent === cur || parent <= 1) break;
    cur = parent;
  }
  // Check if targetPid is a child/descendant of Hangar
  cur = targetPid;
  for (let depth = 0; depth < 40; depth++) {
    if (cur === process.pid) return true;
    const parent = parents.get(cur);
    if (!parent || parent === cur || parent <= 1) break;
    cur = parent;
  }
  return false;
}

async function list() {
  const [listeners, parents, panes] = await Promise.all([
    listListeners(),
    parentMap(),
    t.listPanes(),
  ]);

  const state = store.load();
  const paneByPid = new Map();
  for (const pane of panes) {
    const session = state.sessions.find((s) => s.tmuxName === pane.name);
    if (session) paneByPid.set(pane.pid, session);
  }

  return listeners
    .map((row) => {
      const owner = findOwner(row.pid, parents, paneByPid);
      const project = owner
        ? state.projects.find((p) => p.id === owner.projectId)
        : null;
      return {
        ...row,
        sessionId: owner?.id ?? null,
        agentId: owner?.agentId ?? null,
        projectName: project?.name ?? null,
      };
    })
    .sort((a, b) => {
      // ports we own float to the top
      if (!!a.sessionId !== !!b.sessionId) return a.sessionId ? -1 : 1;
      return a.port - b.port;
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** SIGTERM, give it two seconds to clean up, then SIGKILL. */
async function kill(pid) {
  if (!Number.isInteger(pid) || pid <= 1) {
    return { ok: false, message: 'Refusing to kill that PID' };
  }

  // Refuse to kill Hangar / Electron application itself
  try {
    const parents = await parentMap();
    if (isHangarProcess(pid, parents)) {
      return { ok: false, message: 'Refusing to kill CliHanger application process' };
    }
  } catch {
    if (pid === process.pid || pid === process.ppid) {
      return { ok: false, message: 'Refusing to kill CliHanger application process' };
    }
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (e) {
    if (e.code === 'ESRCH') return { ok: true, message: 'Already gone' };
    return { ok: false, message: e.message };
  }

  for (let i = 0; i < 20; i++) {
    await sleep(100);
    try { process.kill(pid, 0); } catch { return { ok: true, message: 'Stopped' }; }
  }

  try {
    process.kill(pid, 'SIGKILL');
    return { ok: true, message: 'Force killed' };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

module.exports = { list, kill, isHangarProcess };
