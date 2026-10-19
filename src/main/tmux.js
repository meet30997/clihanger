'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HANGAR_DIR = path.join(os.homedir(), '.hangar');
const CONF = path.join(HANGAR_DIR, 'tmux.conf');
const SOCKET = 'hangar';
const PREFIX = 'hangar_';

/**
 * A GUI app launched from Finder inherits none of the shell's PATH — macOS gives
 * it /usr/bin:/bin:/usr/sbin:/sbin, which is exactly where tmux is not. So we
 * search the usual install prefixes ourselves and spawn tmux by absolute path.
 */
const EXTRA_DIRS = [
  '/opt/homebrew/bin',      // Homebrew, Apple silicon
  '/usr/local/bin',         // Homebrew, Intel
  '/opt/local/bin',         // MacPorts
  '/run/current-system/sw/bin',
  path.join(os.homedir(), '.nix-profile', 'bin'),
];

function isExec(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function searchDirs() {
  const fromPath = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  return [...new Set([...fromPath, ...EXTRA_DIRS])];
}

let cachedBin = null;

/** Absolute path to tmux, or plain 'tmux' if we could not find one (so ENOENT still surfaces). */
function tmuxBin() {
  if (cachedBin) return cachedBin;
  for (const dir of searchDirs()) {
    const candidate = path.join(dir, 'tmux');
    if (isExec(candidate)) {
      cachedBin = candidate;
      return cachedBin;
    }
  }
  return 'tmux';
}

// tmux binds right-click in a pane to its own display-menu (Horizontal Split,
// Vertical Split, Swap, Kill, Zoom). That menu is drawn by tmux inside the pane,
// so the renderer's contextmenu handler cannot suppress it, and every entry in it
// acts on panes this app does not model. Right-click still reaches mouse-aware
// TUIs; otherwise it only focuses the pane. Status-line menus are unreachable
// with `status off`, so they are left alone.
const MOUSE_MENU_BINDINGS = `# Replace tmux's right-click pane menu with a plain pass-through
bind -T root MouseDown3Pane \\
  if-shell -F "#{||:#{mouse_any_flag},#{pane_in_mode}}" \\
    { send-keys -M } \\
    { select-pane -t = }
unbind -T root M-MouseDown3Pane

# Control-click is a right-click gesture on macOS, and tmux binds it to a
# "Kill pane?" menu — one stray click from destroying an agent session.
unbind -T root MouseDown1Control9

# Control-click also zooms and swaps panes. Same gesture, same reasoning.
unbind -T root MouseDown1Control8
unbind -T root C-MouseDown1Pane
unbind -T root C-MouseDown1Status
`;

// tmux is a transport here, not a UI. Anything it interprets on its own is a
// key or sequence the CLI inside never receives, and every agent CLI defines
// its own. These settings hand the terminal back to the program.
const PASSTHROUGH_SETTINGS = `# ---- Keep tmux out of the way of the program running inside ----

# No prefix key. C-b is "back one character" in readline and is bound by plenty
# of TUIs; tmux swallowing it is the single most visible way this stops feeling
# like Terminal.app. With no prefix, tmux's ~88 prefix bindings are unreachable,
# and they are removed as well so nothing can route into them.
set  -g  prefix None
set  -g  prefix2 None
unbind -a -T prefix

# Let modern key encodings reach the program. With extended-keys off, tmux drops
# the disambiguated forms — Shift-Enter, Ctrl-Enter, Alt-Enter — that agent CLIs
# use for multi-line input. Forward even when the program does not negotiate
# extended keys. tmux >= 3.5 can also preserve the CSI-u encoding.
set  -s  extended-keys on
if -F '#{>=:#{version},3.5}' {
  set -s extended-keys always
  set -s extended-keys-format csi-u
}
set  -as terminal-features 'xterm*:extkeys'

# Let programs emit sequences tmux does not itself understand (image protocols
# and other DCS-wrapped output) instead of having them eaten.
set  -g  allow-passthrough on

# Programs that redraw or pause on focus change need to be told about it.
set  -s  focus-events on

# Accept OSC 52 from the program so an in-CLI copy reaches the Mac pasteboard,
# not just a tmux buffer. "external" only forwards tmux's own copies.
set  -s  set-clipboard on
set  -as terminal-features 'xterm*:clipboard:hyperlinks'

# Do not second-guess fast input as a paste; the heuristic exists to protect
# key bindings, and there are no key bindings left to protect.
set  -g  assume-paste-time 0
`;

// Every default copy binding ends in `copy-pipe-and-cancel`, and leaving copy
// mode is what returns a pane to the live bottom. So the copy itself is fine but
// the cancel throws the view away: scroll up, select a line, and the pane snaps
// to the end. A mouse-aware CLI never showed it because its drags never reach
// copy mode at all.
//
// `scroll_position` is 0 exactly when the pane is already at the bottom, which is
// where cancelling moves nothing — keep the default there. Anywhere else use
// `copy-pipe`, which copies and clears the selection but stays put. Copy mode is
// entered with `-e` (below, and in the WheelUpPane binding), so scrolling back
// down still leaves it.
const COPY_KEEPS_SCROLL = `# Copy without losing the scroll position.
bind -T root MouseDrag1Pane \\
  if-shell -F "#{||:#{pane_in_mode},#{mouse_any_flag}}" \\
    { send-keys -M } \\
    { copy-mode -eM }

bind -T copy-mode MouseDragEnd1Pane \\
  if-shell -F "#{==:#{scroll_position},0}" \\
    { send-keys -X copy-pipe-and-cancel } \\
    { send-keys -X copy-pipe }
bind -T copy-mode-vi MouseDragEnd1Pane \\
  if-shell -F "#{==:#{scroll_position},0}" \\
    { send-keys -X copy-pipe-and-cancel } \\
    { send-keys -X copy-pipe }

# Double- and triple-click land in the copy-mode tables only when the pane is
# already in copy mode — i.e. exactly the scrolled-up case.
bind -T copy-mode DoubleClick1Pane select-pane \\; send-keys -X select-word \\; run-shell -d 0.3 \\; \\
  if-shell -F "#{==:#{scroll_position},0}" \\
    { send-keys -X copy-pipe-and-cancel } \\
    { send-keys -X copy-pipe }
bind -T copy-mode TripleClick1Pane select-pane \\; send-keys -X select-line \\; run-shell -d 0.3 \\; \\
  if-shell -F "#{==:#{scroll_position},0}" \\
    { send-keys -X copy-pipe-and-cancel } \\
    { send-keys -X copy-pipe }
bind -T copy-mode-vi DoubleClick1Pane select-pane \\; send-keys -X select-word \\; run-shell -d 0.3 \\; \\
  if-shell -F "#{==:#{scroll_position},0}" \\
    { send-keys -X copy-pipe-and-cancel } \\
    { send-keys -X copy-pipe }
bind -T copy-mode-vi TripleClick1Pane select-pane \\; send-keys -X select-line \\; run-shell -d 0.3 \\; \\
  if-shell -F "#{==:#{scroll_position},0}" \\
    { send-keys -X copy-pipe-and-cancel } \\
    { send-keys -X copy-pipe }
`;

// macOS paints text selection with live system colours. Main supplies those
// values at boot and when appearance preferences change; these
// defaults only cover the interval before the first native read.
let selectionBackground = '#3f638b';
let selectionForeground = '#ffffff';

function selectionStyle() {
  return `# Paint tmux copy-mode selections like a native macOS selection.
set  -g  mode-style 'fg=${selectionForeground},bg=${selectionBackground}'
`;
}

function tmuxConfTemplate() {
  return `# Hangar's private tmux server config.
# Only read when the server first starts.

set  -g  default-terminal "xterm-256color"
set  -ga terminal-overrides ",xterm-256color:Tc"

set  -g  mouse on
set  -g  history-limit 50000

# our app draws its own UI, so hide tmux's
set  -g  status off

# agent TUIs use escape sequences heavily; any delay causes input glitches
set  -sg escape-time 0

# resize to the newest attached client rather than the smallest
set  -g  window-size latest
setw -g  aggressive-resize on

# never auto-kill a session just because nobody is watching
set  -g  destroy-unattached off

# A completed mouse/keyboard selection is copied to the macOS pasteboard.
# tmux's default copy-mode bindings already call copy-pipe-and-cancel.
set  -s  copy-command '/usr/bin/pbcopy'

# Smooth single-line trackpad/wheel scrolling instead of default 5-line jumps
bind -T copy-mode WheelUpPane select-pane \\; send-keys -X -N 1 scroll-up
bind -T copy-mode WheelDownPane select-pane \\; send-keys -X -N 1 scroll-down
bind -T copy-mode-vi WheelUpPane select-pane \\; send-keys -X -N 1 scroll-up
bind -T copy-mode-vi WheelDownPane select-pane \\; send-keys -X -N 1 scroll-down

# Smooth alternate screen wheel scrolling (1 line instead of 5)
bind -T root WheelUpPane \\
  if-shell -F "#{||:#{pane_in_mode},#{mouse_any_flag}}" \\
    { send-keys -M } \\
    { if-shell -F "#{alternate_on}" { send-keys -N 1 Up } { copy-mode -e } }

bind -T root WheelDownPane \\
  if-shell -F "#{||:#{pane_in_mode},#{mouse_any_flag}}" \\
    { send-keys -M } \\
    { if-shell -F "#{alternate_on}" { send-keys -N 1 Down } { send-keys -M } }

${selectionStyle()}
${COPY_KEEPS_SCROLL}
${MOUSE_MENU_BINDINGS}
${PASSTHROUGH_SETTINGS}`;
}

function ensureTmuxConf() {
  try {
    fs.mkdirSync(HANGAR_DIR, { recursive: true });
    if (!fs.existsSync(CONF)) {
      fs.writeFileSync(CONF, tmuxConfTemplate(), 'utf8');
      return;
    }
    let current = fs.readFileSync(CONF, 'utf8');
    if (!current.includes('copy-command')) {
      fs.appendFileSync(CONF, `
# Copy completed tmux selections to the macOS pasteboard
set  -s  copy-command '/usr/bin/pbcopy'
`, 'utf8');
    }
    if (!current.includes('copy-mode WheelUpPane')) {
      const extraBindings = `
# Smooth single-line trackpad/wheel scrolling instead of default 5-line jumps
bind -T copy-mode WheelUpPane select-pane \\; send-keys -X -N 1 scroll-up
bind -T copy-mode WheelDownPane select-pane \\; send-keys -X -N 1 scroll-down
bind -T copy-mode-vi WheelUpPane select-pane \\; send-keys -X -N 1 scroll-up
bind -T copy-mode-vi WheelDownPane select-pane \\; send-keys -X -N 1 scroll-down

# Smooth alternate screen wheel scrolling (1 line instead of 5)
bind -T root WheelUpPane \\
  if-shell -F "#{||:#{pane_in_mode},#{mouse_any_flag}}" \\
    { send-keys -M } \\
    { if-shell -F "#{alternate_on}" { send-keys -N 1 Up } { copy-mode -e } }

bind -T root WheelDownPane \\
  if-shell -F "#{||:#{pane_in_mode},#{mouse_any_flag}}" \\
    { send-keys -M } \\
    { if-shell -F "#{alternate_on}" { send-keys -N 1 Down } { send-keys -M } }
`;
      fs.appendFileSync(CONF, extraBindings, 'utf8');
    }
    if (!current.includes('MouseDown3Pane')) {
      fs.appendFileSync(CONF, `\n${MOUSE_MENU_BINDINGS}`, 'utf8');
    }
    if (!current.includes('prefix None')) {
      fs.appendFileSync(CONF, `\n${PASSTHROUGH_SETTINGS}`, 'utf8');
    }
    const desiredModeStyle = `set  -g  mode-style 'fg=${selectionForeground},bg=${selectionBackground}'`;
    const modeStylePattern = /^set\s+-g\s+mode-style\s+.*$/m;
    if (!modeStylePattern.test(current)) {
      fs.appendFileSync(CONF, `\n${selectionStyle()}`, 'utf8');
    } else {
      const updated = current.replace(modeStylePattern, desiredModeStyle);
      if (updated !== current) {
        fs.writeFileSync(CONF, updated, 'utf8');
        current = updated;
      }
    }
    if (!current.includes('MouseDragEnd1Pane')) {
      fs.appendFileSync(CONF, `\n${COPY_KEEPS_SCROLL}`, 'utf8');
    }
    if (!current.includes('extended-keys-format csi-u')) {
      fs.appendFileSync(CONF, `
# Preserve modified Enter for programs that do not negotiate extended keys.
if -F '#{>=:#{version},3.5}' {
  set -s extended-keys always
  set -s extended-keys-format csi-u
}
`, 'utf8');
    }
  } catch (err) {
    console.error('Failed to ensure tmux.conf:', err.message);
  }
}

function configureSelectionStyle(background, foreground) {
  if (!/^#[0-9a-f]{6}$/i.test(background) || !/^#[0-9a-f]{6}$/i.test(foreground)) {
    throw new TypeError('Selection colours must be #rrggbb');
  }
  selectionBackground = background.toLowerCase();
  selectionForeground = foreground.toLowerCase();
  ensureTmuxConf();
}

async function applySelectionStyle(background, foreground) {
  configureSelectionStyle(background, foreground);
  await tmux(['set-option', '-g', 'mode-style', `fg=${selectionForeground},bg=${selectionBackground}`]);
}

/**
 * process.env with the extra prefixes appended to PATH, so anything tmux starts
 * (the login shell, the agent CLI) can find its own tools too.
 */
function tmuxEnv(extra = {}) {
  const dirs = searchDirs().filter((d) => fs.existsSync(d));
  const env = { ...process.env, PATH: dirs.join(path.delimiter), ...extra };

  // A GUI launch strips the locale the same way it strips PATH: an app started
  // from Finder gets no LANG, so `locale charmap` inside the pane is US-ASCII
  // and every CLI that draws with symbols falls back to ASCII or question
  // marks. Only the character set is being fixed here — a user whose own
  // environment sets LANG, LC_ALL or LC_CTYPE keeps it untouched.
  if (!env.LC_ALL && !env.LC_CTYPE && !env.LANG) env.LANG = 'en_US.UTF-8';

  return env;
}

/**
 * Run a tmux command on our private socket.
 * Every tmux call in the entire app goes through here.
 */
function tmux(args) {
  ensureTmuxConf();
  return new Promise((resolve, reject) => {
    execFile(
      tmuxBin(),
      ['-L', SOCKET, '-f', CONF, ...args],
      { env: tmuxEnv(), maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || '').trim() || err.message;
          const e = new Error(msg);
          e.code = err.code;
          e.noTmux = err.code === 'ENOENT' || /spawn tmux ENOENT/i.test(msg);
          e.noServer = !e.noTmux && /no server running|error connecting|no such file/i.test(msg);
          return reject(e);
        }
        resolve(stdout);
      }
    );
  });
}

/** tmux forbids '.' and ':' in session names. Be strict. */
function slugify(text) {
  return String(text).replace(/[^A-Za-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 40);
}

/** Build a session name that isn't taken yet. */
async function uniqueName(projectPath, agentId) {
  const slug = slugify(path.basename(projectPath));
  const existing = new Set((await listSessions()).map((s) => s.name));
  for (let n = 1; n < 1000; n++) {
    const candidate = `${PREFIX}${slug}_${slugify(agentId)}_${n}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error('Could not allocate a session name');
}

/**
 * Create a detached session, then type the agent command into it.
 *
 * We deliberately do NOT pass the command to new-session. If we did, the
 * session would die the moment the agent exits. Starting a shell and then
 * send-keys means you're dropped back to a prompt instead, which is far
 * easier to debug.
 */
async function createSession({ projectPath, agentId, command, env = {}, capturePath = null }) {
  const name = await uniqueName(projectPath, agentId);

  const args = [
    'new-session', '-d',
    '-s', name,
    '-c', projectPath,
    '-x', '200', '-y', '50',   // sane default until a client attaches
  ];
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);

  await tmux(args);

  if (command) {
    // small delay so the shell is ready to receive input
    await new Promise((r) => setTimeout(r, 250));
    try {
      if (capturePath) {
        const quotedPath = `'${String(capturePath).replace(/'/g, `'\\''`)}'`;
        await tmux(['pipe-pane', '-O', '-t', `=${name}:`, `/bin/cat > ${quotedPath}`]);
      }
      await tmux(['send-keys', '-l', '-t', `=${name}:`, command]);
      await tmux(['send-keys', '-t', `=${name}:`, 'Enter']);
    } catch (err) {
      await killSession(name);
      if (capturePath) {
        try { fs.unlinkSync(capturePath); } catch (unlinkErr) {
          if (unlinkErr.code !== 'ENOENT') console.error('Failed to remove pane capture:', unlinkErr.message);
        }
      }
      throw err;
    }
  }
  return name;
}

/** Stop a temporary raw-output capture started by createSession(). */
async function stopPaneCapture(name) {
  try {
    await tmux(['pipe-pane', '-t', `=${name}:`]);
  } catch (e) {
    if (!e.noServer) throw e;
  }
}

/** Foreground command currently owning the pane, or null if the pane is gone. */
async function paneCurrentCommand(name) {
  try {
    const out = await tmux(['display-message', '-p', '-t', `=${name}:`, '#{pane_current_command}']);
    return out.trim() || null;
  } catch (e) {
    if (e.noServer || /can't find|no such/i.test(e.message)) return null;
    throw e;
  }
}

/** Bounded plain transcript for local conversation-title discovery. */
async function captureChatOutput(name) {
  return tmux(['capture-pane', '-p', '-J', '-t', `=${name}:`, '-S', '-2000']);
}

/**
 * Field separator for `-F` formats.
 *
 * NOT a tab. tmux rewrites non-printable characters in format output to `_`
 * (verified on 3.7b: both TAB and US come back as `_`), which silently welds
 * every field into one string — a session name parses as `name_created_attached`,
 * every downstream number becomes NaN, and nothing matches tmux again. `|` passes
 * through untouched and cannot occur in a session name, which `slugify` restricts
 * to [A-Za-z0-9-].
 */
const FS = '|';

/** All Hangar sessions currently on the socket. */
async function listSessions() {
  const FMT = ['#{session_name}', '#{session_created}', '#{session_attached}'].join(FS);
  let out;
  try {
    out = await tmux(['list-sessions', '-F', FMT]);
  } catch (e) {
    if (e.noServer) return [];   // no server yet is normal, not an error
    throw e;
  }
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, created, attached] = line.split(FS);
      return {
        name,
        createdAt: Number(created) * 1000,
        attached: attached !== '0',
      };
    })
    .filter((s) => s.name.startsWith(PREFIX));
}

/** Pane PID + foreground command for each session. Needed for port attribution. */
async function listPanes() {
  const FMT = ['#{session_name}', '#{pane_pid}', '#{pane_current_command}'].join(FS);
  let out;
  try {
    out = await tmux(['list-panes', '-a', '-F', FMT]);
  } catch (e) {
    if (e.noServer) return [];
    throw e;
  }
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      // command is free text and goes last, so rejoin anything it split on
      const [name, pid, ...rest] = line.split(FS);
      return { name, pid: Number(pid), command: rest.join(FS) };
    })
    .filter((p) => p.name.startsWith(PREFIX));
}

async function hasSession(name) {
  try {
    await tmux(['has-session', '-t', `=${name}`]);
    return true;
  } catch {
    return false;
  }
}

async function killSession(name) {
  try {
    await tmux(['kill-session', '-t', `=${name}`]);
  } catch (e) {
    if (!e.noServer) throw e;
  }
}

/** Destroy the private server and every session on it during app shutdown. */
async function killServer() {
  try {
    await tmux(['kill-server']);
  } catch (e) {
    if (!e.noServer) throw e;
  }
}

/** Read the visible screen as text. `lines` = how far back to go. */
async function capturePane(name, lines = 40, strict = false) {
  try {
    return await tmux(['capture-pane', '-p', '-t', `=${name}:`, '-S', `-${lines}`]);
  } catch (err) {
    if (strict) throw err;
    return '';
  }
}

/** Capture full scrollback history from the beginning. */
async function captureFullScrollback(name, strict = false) {
  try {
    return await tmux(['capture-pane', '-p', '-t', `=${name}:`, '-S', '-']);
  } catch (err) {
    if (strict) throw err;
    return '';
  }
}

/** Clear both the visible terminal presentation and tmux's retained history. */
async function clearPane(name) {
  const target = `=${name}:`;
  // `send-keys -R` resets the attached terminal without typing into the
  // foreground program. Clearing history afterwards removes everything that
  // could otherwise reappear on the next wheel gesture.
  await tmux(['send-keys', '-R', '-t', target]);
  await tmux(['clear-history', '-t', target]);
}

/** Authoritative copy-mode state for the terminal scroll indicator. */
async function paneScrollState(name) {
  const out = await tmux([
    'display-message', '-p', '-t', `=${name}:`,
    '#{pane_in_mode}|#{scroll_position}',
  ]);
  const [inMode, rawPosition] = out.trim().split('|');
  const scrollPosition = Number(rawPosition);
  return {
    inCopyMode: inMode === '1',
    scrollPosition: Number.isFinite(scrollPosition) ? Math.max(0, scrollPosition) : 0,
  };
}

/** Leave tmux copy mode without sending a character to the foreground program. */
async function scrollPaneToBottom(name) {
  const before = await paneScrollState(name);
  if (before.inCopyMode) {
    await tmux(['send-keys', '-X', '-t', `=${name}:`, 'cancel']);
  }
  return paneScrollState(name);
}

/**
 * Search the complete tmux history and move copy mode to the requested match.
 * `direction` is start, next (same direction), or previous (reverse direction).
 */
async function searchPane(name, query, direction = 'start') {
  const text = String(query || '').trim();
  if (!text || text.length > 500) {
    return { matchCount: 0, ...(await paneScrollState(name)) };
  }

  const history = await captureFullScrollback(name, true);
  let matchCount = 0;
  for (const line of history.split('\n')) {
    let from = 0;
    while (from <= line.length) {
      const index = line.indexOf(text, from);
      if (index === -1) break;
      matchCount++;
      from = index + text.length;
    }
  }

  if (matchCount > 0) {
    const target = `=${name}:`;
    if (direction === 'start') {
      await tmux(['copy-mode', '-e', '-t', target]);
      await tmux(['send-keys', '-X', '-t', target, 'search-backward-text', text]);
    } else {
      await tmux([
        'send-keys', '-X', '-t', target,
        direction === 'previous' ? 'search-reverse' : 'search-again',
      ]);
    }
  }

  return { matchCount, ...(await paneScrollState(name)) };
}

async function sendKeys(name, text, enter = true) {
  const args = ['send-keys', '-t', `=${name}:`, text];
  if (enter) args.push('Enter');
  await tmux(args);
}

/** Arguments for spawning an attached client. Used by node-pty in Phase 3. */
function attachArgs(name) {
  // Existing servers have already read tmux.conf. Apply the key transport
  // settings before attaching too, without restarting any running sessions.
  return [
    '-L', SOCKET, '-f', CONF,
    'if-shell', '-F', '#{>=:#{version},3.5}',
    'set-option -s extended-keys always ; set-option -s extended-keys-format csi-u',
    ';', 'attach-session', '-t', `=${name}`,
  ];
}

module.exports = {
  SOCKET, PREFIX, HANGAR_DIR, CONF,
  tmux, tmuxBin, tmuxEnv, slugify, createSession, listSessions, listPanes,
  hasSession, killSession, killServer, capturePane, captureFullScrollback, sendKeys, attachArgs,
  stopPaneCapture, paneCurrentCommand, captureChatOutput,
  clearPane, paneScrollState, scrollPaneToBottom, searchPane,
  ensureTmuxConf, configureSelectionStyle, applySelectionStyle,
};
