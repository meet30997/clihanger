'use strict';

const {
  app, BrowserWindow, ipcMain, dialog, Notification, Menu, shell, Tray, nativeImage,
  nativeTheme, systemPreferences,
} = require('electron');
const path = require('path');
const os = require('os');
const http = require('http');
const sessions = require('./sessions');
const ptyman = require('./ptyman');
const store = require('./store');
const ports = require('./ports');
const status = require('./status');
const agents = require('./agents');
const tmux = require('./tmux');
const presets = require('./presets');
const chatTitles = require('./chat-titles');
const {
  validateInvokeRequest,
  validateInvokeResponse,
  validateEvent,
} = require('./ipc-contract');
const { FALLBACK: FALLBACK_APPEARANCE, observeAppearance } = require('./appearance');

let win = null;
let hookServer = null;
let tray = null;
let hasTmux = true;
let quitCleanupStarted = false;
let quitPromptVisible = false;
let quitConfirmed = false;
let quitCleanupComplete = false;
let currentAppearance = { ...FALLBACK_APPEARANCE };
let appearanceObserver = null;

app.setName('CliHanger');

function createTray() {
  if (tray) return;

  // The sidebar's brand mark doubles as the menu-bar glyph. A template image is
  // drawn from its alpha alone, so the white artwork follows the menu bar's
  // light/dark tint. 18pt is the standard menu-bar icon height.
  const mark = nativeImage.createFromPath(path.join(__dirname, '..', 'renderer', 'brand-mark.png'));
  const icon = nativeImage.createEmpty();
  for (const scaleFactor of [1, 2]) {
    const size = 18 * scaleFactor;
    icon.addRepresentation({
      scaleFactor,
      buffer: mark.resize({ width: size, height: size, quality: 'best' }).toPNG(),
    });
  }
  icon.setTemplateImage(true);

  tray = new Tray(icon);
  tray.setToolTip('CliHanger — CLI Session Workspace');
  updateTray();
}

/** Same set and order as the renderer's "Waiting for you": oldest first, then sidebar order. */
function getWaitingSessions() {
  const state = store.load();
  const projectOrder = new Map(state.projects.map((p, i) => [p.id, i]));
  const rank = (s) => projectOrder.has(s.projectId) ? projectOrder.get(s.projectId) : state.projects.length;
  return state.sessions
    .filter((s) => !s.pending && s.tmuxName && status.isWaiting(status.getDetails(s.id)))
    .map((s, index) => ({ s, index, since: status.getDetails(s.id).waitingSince || 0 }))
    .sort((a, b) => a.since - b.since || rank(a.s) - rank(b.s) || a.index - b.index)
    .map(({ s }) => s);
}

function updateTray() {
  if (!tray) return;
  const state = store.load();
  const waiting = getWaitingSessions();

  if (waiting.length > 0) {
    tray.setTitle(` ${waiting.length}`);
  } else {
    tray.setTitle('');
  }

  const loadedAgents = agents.loadAgents();
  const menuItems = [
    {
      label: 'Show CliHanger',
      click: () => {
        if (!win || win.isDestroyed()) createWindow();
        else { win.show(); win.focus(); }
      },
    },
    { type: 'separator' },
  ];

  if (waiting.length > 0) {
    menuItems.push({ label: 'Needs Attention:', enabled: false });
    for (const s of waiting) {
      const proj = state.projects.find((p) => p.id === s.projectId);
      const agent = loadedAgents[s.agentId];
      const title = s.title || s.autoTitle || agent?.label || s.agentId;
      menuItems.push({
        label: `  🟡 ${title} (${proj?.name ?? 'unassigned'})`,
        click: () => {
          if (!win || win.isDestroyed()) createWindow();
          else { win.show(); win.focus(); }
          // `focusSession` is the only thing that moves the renderer's
          // selection, and only a deliberate act like this menu click sets it.
          broadcast('state:changed', { ...getStateWithTmux(), focusSession: s.id });
        },
      });
    }
    menuItems.push({ type: 'separator' });
  } else {
    menuItems.push({ label: 'No agents waiting', enabled: false });
    menuItems.push({ type: 'separator' });
  }

  menuItems.push(
    {
      label: 'Open Config Folder',
      click: () => shell.openPath(path.join(os.homedir(), '.hangar')),
    },
    { type: 'separator' },
    { role: 'quit', label: 'Quit CliHanger' }
  );

  tray.setContextMenu(Menu.buildFromTemplate(menuItems));
}

function handleStatusChange({ sessionId, status: s, prev, waitingSince, snoozed, promptKind, seen, stale, reason, tailExcerpt }) {
  // 'gone' is internal only and must not be broadcast to renderer
  if (!status.VALID_STATUSES.has(s)) return;

  broadcast('status:changed', { sessionId, status: s, waitingSince, snoozed, promptKind, seen, stale, reason, tailExcerpt });

  const waiting = getWaitingSessions().length;
  if (app.dock) app.dock.setBadge(waiting ? String(waiting) : '');
  updateTray();

  // only notify on meaningful transitions, and never on first classification
  if (!prev || prev === s) return;
  if (snoozed || seen) return;

  const state = store.load();
  const session = state.sessions.find((x) => x.id === sessionId);
  if (!session) return;

  const project = state.projects.find((p) => p.id === session.projectId);
  const agent = agents.loadAgents()[session.agentId];
  const where = `${agent?.label ?? session.agentId} · ${project?.name ?? 'unassigned'}`;

  // don't notify about the session you're already looking at
  if (state.lastActiveSessionId === sessionId && win?.isFocused()) return;

  if (s === 'needs_input') {
    new Notification({ title: 'Agent needs input', body: where }).show();
  } else if (s === 'idle' && prev === 'working') {
    // Idle only means the screen stopped changing without a prompt; it is not
    // evidence that the agent completed anything.
    new Notification({ title: 'Agent output stopped', body: `${where} · no prompt detected` }).show();
  }
}

async function handleGoneSession() {
  try {
    await sessions.reconcile();
    broadcast('state:changed', getStateWithTmux());
  } catch {}
}

function startHookServer() {
  if (hookServer) return;
  hookServer = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }

    const expectedToken = agents.getHookToken();
    if (expectedToken) {
      const auth = req.headers['authorization'];
      if (!auth || auth !== `Bearer ${expectedToken}`) {
        res.writeHead(401).end();
        return;
      }
    }

    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { session, event } = JSON.parse(body || '{}');
        if (session && event && status.VALID_STATUSES.has(event)) {
          status.setStatus(session, event, handleStatusChange);
          res.writeHead(204).end();
        } else {
          res.writeHead(400).end();
        }
      } catch {
        res.writeHead(400).end();
      }
    });
  });

  hookServer.on('error', (err) => {
    console.error('Hook server error:', err.message);
  });
  hookServer.listen(47823, '127.0.0.1');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hidden',
    // Center native controls in the 52px toolbar.
    trafficLightPosition: { x: 20, y: 20 },
    backgroundColor: currentAppearance.effectiveAppearance === 'light' ? '#ffffff' : '#181818',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,   // required so preload can use require()
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // Keep the window available for Cancel / Show Waiting during a close request.
  win.on('close', (event) => {
    if (quitCleanupComplete) return;
    event.preventDefault();
    app.quit();
  });
  win.webContents.on('did-finish-load', syncOptionMetaMenu);
  win.on('focus', syncViewer);
  win.on('blur', syncViewer);
  win.on('hide', syncViewer);
  win.on('closed', syncViewer);

  // Wire fullscreen body class for traffic-light clearance (D1)
  win.on('enter-full-screen', () => {
    win?.webContents.executeJavaScript("document.body.classList.add('fullscreen')").catch(() => {});
  });
  win.on('leave-full-screen', () => {
    win?.webContents.executeJavaScript("document.body.classList.remove('fullscreen')").catch(() => {});
  });
}

// The session whose terminal the renderer shows; it counts as seen only while
// the window is focused.
let viewingSessionId = null;
function syncViewer() {
  const focused = win && !win.isDestroyed() && win.isFocused() && win.isVisible();
  status.setViewer(focused ? viewingSessionId : null, handleStatusChange);
}

function broadcast(channel, payload) {
  validateEvent(channel, payload);
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function handleChecked(channel, handler) {
  ipcMain.handle(channel, async (event, payload) => {
    validateInvokeRequest(channel, payload);
    const result = await handler(event, payload);
    validateInvokeResponse(channel, result);
    return result;
  });
}

function getStateWithTmux(source = sessions.fullState()) {
  const full = { ...source, appearance: currentAppearance };
  if (!hasTmux) full.noTmux = true;
  // VoiceOver or another assistive technology is running (ADR-073).
  if (app.accessibilitySupportEnabled) full.screenReader = true;
  return full;
}

function updateAppearance(next, shouldBroadcast) {
  currentAppearance = next;
  if (win && !win.isDestroyed()) {
    win.setBackgroundColor(next.effectiveAppearance === 'light' ? '#ffffff' : '#181818');
  }
  try {
    tmux.configureSelectionStyle(next.selectionBackground, next.selectionForeground);
    const hasLiveSession = store.load().sessions.some((session) => !session.pending && session.tmuxName);
    if (hasLiveSession) {
      tmux.applySelectionStyle(next.selectionBackground, next.selectionForeground)
        .catch((err) => console.error('Failed to update live tmux selection colours:', err.message));
    }
  } catch (err) {
    console.error('Failed to configure selection colours:', err.message);
  }
  if (shouldBroadcast && !quitCleanupStarted) {
    broadcast('state:changed', getStateWithTmux());
  }
}

async function syncOptionMetaMenu() {
  if (!win || win.isDestroyed()) return;
  try {
    const checked = await win.webContents.executeJavaScript(
      "localStorage.getItem('hangar:mac-option-is-meta') === 'true'"
    );
    const item = Menu.getApplicationMenu()?.getMenuItemById('terminal-option-meta');
    if (item) item.checked = !!checked;
  } catch {}
}

function buildMenu() {
  const template = [
    {
      label: 'CliHanger',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'New Session',
          accelerator: 'CmdOrCtrl+Shift+N',
          registerAccelerator: false,
          click: () => {
            if (win && !win.isDestroyed()) {
              win.webContents.executeJavaScript('window.dispatchEvent(new CustomEvent("hangar:new-session"))').catch(() => {});
            }
          },
        },
        {
          label: 'Add Project…',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            if (!win || win.isDestroyed()) createWindow();
            const res = await dialog.showOpenDialog(win, {
              title: 'Choose a project folder',
              properties: ['openDirectory', 'createDirectory'],
            });
            if (res.canceled || !res.filePaths[0]) return;
            sessions.addProject(res.filePaths[0]);
            broadcast('state:changed', getStateWithTmux());
          },
        },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Sidebar',
          accelerator: 'CmdOrCtrl+B',
          registerAccelerator: false,
          click: () => {
            if (win && !win.isDestroyed()) {
              win.webContents.executeJavaScript('window.dispatchEvent(new CustomEvent("hangar:toggle-sidebar"))').catch(() => {});
            }
          },
        },
        { type: 'separator' },
        {
          label: 'Make Text Bigger',
          accelerator: 'CmdOrCtrl+Plus',
          registerAccelerator: false,
          click: () => {
            if (win && !win.isDestroyed()) {
              win.webContents.executeJavaScript('window.dispatchEvent(new CustomEvent("hangar:zoom-in"))').catch(() => {});
            }
          },
        },
        {
          label: 'Make Text Smaller',
          accelerator: 'CmdOrCtrl+-',
          registerAccelerator: false,
          click: () => {
            if (win && !win.isDestroyed()) {
              win.webContents.executeJavaScript('window.dispatchEvent(new CustomEvent("hangar:zoom-out"))').catch(() => {});
            }
          },
        },
        {
          label: 'Actual Size',
          accelerator: 'CmdOrCtrl+0',
          registerAccelerator: false,
          click: () => {
            if (win && !win.isDestroyed()) {
              win.webContents.executeJavaScript('window.dispatchEvent(new CustomEvent("hangar:zoom-reset"))').catch(() => {});
            }
          },
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Terminal',
      submenu: [
        {
          label: 'Clear Screen',
          accelerator: 'CmdOrCtrl+K',
          registerAccelerator: false,
          click: () => {
            if (win && !win.isDestroyed()) {
              win.webContents.executeJavaScript('window.dispatchEvent(new CustomEvent("hangar:clear-terminal"))').catch(() => {});
            }
          },
        },
        {
          label: 'Find…',
          accelerator: 'CmdOrCtrl+F',
          registerAccelerator: false,
          click: () => {
            if (win && !win.isDestroyed()) {
              win.webContents.executeJavaScript('window.dispatchEvent(new CustomEvent("hangar:find-terminal"))').catch(() => {});
            }
          },
        },
        { type: 'separator' },
        {
          id: 'terminal-option-meta',
          label: 'Use Option as Meta Key',
          type: 'checkbox',
          checked: false,
          click: (menuItem) => {
            if (win && !win.isDestroyed()) {
              win.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent("hangar:set-option-meta", { detail: ${menuItem.checked} }))`).catch(() => {});
            }
          },
        },
      ],
    },
    {
      label: 'Go',
      submenu: [
        {
          label: 'Quick Switcher',
          accelerator: 'CmdOrCtrl+P',
          registerAccelerator: false,
          click: () => {
            if (win && !win.isDestroyed()) {
              win.webContents.executeJavaScript('window.dispatchEvent(new CustomEvent("hangar:quick-switcher"))').catch(() => {});
            }
          },
        },
        {
          label: 'Next Waiting Session',
          accelerator: 'CmdOrCtrl+Shift+J',
          registerAccelerator: false,
          click: () => {
            if (win && !win.isDestroyed()) {
              win.webContents.executeJavaScript('window.dispatchEvent(new CustomEvent("hangar:next-waiting"))').catch(() => {});
            }
          },
        },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'Open Config Folder',
          click: () => shell.openPath(path.join(os.homedir(), '.hangar')),
        },
        {
          label: 'Restart tmux Server',
          click: async () => {
            const t = require('./tmux');
            try { await t.tmux(['kill-server']); } catch {}
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  syncOptionMetaMenu();
}

// xterm's screen-reader mode follows assistive technology, so tell the renderer.
app.on('accessibility-support-changed', () => broadcast('state:changed', getStateWithTmux()));

app.whenReady().then(async () => {
  // Follow macOS; this also drives prefers-color-scheme in the renderer.
  nativeTheme.themeSource = 'system';
  appearanceObserver = observeAppearance({
    systemPreferences,
    nativeTheme,
    onChange: (next) => updateAppearance(next, true),
  });
  updateAppearance(appearanceObserver.current(), false);
  createWindow();
  buildMenu();
  createTray();

  try {
    await sessions.reconcile();
    hasTmux = true;
  } catch (err) {
    if (err.noTmux) hasTmux = false;
    console.error('Initial session reconciliation error:', err.message);
  }

  status.start(handleStatusChange, handleGoneSession);
  chatTitles.start(() => {
    broadcast('state:changed', getStateWithTmux());
    updateTray();
  });
  startHookServer();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Closing the last window means closing CliHanger. The guarded quit path below
// destroys the private tmux server before Electron exits.
app.on('window-all-closed', () => {
  app.quit();
});

async function confirmQuitWithRunningSessions() {
  if (quitPromptVisible) return;
  const running = store.load().sessions.filter((session) => !session.pending && session.tmuxName);
  if (!running.length || !win || win.isDestroyed()) { quitConfirmed = true; app.quit(); return; }
  quitPromptVisible = true;
  const waiting = getWaitingSessions();
  const working = running.filter((session) => status.getDetails(session.id)?.status === 'working');
  const buttons = ['Cancel', 'Quit and Stop All'];
  if (waiting.length) buttons.push('Show Waiting');
  try {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning', title: 'Quit CliHanger',
      message: `Quit CliHanger and stop ${running.length} session${running.length === 1 ? '' : 's'}?`,
      detail: `${waiting.length} waiting for you · ${working.length} working\n\nEvery terminal and agent started from CliHanger will stop. Titles, notes, and linked conversations are kept so you can resume them later. Session child processes may stop too.\n\nTo keep them running, hide CliHanger instead (⌘H).`,
      buttons, defaultId: 0, cancelId: 0, noLink: true,
    });
    if (response === 1) { quitConfirmed = true; app.quit(); }
    else if (response === 2) {
      win?.show(); win?.focus();
      win?.webContents.executeJavaScript('window.dispatchEvent(new CustomEvent("hangar:next-waiting"))').catch(() => {});
    }
  } catch (err) { console.error('Could not show quit confirmation:', err.message); }
  finally { quitPromptVisible = false; }
}

app.on('before-quit', (event) => {
  if (quitCleanupComplete) return;
  event.preventDefault();
  if (quitCleanupStarted) return;
  if (!quitConfirmed) { confirmQuitWithRunningSessions(); return; }
  quitCleanupStarted = true;

  status.stop();
  chatTitles.stop();
  appearanceObserver?.stop();
  appearanceObserver = null;
  // Park the open sessions before the tmux server is destroyed, or there is
  // nothing left to list them from on the next launch.
  try {
    sessions.parkSessions();
  } catch (err) {
    console.error('Failed to record open sessions for the next launch:', err.message);
  }
  if (hookServer) {
    try { hookServer.close(); } catch {}
  }
  ptyman.closeAll();

  tmux.killServer()
    .catch((err) => console.error('Failed to kill CliHanger sessions during quit:', err.message))
    .finally(() => {
      quitCleanupComplete = true;
      app.quit();
    });
});

/* ---------------- IPC ---------------- */

handleChecked('state:get', async () => {
  try {
    await sessions.reconcile();
    hasTmux = true;
  } catch (err) {
    if (err.noTmux) hasTmux = false;
    console.error('state:get reconciliation error:', err.message);
  }
  await chatTitles.backfillHistory();
  return getStateWithTmux();
});

handleChecked('session:history', async (_e, { sessionId }) => chatTitles.listHistory(sessionId));
handleChecked('session:link-history', async (_e, { sessionId, conversationId }) => {
  await chatTitles.linkHistory(sessionId, conversationId);
  const state = getStateWithTmux();
  broadcast('state:changed', state);
  return state;
});

handleChecked('project:add', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose a project folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths[0]) return getStateWithTmux();
  sessions.addProject(res.filePaths[0]);
  const state = getStateWithTmux();
  broadcast('state:changed', state);
  return state;
});

handleChecked('project:remove', async (_e, { projectId }) => {
  sessions.removeProject(projectId);
  const state = getStateWithTmux();
  broadcast('state:changed', state);
  return state;
});

handleChecked('project:move', async (_e, { projectId, beforeProjectId }) => {
  const state = getStateWithTmux(sessions.moveProject(projectId, beforeProjectId));
  broadcast('state:changed', state);
  return state;
});

handleChecked('session:move', async (_e, { sessionId, beforeSessionId }) => {
  const state = getStateWithTmux(sessions.moveSession(sessionId, beforeSessionId));
  broadcast('state:changed', state);
  return state;
});

handleChecked('session:create', async (_e, { projectId, agentId, branch }) => {
  await sessions.createSession({ projectId, agentId, branch });
  const state = getStateWithTmux();
  broadcast('state:changed', state);
  return state;
});

handleChecked('session:rename', async (_e, { sessionId, title }) => {
  const state = getStateWithTmux(sessions.renameSession(sessionId, title));
  broadcast('state:changed', state);
  return state;
});

handleChecked('session:note', async (_e, { sessionId, note }) => {
  const state = getStateWithTmux(sessions.setSessionNote(sessionId, note));
  broadcast('state:changed', state);
  return state;
});

handleChecked('session:conversation', async (_e, { sessionId, conversationId }) => {
  const state = getStateWithTmux(sessions.setSessionConversation(sessionId, conversationId));
  broadcast('state:changed', state);
  return state;
});

handleChecked('status:snooze', async (_e, { sessionId, snoozed }) => {
  const ok = status.snooze(sessionId, snoozed, handleStatusChange);
  const waiting = getWaitingSessions().length;
  if (app.dock) app.dock.setBadge(waiting ? String(waiting) : '');
  updateTray();
  return { ok, snoozed: !!snoozed };
});

handleChecked('status:details', async (_e, { sessionId }) => {
  return status.getDetails(sessionId);
});

handleChecked('session:search', async (_e, { query }) => {
  return sessions.searchScrollback(query);
});

handleChecked('session:handoff', async (_e, { sessionId, lines }) => {
  return sessions.getHandoffData(sessionId, { lines });
});

handleChecked('session:kill', async (_e, { sessionId }) => {
  const state = getStateWithTmux(await sessions.killSession(sessionId));
  broadcast('state:changed', state);
  return state;
});

/* ---------------- Presets IPC (F3) ---------------- */

handleChecked('preset:list', async (_e, { projectId }) => {
  const state = store.load();
  const project = state.projects.find((p) => p.id === projectId);
  if (!project) return { presets: {}, source: null, error: 'Project not found' };
  return presets.loadProjectPresets(project.path, project.name);
});

handleChecked('preset:preview', async (_e, { projectId, presetName }) => {
  const state = store.load();
  const project = state.projects.find((p) => p.id === projectId);
  if (!project) return { presetName, valid: false, errors: ['Project not found'], entries: [], source: null };
  return presets.previewPreset(project.path, project.name, presetName);
});

handleChecked('preset:launch', async (_e, { projectId, presetName, selectedIndices }) => {
  const result = await sessions.launchPreset({ projectId, presetName, selectedIndices });
  result.state = getStateWithTmux(result.state);
  const state = getStateWithTmux();
  broadcast('state:changed', state);
  return result;
});

/* ---------------- Terminal IPC ---------------- */

handleChecked('term:open', async (_e, { sessionId, cols, rows, resume }) => {
  let state = store.load();
  let session = state.sessions.find((s) => s.id === sessionId);
  if (!session) return { ok: false, error: 'no such session' };

  // A session parked by the last quit has no tmux session until it is opened.
  // Starting it here is what makes the restore lazy.
  if (session.pending) {
    try {
      session = await sessions.startSession(sessionId, { resume: !!resume });
    } catch (err) {
      console.error('Failed to start parked session:', err.message);
      return { ok: false, error: err.message };
    }
    state = store.load();
    broadcast('state:changed', getStateWithTmux());
  }

  status.noteUserActivity(sessionId);
  ptyman.open({
    sessionId,
    tmuxName: session.tmuxName,
    cols, rows,
    onData: (data) => {
      broadcast('term:data', { sessionId, data });
      chatTitles.schedule(sessionId);
    },
    onExit: () => broadcast('term:data', {
      sessionId,
      data: '\r\n\x1b[2m[detached]\x1b[0m\r\n',
    }),
  });

  // remember what we were looking at
  state.lastActiveSessionId = sessionId;
  store.save(state);

  return { ok: true };
});

handleChecked('session:viewing', (_e, { sessionId }) => {
  viewingSessionId = sessionId;
  syncViewer();
});

handleChecked('term:input', (_e, { sessionId, data, chatTitle }) => {
  // Typing repaints the input line; Enter starts a turn, which is real work.
  if (!/[\r\n]/.test(data)) status.noteUserActivity(sessionId);
  ptyman.write(sessionId, data);
  chatTitles.acceptInputTitle(sessionId, data, chatTitle);
  if (/[\r\n]/.test(data)) chatTitles.schedule(sessionId);
});
handleChecked('term:resize', (_e, { sessionId, cols, rows }) => {
  status.noteUserActivity(sessionId);
  ptyman.resize(sessionId, cols, rows);
});
handleChecked('term:close',  (_e, { sessionId })             => ptyman.close(sessionId));

function runningTerminalSession(sessionId) {
  const session = store.load().sessions.find((row) => row.id === sessionId);
  if (!session || session.pending || !session.tmuxName) {
    throw new Error('Session is not running');
  }
  return session;
}

handleChecked('term:clear', async (_e, { sessionId }) => {
  const session = runningTerminalSession(sessionId);
  await tmux.clearPane(session.tmuxName);
  return { ok: true };
});

handleChecked('term:move-cursor', async (_e, { sessionId, fromCol, fromRow, toRow, chars }) => {
  if (![fromCol, fromRow, toRow, chars].every(Number.isInteger) || Math.abs(chars) > 4096) {
    throw new TypeError('Invalid cursor move');
  }
  const session = runningTerminalSession(sessionId);
  return tmux.moveCursorInLine(session.tmuxName, fromCol, fromRow, toRow, chars);
});

handleChecked('term:search', async (_e, { sessionId, query, direction }) => {
  if (!['start', 'next', 'previous'].includes(direction)) {
    throw new TypeError('Invalid terminal search direction');
  }
  const session = runningTerminalSession(sessionId);
  return tmux.searchPane(session.tmuxName, query, direction);
});

handleChecked('term:scroll-state', async (_e, { sessionId }) => {
  const session = runningTerminalSession(sessionId);
  return tmux.paneScrollState(session.tmuxName);
});

handleChecked('term:scroll-bottom', async (_e, { sessionId }) => {
  const session = runningTerminalSession(sessionId);
  return tmux.scrollPaneToBottom(session.tmuxName);
});

handleChecked('term:context-menu', (_e, { sessionId, hasSelection, linkUrl }) => {
  runningTerminalSession(sessionId);
  const action = (name) => () => broadcast('term:context-action', {
    sessionId,
    action: name,
    ...(linkUrl ? { linkUrl } : {}),
  });
  const template = [
    { label: 'Copy', accelerator: 'Command+C', enabled: !!hasSelection, click: action('copy') },
    { label: 'Paste', accelerator: 'Command+V', click: action('paste') },
    { label: 'Select All', accelerator: 'Command+A', click: action('select-all') },
    { type: 'separator' },
    { label: 'Clear Scrollback', accelerator: 'Command+K', click: action('clear') },
  ];
  if (linkUrl) {
    template.push(
      { type: 'separator' },
      { label: 'Open Link', click: action('open-link') },
      { label: 'Copy Link', click: action('copy-link') }
    );
  }
  Menu.buildFromTemplate(template).popup({ window: win });
});

/* ---------------- Ports IPC ---------------- */

handleChecked('ports:list', () => ports.list());
handleChecked('ports:kill', async (_e, { pid }) => ports.kill(pid));
handleChecked('url:open', async (_e, { url }) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url.trim())) {
    try { await shell.openExternal(url.trim()); } catch {}
  }
  return { ok: true };
});

module.exports = { broadcast, getWindow: () => win };
