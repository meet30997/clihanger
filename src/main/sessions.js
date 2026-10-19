'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { stripVTControlCharacters } = require('util');
const t = require('./tmux');
const store = require('./store');
const { loadAgents } = require('./agents');
const presets = require('./presets');
const status = require('./status');

// A resume command has to remain in the foreground through this measured
// startup window, and its raw pane output must not match the agent's configured
// rejection pattern.
const RESUME_PROBE_MS = 2500;
const RESUME_PROBE_POLL_MS = 100;
const RESUME_PROBE_BYTES = 64 * 1024;
const SHELL_COMMANDS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'tcsh', 'csh']);

/**
 * Drop sessions whose tmux session is gone; adopt tmux sessions we don't know about.
 * Call this on startup and after any create/kill.
 */
async function reconcile() {
  const live = await t.listSessions();
  const state = store.load();
  const liveNames = new Set(live.map((s) => s.name));

  // 1. forget sessions tmux no longer has. A parked session has no
  //    tmux session by definition — it is an entry waiting to be opened, not a
  //    dead one, so it survives this.
  state.sessions = state.sessions.filter((s) => s.pending || liveNames.has(s.tmuxName));

  // 2. adopt any hangar_* session we lost track of (e.g. state.json was deleted)
  const known = new Set(state.sessions.map((s) => s.tmuxName));
  for (const l of live) {
    if (known.has(l.name)) continue;
    // name shape: hangar_<slug>_<agent>_<n>
    const parts = l.name.split('_');
    const agentId = parts.length >= 4 ? parts[parts.length - 2] : 'unknown';
    state.sessions.push({
      id: store.id('s'),
      projectId: null,          // orphan: shown under "Unassigned"
      agentId,
      tmuxName: l.name,
      title: null,
      createdAt: l.createdAt,
    });
  }

  // 3. drop projects that no longer exist on disk? No — user may have an
  //    external drive unmounted. Leave them; the UI marks them unavailable.

  if (state.lastActiveSessionId &&
      !state.sessions.some((s) => s.id === state.lastActiveSessionId)) {
    state.lastActiveSessionId = state.sessions[0]?.id ?? null;
  }

  return store.save(state);
}

function addProject(projectPath) {
  const state = store.load();
  if (state.projects.some((p) => p.path === projectPath)) return state;
  const agents = loadAgents();
  const defaultAgent = Object.keys(agents)[0] || 'default';
  state.projects.push({
    id: store.id('p'),
    name: path.basename(projectPath),
    path: projectPath,
    defaultAgent,
  });
  return store.save(state);
}

function removeProject(projectId) {
  const state = store.load();
  state.projects = state.projects.filter((p) => p.id !== projectId);
  // its sessions become orphans rather than being killed
  state.sessions.forEach((s) => {
    if (s.projectId === projectId) s.projectId = null;
  });
  return store.save(state);
}

function execGit(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || '').trim() || err.message));
      resolve(stdout.trim());
    });
  });
}

function ensureGitExclude(projectPath) {
  try {
    const gitDir = path.join(projectPath, '.git');
    if (fs.existsSync(gitDir)) {
      const isDirectory = fs.statSync(gitDir).isDirectory();
      if (isDirectory) {
        const excludeDir = path.join(gitDir, 'info');
        const excludeFile = path.join(excludeDir, 'exclude');
        fs.mkdirSync(excludeDir, { recursive: true });
        let content = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf8') : '';
        if (!content.includes('.hangar-worktrees')) {
          const suffix = content.endsWith('\n') || content.length === 0 ? '' : '\n';
          fs.writeFileSync(excludeFile, content + suffix + '.hangar-worktrees\n', 'utf8');
        }
      }
    }
  } catch (err) {
    console.error('Failed to update git exclude:', err.message);
  }
}

async function createSession({
  projectId,
  agentId,
  branch,
  launchPath: customLaunchPath,
  title: customTitle,
  note: customNote,
  command: customCommand,
}) {
  const state = store.load();
  const project = state.projects.find((p) => p.id === projectId);
  if (!project) throw new Error('Project not found');

  const agent = loadAgents()[agentId];
  if (!agent) throw new Error(`Unknown agent: ${agentId}`);

  let launchPath = project.path;
  let worktreePath = null;

  if (branch && typeof branch === 'string' && branch.trim()) {
    const branchName = branch.trim();
    const worktreeSlug = t.slugify(branchName);
    const worktreeDir = path.join(project.path, '.hangar-worktrees', worktreeSlug);

    try {
      await execGit(['rev-parse', '--is-inside-work-tree'], project.path);
      await execGit(['rev-parse', '--verify', 'HEAD'], project.path);

      ensureGitExclude(project.path);
      fs.mkdirSync(path.join(project.path, '.hangar-worktrees'), { recursive: true });

      try {
        await execGit(['worktree', 'add', '-b', branchName, worktreeDir, 'HEAD'], project.path);
      } catch (e) {
        // If branch already exists, checkout existing branch
        await execGit(['worktree', 'add', worktreeDir, branchName], project.path);
      }
      launchPath = worktreeDir;
      worktreePath = worktreeDir;
    } catch (err) {
      throw new Error(`Failed to create git worktree for "${branchName}": ${err.message}`);
    }
  } else if (customLaunchPath && typeof customLaunchPath === 'string') {
    if (!fs.existsSync(customLaunchPath)) {
      throw new Error(`Directory does not exist: ${customLaunchPath}`);
    }
    launchPath = customLaunchPath;
  }

  let commandToRun = agent.command;
  if (customCommand && typeof customCommand === 'string' && customCommand.trim()) {
    const isShell = agent.kind === 'shell' || !agent.command;
    if (isShell) {
      commandToRun = customCommand.trim();
    }
  }

  const sessionId = store.id('s');
  const tmuxName = await t.createSession({
    projectPath: launchPath,
    agentId,
    command: commandToRun,
    env: { HANGAR_SESSION: sessionId },
  });

  const sessionTitle = customTitle && typeof customTitle === 'string' && customTitle.trim()
    ? customTitle.trim().slice(0, 100)
    : (branch && typeof branch === 'string' && branch.trim() ? `[${branch.trim()}]` : null);

  const sessionNote = customNote && typeof customNote === 'string' && customNote.trim()
    ? customNote.trim().slice(0, 500)
    : null;

  const fresh = store.load();
  fresh.sessions.push({
    id: sessionId,
    projectId,
    agentId,
    tmuxName,
    title: sessionTitle,
    note: sessionNote,
    launchPath,
    worktreePath,
    createdAt: Date.now(),
  });
  fresh.lastActiveSessionId = sessionId;
  store.save(fresh);
  const reconciled = await reconcile();
  return { ...reconciled, createdSessionId: sessionId };
}

async function killSession(sessionId) {
  const state = store.load();
  const session = state.sessions.find((s) => s.id === sessionId);
  let worktreeWarning = null;

  // A parked session owns no process and no tmux session, and `reconcile()`
  // deliberately keeps it, so removing the row here is the whole kill.
  if (session && session.pending) {
    state.sessions = state.sessions.filter((s) => s.id !== sessionId);
    if (state.lastActiveSessionId === sessionId) {
      state.lastActiveSessionId = state.sessions[0]?.id ?? null;
    }
    store.save(state);
    if (session.worktreePath) {
      try {
        const project = state.projects.find((p) => p.id === session.projectId);
        const rootPath = project?.path || path.dirname(path.dirname(session.worktreePath));
        await execGit(['worktree', 'remove', session.worktreePath], rootPath);
      } catch (err) {
        console.error('Failed to remove git worktree cleanly:', err.message);
        const out = fullState();
        out.lastWarning = `Session removed; worktree kept — it has uncommitted changes at ${session.worktreePath}`;
        return out;
      }
    }
    return fullState();
  }

  if (session) {
    try {
      const ports = require('./ports');
      const listeners = await ports.list();
      const owned = listeners.filter((l) => l.sessionId === sessionId);
      for (const l of owned) {
        if (l.pid && l.pid > 1) {
          await ports.kill(l.pid);
        }
      }
    } catch (err) {
      console.error('Error reaping session ports:', err.message);
    }
    await t.killSession(session.tmuxName);

    if (session.worktreePath) {
      try {
        const project = state.projects.find((p) => p.id === session.projectId);
        const rootPath = project?.path || path.dirname(path.dirname(session.worktreePath));
        // Remove worktree safely without --force to prevent data loss on uncommitted changes
        await execGit(['worktree', 'remove', session.worktreePath], rootPath);
      } catch (err) {
        console.error('Failed to remove git worktree cleanly:', err.message);
        worktreeWarning = `Session killed; worktree kept — it has uncommitted changes at ${session.worktreePath}`;
      }
    }
  }
  await reconcile();
  const updatedState = fullState();
  if (worktreeWarning) updatedState.lastWarning = worktreeWarning;
  return updatedState;
}

function renameSession(sessionId, title) {
  const state = store.load();
  const session = state.sessions.find((s) => s.id === sessionId);
  if (session) {
    session.title = typeof title === 'string' && title.trim() ? title.trim() : null;
    store.save(state);
  }
  return fullState();
}

function setSessionNote(sessionId, note) {
  const state = store.load();
  const session = state.sessions.find((s) => s.id === sessionId);
  if (session) {
    session.note = typeof note === 'string' && note.trim()
      ? note.trim().slice(0, 500)
      : null;
    store.save(state);
  }
  return fullState();
}

/**
 * Safely quote an argument for POSIX shell execution so it is treated strictly
 * as a literal value, preventing shell metacharacter expansion or command injection.
 */
function quoteShellArg(val) {
  return "'" + String(val).replace(/'/g, "'\\''") + "'";
}

/**
 * Construct a safe resume command from an agent's resumeCommand template
 * and an explicit conversation identifier.
 */
function buildResumeCommand(agent, conversationId) {
  if (!agent || typeof agent.resumeCommand !== 'string' || !agent.resumeCommand.trim()) {
    throw new Error('Agent does not support resuming conversations');
  }

  if (typeof conversationId !== 'string' || !conversationId.trim()) {
    throw new Error('No conversation identifier configured for this session');
  }

  const trimmedId = conversationId.trim();
  if (/[\x00-\x1f\x7f]/.test(trimmedId)) {
    throw new Error('Invalid conversation identifier: contains control characters or newlines');
  }

  if (trimmedId.startsWith('-')) {
    throw new Error('Invalid conversation identifier: must not be a command-line option');
  }

  if (trimmedId.length > 200) {
    throw new Error('Conversation identifier exceeds maximum length (200 characters)');
  }

  const safeQuotedId = quoteShellArg(trimmedId);
  let cmd = agent.resumeCommand.trim();
  if (cmd.includes("`")) throw new Error("Backtick substitutions are not supported in resume templates");
  // Placeholders must be whole, unquoted arguments. Quoting an already-quoted
  // placeholder can re-enable shell expansion inside the identifier.
  let quote = null;
  let escaped = false;
  for (let i = 0; i < cmd.length; i++) {
    const placeholder = cmd.slice(i).match(/^\{(?:conversationId|id)\}/);
    if (placeholder) {
      const end = i + placeholder[0].length;
      if (quote || escaped || (i > 0 && !/\s/.test(cmd[i - 1])) ||
          (end < cmd.length && !/\s/.test(cmd[end]))) {
        throw new Error('Resume identifier placeholder must be a standalone unquoted argument');
      }
      i = end - 1;
      continue;
    }
    if (escaped) { escaped = false; continue; }
    if (cmd[i] === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (cmd[i] === quote) quote = null; }
    else if (cmd[i] === "'" || cmd[i] === '"') quote = cmd[i];
  }
  if (quote || escaped) throw new Error("Unbalanced quoting in resume template");
  const hasPlaceholder = /\{(?:conversationId|id)\}/.test(cmd);
  // Function replacements preserve literal $&, $', and $` in user values.
  cmd = cmd.replace(/\{command\}|\{conversationId\}|\{id\}/g, (token) =>
    token === '{command}' ? (agent.command || '').trim() : safeQuotedId);
  if (!hasPlaceholder) cmd = `${cmd} ${safeQuotedId}`;

  return cmd.trim();
}

/**
 * Construct the agent-native conversation picker/continue command used when
 * CliHanger has no explicit conversation identifier. The template is trusted
 * user configuration, but unknown placeholders and backtick substitutions are
 * rejected so a typo fails visibly instead of launching the wrong command.
 */
function buildResumePickerCommand(agent) {
  if (!agent || typeof agent.resumePickerCommand !== 'string' || !agent.resumePickerCommand.trim()) {
    throw new Error('No saved-conversation picker is configured for this agent');
  }

  let cmd = agent.resumePickerCommand.trim();
  if (cmd.includes('`')) {
    throw new Error('Backtick substitutions are not supported in resume picker templates');
  }

  const placeholders = cmd.match(/\{[^{}]+\}/g) || [];
  if (placeholders.some((token) => token !== '{command}')) {
    throw new Error('Resume picker template contains an unsupported placeholder');
  }

  cmd = cmd.replace(/\{command\}/g, () => (agent.command || '').trim());
  if (!cmd) throw new Error('Resume picker command is empty');
  return cmd;
}

function buildResumeFailurePattern(agent) {
  if (agent.resumeFailurePattern === undefined || agent.resumeFailurePattern === null) return null;
  if (typeof agent.resumeFailurePattern !== 'string' || !agent.resumeFailurePattern.trim()) {
    throw new Error('Agent resume failure pattern must be a non-empty string');
  }
  if (agent.resumeFailurePattern.length > 500) {
    throw new Error('Agent resume failure pattern exceeds maximum length (500 characters)');
  }
  try {
    return new RegExp(agent.resumeFailurePattern, 'i');
  } catch (err) {
    throw new Error(`Agent resume failure pattern is invalid: ${err.message}`);
  }
}

function readResumeProbe(capturePath) {
  try {
    const size = fs.statSync(capturePath).size;
    const length = Math.min(size, RESUME_PROBE_BYTES);
    if (!length) return '';
    const fd = fs.openSync(capturePath, 'r');
    try {
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, size - length);
      return stripVTControlCharacters(buf.toString('utf8')).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

function resumeFailureMessage(output, failurePattern = null) {
  const match = failurePattern ? output.match(failurePattern) : null;
  if (match && match[0]) {
    const reason = match[0].replace(/\s+/g, ' ').trim().slice(0, 240);
    return `Resume rejected: ${reason}`;
  }
  return 'Resume command exited during startup; the parked session was preserved';
}

async function verifyResumeStartup(tmuxName, capturePath, failurePattern) {
  const deadline = Date.now() + RESUME_PROBE_MS;
  let output = '';
  try {
    while (Date.now() < deadline) {
      output = readResumeProbe(capturePath);
      if (failurePattern && failurePattern.test(output)) {
        throw new Error(resumeFailureMessage(output, failurePattern));
      }
      await new Promise((resolve) => setTimeout(resolve, RESUME_PROBE_POLL_MS));
    }

    output = readResumeProbe(capturePath);
    if (failurePattern && failurePattern.test(output)) {
      throw new Error(resumeFailureMessage(output, failurePattern));
    }

    const command = await t.paneCurrentCommand(tmuxName);
    if (!command || SHELL_COMMANDS.has(path.basename(command))) {
      throw new Error(resumeFailureMessage(output));
    }
  } finally {
    await t.stopPaneCapture(tmuxName).catch(() => {});
    try { fs.unlinkSync(capturePath); } catch (err) { if (err.code !== 'ENOENT') console.error('Failed to remove resume probe:', err.message); }
  }
}

function setSessionConversation(sessionId, conversationId) {
  const state = store.load();
  const session = state.sessions.find((s) => s.id === sessionId);
  if (session) {
    const previousId = session.conversationId;
    if (typeof conversationId === 'string' && conversationId.trim()) {
      const trimmed = conversationId.trim();
      if (/[\x00-\x1f\x7f]/.test(trimmed)) {
        throw new Error('Invalid conversation identifier: contains control characters or newlines');
      }
      if (trimmed.length > 200) {
        throw new Error('Conversation identifier exceeds maximum length (200 characters)');
      }
      session.conversationId = trimmed;
    } else {
      session.conversationId = null;
    }
    if (session.pending && previousId !== session.conversationId) {
      delete session.autoTitle;
      delete session.autoTitleConversationId;
    }
    store.save(state);
  }
  return fullState();
}

async function searchScrollback(query) {
  if (!query || typeof query !== 'string' || !query.trim()) return [];
  const q = query.trim().toLowerCase();
  const state = store.load();
  const results = [];

  for (const session of state.sessions) {
    try {
      const scrollback = await t.captureFullScrollback(session.tmuxName);
      if (!scrollback) continue;
      const lines = scrollback.split('\n');
      const matches = [];
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(q)) {
          matches.push({
            lineNumber: i + 1,
            line: lines[i].trim(),
          });
        }
      }
      if (matches.length > 0) {
        const project = state.projects.find((p) => p.id === session.projectId);
        results.push({
          sessionId: session.id,
          title: session.title || session.autoTitle || null,
          agentId: session.agentId,
          projectName: project?.name ?? 'unassigned',
          matchCount: matches.length,
          matches: matches.slice(-5),
        });
      }
    } catch {}
  }
  return results;
}

/**
 * Park every session so the next launch still lists it.
 *
 * Quitting kills the whole tmux server, so no process can survive to be
 * reconciled. Instead of rebuilding the sessions at startup — which spawns work
 * nobody asked for and races the renderer's first `state:get` — the rows stay in
 * `state.json` with their tmux name dropped and `pending: true` set. A parked
 * session is a sidebar entry and nothing more; `startSession()` gives it a real
 * tmux session the first time it is opened.
 *
 * `launchPath` is resolved here, while the project is still known, so a session
 * whose project is removed later can still be started. A session with no project
 * and no worktree has no directory to name, so it is dropped rather than guessed
 * at. Synchronous on purpose: this runs inside `before-quit`.
 */
function parkSessions() {
  const state = store.load();
  state.sessions = state.sessions
    .map((s) => {
      const project = state.projects.find((p) => p.id === s.projectId);
      const launchPath = s.launchPath || s.worktreePath || project?.path || null;
      if (!launchPath) return null;
      return { ...s, tmuxName: null, pending: true, launchPath };
    })
    .filter(Boolean);
  if (!state.sessions.some((s) => s.id === state.lastActiveSessionId)) {
    state.lastActiveSessionId = state.sessions[0]?.id ?? null;
  }
  return store.save(state);
}

/**
 * Give a parked session a real tmux session, keeping its id, title, project and
 * position. Called from `term:open`, so the relaunch happens when the user opens
 * the session and never before. A no-op for a session that is already running.
 */
const startingSessions = new Map();

async function startSession(sessionId, options = {}) {
  // Opening a parked row can be requested more than once before createSession
  // finishes (double-click, keyboard activation, or a renderer re-render). All
  // callers should observe the same launch result; creating a second tmux
  // session or turning a harmless duplicate into a user-visible error is wrong.
  if (startingSessions.has(sessionId)) return startingSessions.get(sessionId);
  const pending = startParkedSession(sessionId, options);
  startingSessions.set(sessionId, pending);
  try { return await pending; }
  finally {
    if (startingSessions.get(sessionId) === pending) startingSessions.delete(sessionId);
  }
}

async function startParkedSession(sessionId, options = {}) {
  const state = store.load();
  const session = state.sessions.find((s) => s.id === sessionId);
  if (!session) throw new Error('Session not found');
  if (!session.pending) return session;

  const agent = loadAgents()[session.agentId];
  if (!agent) throw new Error(`Unknown agent: ${session.agentId}`);
  if (!session.launchPath || !fs.existsSync(session.launchPath) || !fs.statSync(session.launchPath).isDirectory()) {
    throw new Error(`Folder is gone: ${session.launchPath ?? 'unknown'}`);
  }

  let commandToRun = agent.command;
  let resumeFailurePattern = null;
  let capturePath = null;
  if (options && options.resume) {
    commandToRun = session.conversationId && typeof agent.resumeCommand === 'string' && agent.resumeCommand.trim()
      ? buildResumeCommand(agent, session.conversationId)
      : buildResumePickerCommand(agent);
    resumeFailurePattern = buildResumeFailurePattern(agent);
    capturePath = path.join(t.HANGAR_DIR, `.resume-${session.id}.log`);
    try { fs.unlinkSync(capturePath); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }

  const tmuxName = await t.createSession({
    projectPath: session.launchPath,
    agentId: session.agentId,
    command: commandToRun,
    env: { HANGAR_SESSION: sessionId },
    capturePath,
  });

  if (options && options.resume) {
    try {
      await verifyResumeStartup(tmuxName, capturePath, resumeFailurePattern);
    } catch (err) {
      await t.killSession(tmuxName).catch(() => {});
      throw err;
    }
  }

  // re-read: creating the session took a moment, and anything could have written
  const fresh = store.load();
  const row = fresh.sessions.find((s) => s.id === sessionId);
  if (!row) {
    await t.killSession(tmuxName);
    throw new Error('Session disappeared while starting');
  }
  row.tmuxName = tmuxName;
  row.pending = false;
  // A fresh start or native picker can change the underlying conversation.
  // Preserve explicit names; rediscover automatic names from its transcript.
  delete row.autoTitle;
  delete row.autoTitleConversationId;
  if (!options.resume) row.conversationId = null;
  row.createdAt = Date.now();
  store.save(fresh);
  return row;
}

function fullState() {
  const state = store.load();
  return {
    version: state.version,
    projects: state.projects,
    sessions: state.sessions,
    lastActiveSessionId: state.lastActiveSessionId,
    agents: loadAgents(),
  };
}

const activePresetLaunches = new Set();

async function launchPreset({ projectId, presetName, selectedIndices = null }) {
  const state = store.load();
  const project = state.projects.find((p) => p.id === projectId);
  if (!project) throw new Error('Project not found');

  const lockKey = `${projectId}:${presetName}`;
  if (activePresetLaunches.has(lockKey)) {
    throw new Error(`Preset "${presetName}" is already launching`);
  }

  const preview = presets.previewPreset(project.path, project.name, presetName);
  if (!preview.valid && (!selectedIndices || selectedIndices.length === 0)) {
    throw new Error(`Cannot launch invalid preset: ${preview.errors.join('; ')}`);
  }

  let entries = preview.entries;
  if (Array.isArray(selectedIndices) && selectedIndices.length > 0) {
    const targetSet = new Set(selectedIndices);
    entries = entries.filter((e) => targetSet.has(e.index));
  }

  if (entries.some((entry) => !entry.valid)) {
    throw new Error('Cannot launch selected entries: ' + entries.flatMap((entry) => entry.errors).join('; '));
  }

  if (entries.length === 0) {
    throw new Error('No entries selected for launch');
  }

  activePresetLaunches.add(lockKey);
  const results = {
    successful: [],
    failed: [],
    state: null,
  };

  try {
    for (const entry of entries) {
      if (!entry.valid) {
        results.failed.push({
          index: entry.index,
          title: entry.title,
          error: entry.errors.join('; '),
        });
        continue;
      }
      try {
        const res = await createSession({
          projectId,
          agentId: entry.agentId,
          launchPath: entry.resolvedPath,
          title: entry.title,
          note: entry.note,
          command: entry.commandAllowed ? entry.command : null,
        });
        results.successful.push({
          index: entry.index,
          sessionId: res.createdSessionId,
          title: entry.title,
        });
      } catch (err) {
        results.failed.push({
          index: entry.index,
          title: entry.title,
          error: err.message,
        });
      }
    }
  } finally {
    activePresetLaunches.delete(lockKey);
  }

  results.state = fullState();
  return results;
}

function formatHandoffMarkdown(data) {
  const lines = [
    `### Session Context Handoff`,
    `- **Session:** ${data.title} (${data.agentLabel})`,
    `- **Project:** ${data.projectName}${data.projectPath ? ` (\`${data.projectPath}\`)` : ''}`,
    `- **Working Directory:** \`${data.launchPath || 'unknown'}\``,
  ];

  if (data.note) {
    lines.push(`- **Task Note:** ${data.note}`);
  }
  if (data.conversationId) {
    lines.push(`- **Conversation ID:** \`${data.conversationId}\``);
  }

  lines.push(`- **Status:** ${data.status} (captured at ${data.captureTime})`);

  if (data.isParked) {
    lines.push('', `*(Live terminal output unavailable: session is parked)*`);
  } else if (data.scrollbackStatus === 'error') {
    lines.push('', `*(Failed to capture terminal output: ${data.scrollbackError || 'unknown error'})*`);
  } else if (data.scrollbackStatus === 'empty' || !data.scrollback) {
    lines.push('', `*(Terminal scrollback is empty)*`);
  } else {
    lines.push('', `#### Recent Terminal Output:`, '```text');
    if (data.scrollbackTruncated) {
      lines.push(`[... earlier output truncated to last ${data.scrollbackLines} lines / 20KB ...]`);
    }
    lines.push(data.scrollback);
    lines.push('```');
  }

  return lines.join('\n');
}

async function getHandoffData(sessionId, options = {}) {
  const state = store.load();
  const session = state.sessions.find((s) => s.id === sessionId);
  if (!session) throw new Error('Session not found');

  const project = state.projects.find((p) => p.id === session.projectId);
  const loadedAgents = loadAgents();
  const agent = loadedAgents[session.agentId];

  const sessionTitle = session.title || session.autoTitle || agent?.label || session.agentId;
  const agentLabel = agent?.label || session.agentId;
  const projectName = project?.name || 'Unassigned';
  const projectPath = project?.path || null;
  const launchPath = session.launchPath || session.worktreePath || project?.path || null;
  const statusDetails = status.getDetails(sessionId);
  const currentStatus = statusDetails?.status || (session.pending ? 'not started' : 'idle');

  const maxLines = Math.min(Math.max(1, Math.floor(Number(options.lines) || 80)), 300);
  let scrollback = null;
  let scrollbackStatus = 'parked';
  let scrollbackTruncated = false;
  let scrollbackError = null;

  if (!session.pending && session.tmuxName) {
    try {
      const exists = await t.hasSession(session.tmuxName);
      if (!exists) {
        scrollback = null;
        scrollbackStatus = 'error';
        scrollbackError = 'tmux session is not running';
      } else {
        const rawCapture = await t.capturePane(session.tmuxName, maxLines + 1, true);
        if (rawCapture && typeof rawCapture === 'string') {
          const clean = stripVTControlCharacters(rawCapture).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trimEnd();
          const capturedLines = clean.split('\n');
          scrollbackTruncated = capturedLines.length > maxLines;
          let text = capturedLines.slice(-maxLines).join('\n');
          if (Buffer.byteLength(text, 'utf8') > 20480) {
            const bytes = Buffer.from(text, 'utf8');
            let offset = bytes.length - 20480;
            while ((bytes[offset] & 0xc0) === 0x80) offset++;
            text = bytes.subarray(offset).toString('utf8');
            scrollbackTruncated = true;
          }
          scrollback = text;
          scrollbackStatus = text.length > 0 ? 'captured' : 'empty';
        } else {
          scrollback = '';
          scrollbackStatus = 'empty';
        }
      }
    } catch (err) {
      scrollback = null;
      scrollbackStatus = 'error';
      scrollbackError = err.message;
    }
  }

  const result = {
    sessionId,
    title: sessionTitle,
    agentId: session.agentId,
    agentLabel,
    projectName,
    projectPath,
    launchPath,
    worktreePath: session.worktreePath || null,
    note: session.note || null,
    conversationId: session.conversationId || null,
    status: currentStatus,
    isParked: !!session.pending,
    captureTime: new Date().toISOString(),
    scrollback,
    scrollbackLines: maxLines,
    scrollbackTruncated,
    scrollbackStatus,
    scrollbackError,
  };

  result.formattedMarkdown = formatHandoffMarkdown(result);
  return result;
}

module.exports = {
  reconcile,
  addProject,
  removeProject,
  createSession,
  killSession,
  parkSessions,
  startSession,
  renameSession,
  setSessionNote,
  setSessionConversation,
  buildResumeCommand,
  buildResumePickerCommand,
  buildResumeFailurePattern,
  verifyResumeStartup,
  quoteShellArg,
  searchScrollback,
  launchPreset,
  getHandoffData,
  formatHandoffMarkdown,
  fullState,
  ensureGitExclude,
};
