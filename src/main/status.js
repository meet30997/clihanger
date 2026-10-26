'use strict';

const crypto = require('crypto');
const t = require('./tmux');
const store = require('./store');
const { loadAgents } = require('./agents');

const POLL_MS = 2000;
const IDLE_POLLS = 2;   // ~4s of no change before we stop calling it "working"
// A screen change this soon after you typed, opened, resized, or left a session
// is the TUI repainting for you, not the agent working (ADR-076).
const USER_ECHO_MS = 4000;

const VALID_STATUSES = new Set(['working', 'needs_input', 'idle', 'exited']);

/** sessionId → { hash, unchanged, status, promptKind, seen, userActivityAt, … } */
const memory = new Map();
let timer = null;
/** The session whose terminal is on screen in a focused window, or null. */
let viewer = null;

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

// Glyphs a TUI blinks in place while it waits, e.g. the bullet beside a tool
// call that needs approval. Hashing them as spaces keeps a blink from reading
// as output (ADR-077); real output still adds text.
const BLINKING_GLYPHS = /⏺/g;

function hash(text) {
  return crypto.createHash('sha1').update(text.replace(BLINKING_GLYPHS, ' ')).digest('hex');
}

// A choice list drawn with the chat prompt's marker (Claude's folder-trust
// dialog has no numbers: `❯ No, exit`) is told apart by its footer, which must
// be in the bottom lines so a reply quoting it is not a menu (ADR-078).
const MENU_FOOTER = /\benter\s+(?:to\s+)?(?:confirm|continue|select)\b/i;
const MENU_ITEM = /^\d+[.)]\s/;

/**
 * The lowest line in the tail matching the agent's own chat prompt, or null.
 * Its captured text is the typed input or the placeholder (`› Ask Codex…`).
 */
function chatPromptLine(tailLines, agent) {
  if (!agent?.chatPromptPattern) return null;
  let re;
  try { re = new RegExp(agent.chatPromptPattern, 'u'); } catch { return null; }
  for (let i = tailLines.length - 1; i >= 0; i--) {
    const match = tailLines[i].match(re);
    if (match) return { text: (match[1] || '').trim() };
  }
  return null;
}

/**
 * `reply`: the agent's input line is at the bottom, empty, typed in, or showing
 * a placeholder, so the turn is over. `approval`: a menu or question the agent
 * is blocked on, including one drawn with the input marker (`❯ 1. Yes`). The
 * input line is checked before the question patterns so a reply that ends in
 * "Would you like me to…?" stays a reply.
 */
function checkPrompt(screen, agent) {
  // only consider the bottom of the screen — that's where prompts live
  const lines = screen.trimEnd().split('\n');
  const tailLines = lines.slice(-12);
  const tailText = tailLines.join('\n');
  const bottom = tailLines.map((l) => l.trim()).filter(Boolean).slice(-3);
  const excerpt = bottom.join('\n').slice(0, 300);
  const chat = chatPromptLine(tailLines, agent);
  if (bottom.some((l) => MENU_FOOTER.test(l))) {
    return { matched: true, pattern: MENU_FOOTER.toString(), kind: 'approval', excerpt };
  }
  if (chat && !MENU_ITEM.test(chat.text)) {
    return { matched: true, pattern: 'agent chat prompt', kind: 'reply', excerpt };
  }
  for (const re of PROMPT_PATTERNS) {
    if (re.test(tailText)) {
      return { matched: true, pattern: re.toString(), kind: 'approval', excerpt };
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
    if (prev.status && prev.userActivityAt && Date.now() - prev.userActivityAt < USER_ECHO_MS) {
      return {
        status: prev.status,
        hash: h,
        unchanged: prev.unchanged,
        promptKind: prev.promptKind,
        echo: true,
        reason: 'Screen changed after your input or resize',
        excerpt: prev.tailExcerpt,
      };
    }
    return { status: 'working', hash: h, unchanged: 0, reason: 'Terminal screen content updated' };
  }

  const unchanged = prev.unchanged + 1;

  if (unchanged < IDLE_POLLS) {
    return { status: 'working', hash: h, unchanged, reason: 'Awaiting output stability (~4s)' };
  }
  const promptCheck = checkPrompt(screen, launcher);
  if (promptCheck.matched) {
    return {
      status: 'needs_input',
      hash: h,
      unchanged,
      promptKind: promptCheck.kind,
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
 * @param {(payload: {sessionId: string, status: string, prev: string, waitingSince?: number, snoozed?: boolean, promptKind?: string, seen?: boolean, stale?: boolean, reason?: string, tailExcerpt?: string}) => void} onChange
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
        // Keep the last known status, but say it is no longer being observed.
        const previous = memory.get(session.id);
        if (previous) {
          const staleEntry = {
            ...previous,
            stale: true,
            reason: `Observation unavailable; previous status is stale: ${err.message}`,
            tailExcerpt: null,
          };
          memory.set(session.id, staleEntry);
          if (!previous.stale && VALID_STATUSES.has(staleEntry.status)) {
            onChange(changePayload(session.id, staleEntry, staleEntry.status));
          }
        }
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
        promptKind: status === 'needs_input' ? (res.promptKind || null) : null,
        // Only real agent work makes a seen reply new again.
        seen: status === 'working' && !res.echo ? false : !!entry.seen,
        stale: false,
        reason: res.reason,
        tailExcerpt: res.excerpt || null,
        source: 'poll',
      };
      markSeenIfViewed(session.id, newEntry);
      memory.set(session.id, newEntry);

      if (status === 'gone') {
        // Session disappeared from tmux externally: trigger reconciliation
        if (entry.status !== status && onGone) onGone(session.id);
      } else if (VALID_STATUSES.has(status) && (entry.status !== status
          || entry.promptKind !== newEntry.promptKind || !!entry.seen !== newEntry.seen || !!entry.stale)) {
        onChange(changePayload(session.id, newEntry, prev));
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
    // A hook does not say whether it is reporting a finished turn or a question.
    promptKind: null,
    seen: newStatus === 'working' ? false : !!entry.seen,
    stale: false,
    reason,
    tailExcerpt: null,
    source: 'hook',
  };
  markSeenIfViewed(sessionId, newEntry);
  memory.set(sessionId, newEntry);
  if (entry.status !== newStatus || !!entry.seen !== newEntry.seen || !!entry.stale) {
    if (onChange) onChange(changePayload(sessionId, newEntry, prev));
  }
  return true;
}

/**
 * Looking at a finished turn acknowledges it. A question the agent is blocked
 * on (`approval`) stays waiting until it is answered.
 */
function markSeenIfViewed(sessionId, entry) {
  if (viewer !== sessionId) return;
  if (entry.status === 'idle' || (entry.status === 'needs_input' && entry.promptKind === 'reply')) {
    entry.seen = true;
  }
}

function changePayload(sessionId, entry, prev) {
  return {
    sessionId,
    status: entry.status,
    prev,
    waitingSince: entry.waitingSince || null,
    snoozed: !!entry.snoozed,
    promptKind: entry.promptKind || null,
    seen: !!entry.seen,
    stale: !!entry.stale,
    reason: entry.reason,
    tailExcerpt: entry.tailExcerpt || null,
  };
}

/** Whether a status entry belongs in "Waiting for you". */
function isWaiting(entry) {
  return !!entry && entry.status === 'needs_input' && !entry.snoozed
    && !(entry.promptKind === 'reply' && entry.seen);
}

/** The next few seconds of screen changes in this session are a repaint for you. */
function noteUserActivity(sessionId) {
  const entry = memory.get(sessionId);
  if (entry) entry.userActivityAt = Date.now();
}

/** Record which session is on screen (null: none, or the window is not focused). */
function setViewer(sessionId, onChange) {
  if (viewer === sessionId) return;
  // Both the one you leave and the one you open can repaint at the new size.
  for (const id of [viewer, sessionId]) if (id) noteUserActivity(id);
  viewer = sessionId;
  const entry = sessionId && memory.get(sessionId);
  if (!entry || entry.seen) return;
  markSeenIfViewed(sessionId, entry);
  if (entry.seen && onChange && VALID_STATUSES.has(entry.status)) {
    onChange(changePayload(sessionId, entry, entry.status));
  }
}

function snooze(sessionId, snoozed = true, onChange) {
  const entry = memory.get(sessionId);
  if (!entry) return false;
  entry.snoozed = !!snoozed;
  memory.set(sessionId, entry);
  if (onChange) onChange(changePayload(sessionId, entry, entry.status));
  return true;
}

function getDetails(sessionId) {
  const entry = memory.get(sessionId);
  if (!entry) return null;
  return {
    status: entry.status || 'idle',
    waitingSince: entry.waitingSince || null,
    snoozed: !!entry.snoozed,
    promptKind: entry.promptKind || null,
    seen: !!entry.seen,
    stale: !!entry.stale,
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
  setViewer,
  noteUserActivity,
  isWaiting,
  snooze,
  getDetails,
  snapshot,
  classify,
  checkPrompt,
  memory,
  PROMPT_PATTERNS,
  VALID_STATUSES,
};
