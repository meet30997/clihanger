'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HANGAR_DIR } = require('./tmux');

const STATE_FILE = path.join(HANGAR_DIR, 'state.json');
const EMPTY = { version: 1, projects: [], sessions: [], lastActiveSessionId: null };

function id(prefix) {
  return prefix + '_' + crypto.randomBytes(3).toString('hex');
}

function load() {
  try {
    fs.mkdirSync(HANGAR_DIR, { recursive: true });
    if (!fs.existsSync(STATE_FILE)) return { ...EMPTY };
    return { ...EMPTY, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
  } catch (err) {
    console.error('state.json unreadable, preserving backup and starting fresh:', err.message);
    try {
      if (fs.existsSync(STATE_FILE)) {
        const corruptPath = `${STATE_FILE}.corrupt-${Date.now()}`;
        fs.renameSync(STATE_FILE, corruptPath);
        console.error(`Moved corrupt state.json to ${corruptPath}`);
      }
    } catch (renameErr) {
      console.error('Failed to rename corrupt state.json:', renameErr.message);
    }
    return { ...EMPTY };
  }
}

function save(state) {
  fs.mkdirSync(HANGAR_DIR, { recursive: true });
  // write to a temp file then rename, so a crash mid-write can't corrupt state
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
  return state;
}

module.exports = { load, save, id, STATE_FILE };
