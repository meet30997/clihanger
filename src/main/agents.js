'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HANGAR_DIR } = require('./tmux');
const { validateOptions, migrateBakedOptions } = require('./agent-options');

const AGENTS_FILE = path.join(HANGAR_DIR, 'agents.json');
const HOOK_FILE = path.join(HANGAR_DIR, 'hook.sh');
const HOOK_TOKEN_FILE = path.join(HANGAR_DIR, 'hook.token');
const DEFAULTS_FILE = path.join(__dirname, 'defaults', 'agents.json');

function getDefaultAgents() {
  try {
    return JSON.parse(fs.readFileSync(DEFAULTS_FILE, 'utf8'));
  } catch (err) {
    console.error('Failed to load default agents from defaults file:', err.message);
    return {};
  }
}

function getHookToken() {
  try {
    fs.mkdirSync(HANGAR_DIR, { recursive: true });
    if (fs.existsSync(HOOK_TOKEN_FILE)) {
      return fs.readFileSync(HOOK_TOKEN_FILE, 'utf8').trim();
    }
    const token = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(HOOK_TOKEN_FILE, token, { mode: 0o600 });
    return token;
  } catch (err) {
    console.error('Failed to manage hook token:', err.message);
    return '';
  }
}

const HOOK_SCRIPT_TEMPLATE = `#!/bin/bash
# usage: hook.sh <event>
# HANGAR_SESSION is injected by tmux when the session is created.
[ -z "$HANGAR_SESSION" ] && exit 0
TOKEN=$(cat "$HOME/.hangar/hook.token" 2>/dev/null)
[ -z "$TOKEN" ] && exit 0
curl -s -m 1 -X POST http://127.0.0.1:47823/ \\
  -H 'content-type: application/json' \\
  -H "authorization: Bearer $TOKEN" \\
  -d "{\\"session\\":\\"$HANGAR_SESSION\\",\\"event\\":\\"$1\\"}" >/dev/null 2>&1 || true
exit 0
`;

function ensureHookScript() {
  try {
    fs.mkdirSync(HANGAR_DIR, { recursive: true });
    getHookToken();
    if (!fs.existsSync(HOOK_FILE)) {
      fs.writeFileSync(HOOK_FILE, HOOK_SCRIPT_TEMPLATE, { mode: 0o700 });
    }
  } catch (err) {
    console.error('Failed to create hook.sh:', err.message);
  }
}

function mergeDefaults(configured, defaults = getDefaultAgents()) {
  // Work on a copy: the Settings JSON represents the file, not inherited data.
  configured = JSON.parse(JSON.stringify(configured));
  // Built-in shell launchers are app capabilities, not agent preferences. Merge
  // them into existing user configs without re-adding any removed agent CLI.
  const shellLaunchers = Object.fromEntries(
    Object.entries(defaults).filter(([, entry]) => entry.kind === 'shell')
  );
  for (const [id, def] of Object.entries(defaults)) {
    // Flags baked into a bundled command become its enabled options, so the
    // effective command matches the default again and inherits the rest.
    if (configured[id] && configured[id].command !== def.command && configured[id].launchOptions === undefined) {
      const migrated = migrateBakedOptions(configured[id].command, def.command || '', def.launchOptions);
      if (migrated) Object.assign(configured[id], { command: def.command, launchOptions: migrated });
    }
    if (configured[id] && configured[id].command === def.command) {
      for (const field of ['icon', 'chatPromptPattern', 'chatTitlePattern', 'conversationHistory', 'launchOptions']) {
        if (configured[id][field] === undefined && def[field]) configured[id][field] = def[field];
      }
    }
    if (configured[id] && configured[id].command === def.command && configured[id].resumeCommand === undefined && def.resumeCommand) {
      configured[id].resumeCommand = def.resumeCommand;
    }
    if (configured[id] && configured[id].command === def.command && configured[id].resumePickerCommand === undefined && def.resumePickerCommand) {
      configured[id].resumePickerCommand = def.resumePickerCommand;
    }
    if (configured[id] && configured[id].command === def.command && configured[id].resumeFailurePattern === undefined && def.resumeFailurePattern) {
      configured[id].resumeFailurePattern = def.resumeFailurePattern;
    }
  }
  return { ...shellLaunchers, ...configured };
}

function parseConfiguration(json) {
  if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > 1024 * 1024) {
    throw new Error('Agent JSON must be text smaller than 1 MiB');
  }
  const configured = JSON.parse(json);
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) {
    throw new Error('Agent JSON must be an object keyed by agent ID');
  }
  if (Object.keys(configured).length > 256) throw new Error('Agent JSON supports at most 256 agents');
  for (const [id, agent] of Object.entries(configured)) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(id) || ['constructor', 'prototype', '__proto__'].includes(id)) {
      throw new Error(`Invalid agent ID: ${id}. Use 1–64 letters, numbers or hyphens`);
    }
    if (!agent || typeof agent !== 'object' || Array.isArray(agent)) throw new Error(`${id}: definition must be an object`);
    if (typeof agent.label !== 'string' || !agent.label.trim() || agent.label.length > 120) {
      throw new Error(`${id}: label must be 1–120 characters`);
    }
    if (typeof agent.command !== 'string' || agent.command.length > 8192 || /[\x00-\x1f\x7f]/.test(agent.command)) {
      throw new Error(`${id}: command must be a single-line string (at most 8192 characters)`);
    }
    if (typeof agent.color !== 'string' || !/^#[a-fA-F0-9]{6}$/.test(agent.color)) {
      throw new Error(`${id}: color must be a six-digit hex color, such as #808080`);
    }
    if (agent.kind !== undefined && agent.kind !== 'shell') throw new Error(`${id}: kind may only be shell`);
    for (const field of ['resumeCommand', 'resumePickerCommand', 'resumeFailurePattern', 'chatPromptPattern', 'chatTitlePattern']) {
      if (agent[field] !== undefined && (typeof agent[field] !== 'string' || !agent[field].trim() || /[\x00-\x1f\x7f]/.test(agent[field]))) {
        throw new Error(`${id}: ${field} must be a nonempty single-line string`);
      }
    }
    for (const field of ['resumeFailurePattern', 'chatPromptPattern', 'chatTitlePattern']) {
      if (agent[field] !== undefined) {
        if (agent[field].length > 500) throw new Error(`${id}: ${field} exceeds 500 characters`);
        try { new RegExp(agent[field], field === 'resumeFailurePattern' ? 'i' : 'mu'); }
        catch (err) { throw new Error(`${id}: invalid ${field}: ${err.message}`); }
      }
    }
    if (agent.icon !== undefined && (!agent.icon || typeof agent.icon !== 'object' || Array.isArray(agent.icon)
      || typeof agent.icon.file !== 'string' || !/^agent-icons\/[a-z0-9-]+\.png$/.test(agent.icon.file)
      || typeof agent.icon.monochrome !== 'boolean')) throw new Error(`${id}: invalid bundled icon descriptor`);
    if (agent.conversationHistory !== undefined) {
      const history = agent.conversationHistory;
      if (!history || !['sqlite', 'transcript-jsonl'].includes(history.format)
        || typeof history.path !== 'string' || !history.path.trim()
        || (history.format === 'sqlite' && typeof history.query !== 'string')) {
        throw new Error(`${id}: conversationHistory requires a supported format, path and (for sqlite) query`);
      }
    }
    validateOptions(agent, id);
  }
  return configured;
}

function loadAgents() {
  const defaults = getDefaultAgents();
  try {
    fs.mkdirSync(HANGAR_DIR, { recursive: true });
    ensureHookScript();
    if (!fs.existsSync(AGENTS_FILE)) {
      fs.writeFileSync(AGENTS_FILE, JSON.stringify(defaults, null, 2) + '\n', { mode: 0o600 });
    }
    return mergeDefaults(parseConfiguration(fs.readFileSync(AGENTS_FILE, 'utf8')), defaults);
  } catch (err) {
    console.error('agents.json is invalid, using defaults:', err.message);
    return defaults;
  }
}

function revisionOf(json) {
  return crypto.createHash('sha256').update(json).digest('hex');
}

function getConfiguration() {
  // Also provisions a new installation. Never replace an invalid existing file.
  const effective = loadAgents();
  const json = fs.readFileSync(AGENTS_FILE, 'utf8');
  const result = { json, revision: revisionOf(json), agents: effective };
  try { parseConfiguration(json); }
  catch (err) { result.error = err.message; }
  return result;
}

function saveConfiguration(json, revision) {
  parseConfiguration(json);
  const current = fs.readFileSync(AGENTS_FILE, 'utf8');
  if (typeof revision !== 'string' || revisionOf(current) !== revision) {
    throw new Error('agents.json changed outside Settings. Reload the file before saving; copy your edits first.');
  }
  const tmp = `${AGENTS_FILE}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, json, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, AGENTS_FILE);
  } finally {
    try { fs.unlinkSync(tmp); } catch (err) { if (err.code !== 'ENOENT') console.error('Could not remove agent config temp file:', err.message); }
  }
  return getConfiguration();
}

module.exports = {
  loadAgents,
  parseConfiguration,
  mergeDefaults,
  getConfiguration,
  saveConfiguration,
  ensureHookScript,
  getHookToken,
  AGENTS_FILE,
  HOOK_FILE,
  HOOK_TOKEN_FILE,
};
