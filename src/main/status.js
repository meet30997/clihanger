'use strict';

const crypto = require('crypto');
const t = require('./tmux');
const store = require('./store');
const { loadAgents } = require('./agents');

const POLL_MS = 2000;
const IDLE_POLLS = 2;   // ~4s of no change before we stop calling it "working"

const VALID_STATUSES = new Set(['working', 'needs_input', 'idle', 'exited']);

/** sessionId → { hash, unchanged, status } */
const memory = new Map();
let timer = null;

/** Shells we consider "the agent has exited". */
const SHELLS = new Set(['zsh', 'bash', 'fish', 'sh', 'dash', 'tcsh']);

/**
 * Prompt patterns. Agents phrase permission requests differently, so this
 * is deliberately broad. Tune it as you notice misses.
 */
const PROMPT_PATTERNS = [
  /\(y\/n\)/i,
  /\[y\/N\]/i,
  /\[Y\/n\]/i,
  /\bdo you want to\b/i,
  /\bwould you like to\b/i,
  /\ballow\b.*\?/i,
  /\bproceed\b\s*\?/i,
  /\bapprove\b/i,
  /\bpress\s+(y|enter)\b/i,
  /❯\s*$/m,
  /›\s*$/m,
  /\b1\.\s*yes\b/i,
];

function hash(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

function checkPrompt(screen) {
  // only consider the bottom of the screen — that's where prompts live
  const lines = screen.trimEnd().split('\n');
  const tailLines = lines.slice(-12);
  const tailText = tailLines.join('\n');
  for (const re of PROMPT_PATTERNS) {
    if (re.test(tailText)) {
      const excerpt = tailLines.slice(-3).map((l) => l.trim()).filter(Boolean).join('\n');
      return { matched: true, pattern: re.toString(), excerpt: excerpt.slice(0, 300) };
    }
  }
  return { matched: false };
}

function looksLikePrompt(screen) {
  return checkPrompt(screen).matched;
}

async function classify(session) {
  const [screen, panes] = await Promise.all([
    t.capturePane(session.tmuxName, 30, true),
    t.listPanes(),
  ]);

  const pane = panes.find((p) => p.name === session.tmuxName);
  if (!pane) return { status: 'gone', reason: 'Pane no longer exists in tmux' };
  const launcher = loadAgents()[session.agentId];
  if (SHELLS.has(pane.command) && launcher?.kind !== 'shell') {
    return { status: 'exited', reason: `Foreground process is shell (${pane.command})` };
  }

  const h = hash(screen.trimEnd());
  const prev = memory.get(session.id) || { hash: null, unchanged: 0 };

  if (h !== prev.hash) {
    return { status: 'working', hash: h, unchanged: 0, reason: 'Terminal screen content updated' };
  }

  const unchanged = prev.unchanged + 1;

  if (unchanged < IDLE_POLLS) {
    return { status: 'working', hash: h, unchanged, reason: 'Awaiting output stability (~4s)' };
  }
  const promptCheck = checkPrompt(screen);
  if (promptCheck.matched) {
    return {
      status: 'needs_input',
      hash: h,
      unchanged,
      reason: `Prompt pattern matched: ${promptCheck.pattern}`,
      excerpt: promptCheck.excerpt,
    };
  }
  return {
    status: 'idle',
    hash: h,
    unchanged,
    reason: 'Screen unchanged; no prompt pattern matched',
  };
}

/**
 * @param {(payload: {sessionId: string, status: string, prev: string, waitingSince?: number, snoozed?: boolean, reason?: string, tailExcerpt?: string}) => void} onChange
 * @param {(sessionId: string) => void} [onGone]
 */
function start(onChange, onGone) {
  stop();
  timer = setInterval(async () => {
    const { sessions } = store.load();
    const currentSessionIds = new Set(sessions.map((s) => s.id));
    for (const id of memory.keys()) {
      if (!currentSessionIds.has(id)) memory.delete(id);
    }
    for (const session of sessions) {
      // A parked session has no tmux session to look at; it is not gone, it has
      // not started yet. Classifying it would report `gone` forever.
      if (!session.tmuxName) continue;
      let res;
      try {
        res = await classify(session);
      } catch (err) {
        const previous = memory.get(session.id);
        if (previous) memory.set(session.id, {
          ...previous,
          reason: `Observation unavailable; previous status is stale: ${err.message}`,
          tailExcerpt: null,
        });
        continue;
      }
      const entry = memory.get(session.id) || {};
      const status = res.status;
      const prev = entry.status;
      const now = Date.now();

      let waitingSince = entry.waitingSince || null;
      let snoozed = entry.snoozed || false;
      if (status === 'needs_input') {
        if (prev !== 'needs_input') {
          waitingSince = now;
          snoozed = false;
        }
      } else {
        waitingSince = null;
        snoozed = false;
      }

      const newEntry = {
        ...entry,
        hash: res.hash !== undefined ? res.hash : entry.hash,
        unchanged: res.unchanged !== undefined ? res.unchanged : entry.unchanged,
        status,
        prevStatus: prev,
        transitionedAt: prev !== status ? now : (entry.transitionedAt || now),
        waitingSince,
        snoozed,
        reason: res.reason,
        tailExcerpt: res.excerpt || null,
        source: 'poll',
      };
      memory.set(session.id, newEntry);

      if (entry.status !== status) {
        if (status === 'gone') {
          // Session disappeared from tmux externally: trigger reconciliation
          if (onGone) onGone(session.id);
        } else if (VALID_STATUSES.has(status)) {
          onChange({
            sessionId: session.id,
            status,
            prev,
            waitingSince,
            snoozed,
            reason: res.reason,
            tailExcerpt: res.excerpt || null,
          });
        }
      }
    }
  }, POLL_MS);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function setStatus(sessionId, newStatus, onChange, reason = 'Reported via hook') {
  if (!VALID_STATUSES.has(newStatus)) {
    return false;
  }
  const entry = memory.get(sessionId) || {};
  const prev = entry.status;
  const now = Date.now();
  let waitingSince = entry.waitingSince || null;
  let snoozed = entry.snoozed || false;
  if (newStatus === 'needs_input') {
    if (prev !== 'needs_input') {
      waitingSince = now;
      snoozed = false;
    }
  } else {
    waitingSince = null;
    snoozed = false;
  }
  const newEntry = {
    ...entry,
    status: newStatus,
    prevStatus: prev,
    transitionedAt: prev !== newStatus ? now : (entry.transitionedAt || now),
    waitingSince,
    snoozed,
    reason,
    tailExcerpt: null,
    source: 'hook',
  };
  memory.set(sessionId, newEntry);
  if (entry.status !== newStatus) {
    if (onChange) {
      onChange({
        sessionId,
        status: newStatus,
        prev,
        waitingSince,
        snoozed,
        reason,
        tailExcerpt: null,
      });
    }
  }
  return true;
}

function snooze(sessionId, snoozed = true, onChange) {
  const entry = memory.get(sessionId);
  if (!entry) return false;
  entry.snoozed = !!snoozed;
  memory.set(sessionId, entry);
  if (onChange) {
    onChange({
      sessionId,
      status: entry.status,
      prev: entry.status,
      waitingSince: entry.waitingSince,
      snoozed: entry.snoozed,
      reason: entry.reason,
      tailExcerpt: entry.tailExcerpt,
    });
  }
  return true;
}

function getDetails(sessionId) {
  const entry = memory.get(sessionId);
  if (!entry) return null;
  return {
    status: entry.status || 'idle',
    waitingSince: entry.waitingSince || null,
    snoozed: !!entry.snoozed,
    transitionedAt: entry.transitionedAt || null,
    reason: entry.reason || 'No observation recorded yet',
    tailExcerpt: entry.tailExcerpt || null,
    source: entry.source || 'poll',
  };
}

function snapshot() {
  const out = {};
  for (const [id, entry] of memory) {
    if (VALID_STATUSES.has(entry.status)) {
      out[id] = entry.status;
    } else {
      out[id] = 'idle';
    }
  }
  return out;
}

module.exports = {
  start,
  stop,
  setStatus,
  snooze,
  getDetails,
  snapshot,
  classify,
  checkPrompt,
  memory,
  PROMPT_PATTERNS,
  VALID_STATUSES,
};
