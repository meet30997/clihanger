'use strict';

const { stripVTControlCharacters } = require('util');
const t = require('./tmux');
const store = require('./store');
const { loadAgents } = require('./agents');
const history = require('./conversation-history');

async function listHistory(sessionId, includeMessages = false) {
  const state = store.load();
  const session = state.sessions.find((row) => row.id === sessionId);
  if (!session) throw new Error('Session not found');
  const agent = loadAgents()[session.agentId];
  const projectPath = session.launchPath || session.worktreePath ||
    state.projects.find((project) => project.id === session.projectId)?.path;
  const rows = await history.list(projectPath, agent?.conversationHistory);
  return includeMessages ? rows : rows.map(({ messages, ...row }) => row);
}

async function linkHistory(sessionId, conversationId) {
  const selected = (await listHistory(sessionId)).find((row) => row.conversationId === conversationId);
  if (!selected) throw new Error('Saved conversation is no longer available');
  const state = store.load();
  const session = state.sessions.find((row) => row.id === sessionId);
  if (!session?.pending) throw new Error('Choose a saved chat while this session is stopped');
  session.conversationId = selected.conversationId;
  session.autoTitleConversationId = selected.conversationId;
  session.autoTitle = selected.title;
  store.save(state);
}

let historySync = null;
const submissions = new Map();

async function synchronizeHistory() {
  const started = generation;
  const sources = new Map();
  const agents = loadAgents();
  for (const original of store.load().sessions) {
    if (!agents[original.agentId]?.conversationHistory) continue;
    try {
      const key = `${original.agentId}:${original.launchPath || original.worktreePath || original.projectId}`;
      if (!sources.has(key)) sources.set(key, listHistory(original.id, true));
      const candidates = await sources.get(key);
      const submitted = !original.pending && history.submissionMatch(submissions.get(original.id), candidates);
      const reference = original.autoTitleConversationId || original.conversationId;
      const selected = submitted || (reference
        ? candidates.find((row) => row.conversationId === reference)
        : original.pending && (history.creationMatch(original, candidates) || (candidates.length === 1 ? candidates[0] : null)));
      if (!selected) continue;
      if (submitted) submissions.delete(original.id);
      const state = store.load();
      const session = state.sessions.find((row) => row.id === original.id);
      if (started !== generation || !session || session.pending !== original.pending ||
          session.tmuxName !== original.tmuxName || session.createdAt !== original.createdAt ||
          session.conversationId !== original.conversationId ||
          session.autoTitleConversationId !== original.autoTitleConversationId) continue;
      const changed = session.autoTitle !== selected.title ||
        session.autoTitleConversationId !== selected.conversationId ||
        (submitted && session.conversationId !== selected.conversationId);
      if (!changed) continue;
      session.autoTitle = selected.title;
      session.autoTitleConversationId = selected.conversationId;
      // Only a uniquely matched actual submission establishes a new resume
      // target. Legacy/project-only matches are display references, not links.
      if (submitted) session.conversationId = selected.conversationId;
      store.save(state);
      onChange?.();
    } catch (err) {
      console.error('Saved chat title lookup unavailable:', err.message);
    }
  }
}

function backfillHistory() {
  if (!historySync) historySync = synchronizeHistory().finally(() => { historySync = null; });
  return historySync;
}

// Titles are local excerpts, never an extra model request. Only completed
// transcript rows are supplied here; the editable prompt/placeholder is omitted.
function extractTitle(transcript, agent) {
  const text = stripVTControlCharacters(transcript);
  const pattern = (value) => typeof value === 'string' && value.length <= 500
    ? new RegExp(value, 'gmu') : null;
  const clean = (value) => [...value.replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ').trim()].slice(0, 100).join('');
  try {
    const named = pattern(agent.chatTitlePattern);
    const names = named ? [...text.matchAll(named)]
      .map((m) => clean(m.slice(1).find(Boolean) || '')).filter(Boolean) : [];
    if (names.length) return { title: names[names.length - 1], named: true };
    const prompt = pattern(agent.chatPromptPattern);
    if (!prompt) return null;
    for (const match of text.matchAll(prompt)) {
      const title = clean(match[1] || '');
      if (title && !title.startsWith('/')) return { title, named: false };
    }
  } catch {
    // Invalid user-edited title patterns disable automatic naming for that agent.
  }
  return null;
}

function extractConversationTitle(output, agent) {
  try {
    const prompts = [...output.matchAll(new RegExp(agent.chatPromptPattern, 'gmu'))];
    if (!prompts.length) return null;
    return extractTitle(output, { ...agent, chatPromptPattern: undefined }) ||
      extractTitle(output.slice(0, prompts[prompts.length - 1].index), agent);
  } catch { return null; }
}

let timer = null;
let generation = 0;
let onChange = null;
const busy = new Set();
const scheduled = new Map();

function acceptInputTitle(sessionId, data, title) {
  if (data !== '\r' || typeof title !== 'string') return;
  const state = store.load();
  const session = state.sessions.find((s) => s.id === sessionId);
  const agent = session && loadAgents()[session.agentId];
  if (!session?.tmuxName || session.pending ||
      !agent?.command || agent.kind === 'shell' || !agent.chatPromptPattern) return;
  const clean = stripVTControlCharacters(title).replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  if (!clean || clean.startsWith('/')) return;
  submissions.set(sessionId, { text: [...clean].slice(0, 100).join(''), at: Date.now() });
  if (session.autoTitle) return;
  session.autoTitle = [...clean].slice(0, 100).join('');
  store.save(state);
  onChange?.();
}

async function refresh(sessionId) {
  if (busy.has(sessionId)) return;
  const session = store.load().sessions.find((s) => s.id === sessionId);
  const agent = session && loadAgents()[session.agentId];
  if (!session?.tmuxName || session.pending || session.title || !agent?.command ||
      agent.kind === 'shell' || !agent.chatPromptPattern) return;
  const started = generation;
  const observedSubmission = submissions.get(sessionId);
  busy.add(sessionId);
  try {
    const output = await t.captureChatOutput(session.tmuxName);
    // The last prompt begins the editable block, including wrapped/multiline
    // drafts. Some TUIs park the cursor in their footer, so cursor_y cannot
    // identify this boundary. While no next prompt is visible, wait for it.
    // Native titles may live below the editor, in a status footer.
    const candidate = extractConversationTitle(output, agent);
    if (!candidate || started !== generation) return;
    // Re-read after tmux I/O: rename, removal, restart and quit may have happened.
    const candidates = await listHistory(sessionId, true);
    let identified = null;
    if (candidate.named) {
      const matches = candidates.filter((row) => row.title === candidate.title);
      if (matches.length === 1) identified = matches[0];
    } else if (!submissions.has(sessionId)) {
      // A tmux history can contain multiple conversations. Prefer the latest
      // completed user message for identity instead of its oldest prompt.
      const prompts = [...output.matchAll(new RegExp(agent.chatPromptPattern, 'gmu'))].slice(0, -1);
      for (const prompt of prompts.reverse().slice(0, 32)) {
        const text = history.cleanTitle(prompt[1]);
        if (!text || text.startsWith('/')) continue;
        const matches = candidates.filter((row) => row.messages?.some((message) => message.text === text));
        if (matches.length === 1) { identified = matches[0]; break; }
      }
    }
    const state = store.load();
    const current = state.sessions.find((s) => s.id === sessionId);
    if (!current || current.pending || current.tmuxName !== session.tmuxName || current.title ||
        started !== generation || current.conversationId !== session.conversationId ||
        current.autoTitleConversationId !== session.autoTitleConversationId ||
        submissions.get(sessionId) !== observedSubmission) return;
    const bound = candidates.find((row) => row.conversationId ===
      (current.autoTitleConversationId || current.conversationId));
    // Provider metadata remains authoritative if a TUI footer has not repainted
    // after a rename made in another client.
    const title = identified?.title || bound?.title ||
      (candidate.named || !current.autoTitle ? candidate.title : current.autoTitle);
    if (current.autoTitle === title && (!identified || current.conversationId === identified.conversationId)) return;
    current.autoTitle = title;
    if (identified) {
      current.conversationId = identified.conversationId;
      current.autoTitleConversationId = identified.conversationId;
    }
    store.save(state);
    onChange?.();
  } catch {
    // Missing panes/output leave the title unknown; never replace it with an error.
  } finally {
    busy.delete(sessionId);
  }
}

function schedule(sessionId) {
  clearTimeout(scheduled.get(sessionId));
  scheduled.set(sessionId, setTimeout(() => {
    scheduled.delete(sessionId);
    void refresh(sessionId);
  }, 300));
}

function stop() {
  generation++;
  clearInterval(timer);
  timer = null;
  for (const timeout of scheduled.values()) clearTimeout(timeout);
  scheduled.clear();
  submissions.clear();
  onChange = null;
}

function start(changed) {
  stop();
  onChange = changed;
  // Native metadata may change without terminal output, including for stopped
  // chats. Poll known titles too and broadcast only actual changes.
  timer = setInterval(() => {
    void backfillHistory();
    for (const session of store.load().sessions) {
      if (!session.title && !session.pending) void refresh(session.id);
    }
    const ids = new Set(store.load().sessions.map((row) => row.id));
    for (const [id, submission] of submissions) {
      if (!ids.has(id) || Date.now() - submission.at > 120000) submissions.delete(id);
    }
  }, 2000);
}

module.exports = { extractTitle, extractConversationTitle, acceptInputTitle, refresh, schedule, start, stop,
  listHistory, linkHistory, backfillHistory };
