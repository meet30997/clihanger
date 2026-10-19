'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HANGAR_DIR } = require('./tmux');

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

function loadAgents() {
  const defaults = getDefaultAgents();
  try {
    fs.mkdirSync(HANGAR_DIR, { recursive: true });
    ensureHookScript();
    if (!fs.existsSync(AGENTS_FILE)) {
      fs.writeFileSync(AGENTS_FILE, JSON.stringify(defaults, null, 2));
      return defaults;
    }
    const configured = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8'));
    // Built-in shell launchers are app capabilities, not agent preferences. Merge
    // them into existing user configs without re-adding any removed agent CLI.
    const shellLaunchers = Object.fromEntries(
      Object.entries(defaults).filter(([, entry]) => entry.kind === 'shell')
    );
    for (const [id, def] of Object.entries(defaults)) {
      if (configured[id] && configured[id].command === def.command) {
        for (const field of ['icon', 'chatPromptPattern', 'chatTitlePattern', 'conversationHistory']) {
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
  } catch (err) {
    console.error('agents.json is invalid, using defaults:', err.message);
    return defaults;
  }
}

module.exports = {
  loadAgents,
  ensureHookScript,
  getHookToken,
  AGENTS_FILE,
  HOOK_FILE,
  HOOK_TOKEN_FILE,
};
