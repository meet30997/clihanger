'use strict';

const DEFAULT_APPEARANCE = {
  effectiveAppearance: 'light',
  selectionBackground: '#b3d7ff',
  selectionForeground: '#000000',
  selectionInactiveBackground: '#dcdce0',
};

let state = {
  projects: [], sessions: [], agents: {}, lastActiveSessionId: null,
  appearance: DEFAULT_APPEARANCE,
};
let appearance = { ...DEFAULT_APPEARANCE };
let activeId = null;
const statuses = {};   // sessionId → status
const statusMetadata = {}; // sessionId → { waitingSince, snoozed, promptKind, seen, reason, tailExcerpt }

/** Mirrors `status.isWaiting` in main: a reply you have looked at is no longer waiting. */
function isWaitingStatus(sessionId) {
  const meta = statusMetadata[sessionId];
  return statuses[sessionId] === 'needs_input' && !meta?.snoozed
    && !(meta?.promptKind === 'reply' && meta?.seen);
}
const collapsedProjects = new Set();
try {
  const saved = JSON.parse(localStorage.getItem('hangar.collapsedProjects') || '[]');
  if (Array.isArray(saved)) saved.filter((id) => typeof id === 'string').forEach((id) => collapsedProjects.add(id));
} catch {}
let portsError = null;
let portRows = [];
let portsCheckedAt = null;
let portsView = false;
let portsGrouped = true;
let selectedPortKey = null;
let portsRequest = 0;
let openLauncherProjectId = null;
let projectPresetsCache = {};
let activePresetModal = null;

const $ = (sel) => document.querySelector(sel);

// The stored ID survives parking and restart; never derive identity from row order.
function sessionDisplayName(session) {
  const agentLabel = state.agents[session.agentId]?.label || session.agentId;
  const fallback = state.agents[session.agentId]?.kind === 'shell'
    ? `${agentLabel} · ${session.id.replace(/^s_/, '')}` : (session.pending ? 'Untitled chat' : 'New chat');
  return session.title || session.autoTitle || fallback;
}

function submittedChatTitle(sessionId, term, data) {
  if (data !== '\r') return undefined;
  const session = state.sessions.find((s) => s.id === sessionId);
  const agent = session && state.agents[session.agentId];
  if (!agent?.chatPromptPattern || agent.kind === 'shell' || statuses[sessionId] === 'exited') return undefined;
  try {
    const buffer = term.buffer.active;
    const line = buffer.getLine(buffer.baseY + buffer.cursorY);
    // Empty-input placeholders are painted after the cursor. A title must
    // contain actual text before it; multiline/hidden editors use backfill.
    const beforeCursor = line?.translateToString(true, 0, buffer.cursorX) || '';
    const pattern = new RegExp(agent.chatPromptPattern, 'u');
    const typed = beforeCursor.match(pattern)?.[1]?.trim();
    if (!typed || typed.startsWith('/')) return undefined;
    const full = line.translateToString(true).match(pattern)?.[1]?.trim();
    return [...(full || typed)].slice(0, 100).join('');
  } catch { return undefined; }
}

function sessionContext(session) {
  const project = state.projects.find((p) => p.id === session.projectId);
  return [sessionDisplayName(session), state.agents[session.agentId]?.label || session.agentId,
    project?.name || 'Unassigned', session.launchPath || session.worktreePath || project?.path,
    session.note].filter(Boolean).join('\n');
}

// Full context is exposed to assistive technology through aria-label, and to
// sighted users only on request (the switcher's Details button), never on hover.
let identityAnchor = null;
function setFullContext(el, text) {
  el.dataset.fullContext = text;
  el.setAttribute('aria-label', text);
  if (identityAnchor === el) {
    requestAnimationFrame(() => {
      if (identityAnchor === el) showIdentityDetail(el);
    });
  }
}
function hideIdentityDetail() {
  $('#identity-detail').hidden = true;
  identityAnchor?.removeAttribute('aria-describedby');
  identityAnchor = null;
}
function showIdentityDetail(el) {
  if (!el?.dataset.fullContext) return;
  hideIdentityDetail();
  identityAnchor = el;
  const detail = $('#identity-detail');
  detail.textContent = el.dataset.fullContext;
  detail.hidden = false;
  el.setAttribute('aria-describedby', 'identity-detail');
  const rect = el.getBoundingClientRect();
  detail.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - detail.offsetWidth - 8))}px`;
  const below = rect.bottom + 6;
  detail.style.top = `${Math.max(8, below + detail.offsetHeight <= window.innerHeight - 8
    ? below : rect.top - detail.offsetHeight - 6)}px`;
}
document.addEventListener('focusout', hideIdentityDetail);
document.addEventListener('pointerdown', hideIdentityDetail);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideIdentityDetail(); });
window.addEventListener('resize', hideIdentityDetail);
document.addEventListener('scroll', hideIdentityDetail, true);

const TERMINAL_THEMES = {
  dark: {
    // Every colour except black is >= 4.8:1 on the background.
    background: '#181818', foreground: '#ececec', cursor: '#8fb4ff',
    black: '#3a3a3c', red: '#ff6b61', green: '#4fd17a', yellow: '#e5c07b',
    blue: '#5aa9ff', magenta: '#d78bf0', cyan: '#4fd0d6', white: '#d6d6db',
    brightBlack: '#8a8a90', brightRed: '#ff8a80', brightGreen: '#7ee59b',
    brightYellow: '#ffd479', brightBlue: '#8cc4ff', brightMagenta: '#e5a8f7',
    brightCyan: '#7ee4e8', brightWhite: '#ffffff',
  },
  light: {
    background: '#ffffff', foreground: '#1d1d1f', cursor: '#0066cc',
    black: '#1d1d1f', red: '#b42318', green: '#18794e', yellow: '#765f00',
    blue: '#005ea8', magenta: '#8f3f71', cyan: '#006d77', white: '#4a4a4f',
    brightBlack: '#6e6e73', brightRed: '#d70015', brightGreen: '#1a7f37',
    brightYellow: '#8a6d00', brightBlue: '#0066cc', brightMagenta: '#a23b8e',
    brightCyan: '#007f8b', brightWhite: '#1d1d1f',
  },
};

function terminalTheme() {
  return { ...TERMINAL_THEMES[appearance.effectiveAppearance === 'light' ? 'light' : 'dark'] };
}

/* A selection must look the same whoever paints it — xterm here, tmux via
   `mode-style`, or app chrome via `::selection`. Main supplies the current
   macOS selected-text colours and broadcasts changes. */
function applyAppearance(next) {
  if (!next) return;
  appearance = { ...DEFAULT_APPEARANCE, ...next };
  const root = document.documentElement.style;
  root.setProperty('--selection', appearance.selectionBackground);
  root.setProperty('--selection-text', appearance.selectionForeground);
  root.setProperty('--selection-inactive', appearance.selectionInactiveBackground);

  document.documentElement.dataset.theme = appearance.effectiveAppearance;

  if (typeof terms !== 'undefined') {
    for (const { term } of terms.values()) {
      term.options.theme = {
        ...terminalTheme(),
        selectionBackground: appearance.selectionBackground,
        selectionForeground: appearance.selectionForeground,
        selectionInactiveBackground: appearance.selectionInactiveBackground,
      };
    }
  }
}

/* ---------- Terminal Configuration & Helpers ---------- */
const DEFAULT_FONT_SIZE = 13;
const MIN_FONT_SIZE = 9;
const MAX_FONT_SIZE = 32;
let currentFontSize = Number(localStorage.getItem('hangar:font-size')) || DEFAULT_FONT_SIZE;

function setFontSize(size) {
  currentFontSize = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, size));
  localStorage.setItem('hangar:font-size', String(currentFontSize));
  if (typeof terms !== 'undefined') {
    for (const { term } of terms.values()) {
      term.options.fontSize = currentFontSize;
    }
    scheduleRefit();
  }
}

function getMacOptionIsMeta() {
  const stored = localStorage.getItem('hangar:mac-option-is-meta');
  return stored !== null ? stored === 'true' : false;
}

function setMacOptionIsMeta(val) {
  localStorage.setItem('hangar:mac-option-is-meta', String(val));
  if (typeof terms !== 'undefined') {
    for (const { term } of terms.values()) {
      term.options.macOptionIsMeta = val;
    }
  }
}

async function clearTerminal(sessionId) {
  const entry = terms.get(sessionId);
  if (!entry) return;
  try {
    await window.hangar.clearTerminal(sessionId);
    entry.term.clear();
    updateCopyModeBadge(sessionId, { inCopyMode: false, scrollPosition: 0 });
  } catch (err) {
    showError(`Could not clear terminal: ${err.message}`);
  }
}

function clearActiveTerminal() {
  if (hasActiveTerminal()) return clearTerminal(activeId);
}

function hasActiveTerminal() {
  const session = state.sessions.find((s) => s.id === activeId);
  return !portsView && !!session && !session.pending && !parkedStarts.has(activeId) && terms.has(activeId);
}


/* ---------- Icons ----------
   Inline SVG on a 16-grid. Glyph characters (⟳ ▾ × ⚠️) fall back to whatever
   font on the system happens to carry them, so they landed at the wrong weight,
   size and baseline; these follow `currentColor` and the surrounding metrics. */

const ICONS = {
  activity:     '<path d="M1.5 8h3l2-5 3 10 2-5h3"/>',
  inspector:    '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M10 3v10"/>',
  plus:         '<path d="M8 3.75v8.5M3.75 8h8.5"/>',
  close:        '<path d="M4.25 4.25l7.5 7.5M11.75 4.25l-7.5 7.5"/>',
  chevronDown:  '<path d="M4 6.25L8 10.25l4-4"/>',
  refresh:      '<path d="M13.1 8a5.1 5.1 0 1 1-1.6-3.7"/><path d="M13.4 2.4v2.9h-2.9"/>',
  sidebar:      '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M6.4 3v10"/>',
  warning:      '<path d="M8 2.6l5.9 10.2H2.1z"/><path d="M8 6.4v3"/><path d="M8 11.1h.01"/>',
  terminal:     '<path d="M3 4.25L6.5 8 3 11.75"/><path d="M8 11.75h5"/>',
  pencil:       '<path d="M11.5 2.5l2 2-8 8H3v-2.5l8.5-8.5z"/><path d="M10 4l2 2"/>',
  handoff:      '<rect x="5" y="5" width="9" height="9" rx="2"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5"/>',
  search:       '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>',
  package:      '<path d="M8 2.5L2.5 5.5v5L8 13.5l5.5-3V5.5L8 2.5z"/><path d="M2.5 5.5L8 8.5l5.5-3"/><path d="M8 8.5v5"/>',
  folder:       '<path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-7.5z"/>',
  folderPlus:   '<path d="M6.5 12.5h-3a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3L8 5h4.5a1 1 0 0 1 1 1v1"/><path d="M11.5 9v5M9 11.5h5"/>',
  chat:         '<path d="M3 4.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H6l-3 2.5v-9.5a1 1 0 0 1 1-1z"/>',
  check:        '<path d="M3.5 8.5l3 3 6-6"/>',
  stop:         '<rect x="4.25" y="4.25" width="7.5" height="7.5" rx="1.5"/>',
};

function iconSvg(name, extraClass = '') {
  return `<svg class="icon${extraClass ? ' ' + extraClass : ''}" viewBox="0 0 16 16" `
       + `aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
}

/** Fill the icon slots that live in index.html. */
function mountStaticIcons() {
  const slots = [
    ['#add-project', 'folderPlus'],
    ['#sidebar-search .icon-slot', 'search'],
    ['#sidebar-collapse', 'sidebar'],
    ['#sidebar-expand', 'sidebar'],
    ['#ports-refresh', 'refresh'],
    ['#sidebar-ports .icon-slot', 'activity'],
    ['#inspector-toggle', 'inspector'],
    ['.ports-search .icon-slot', 'search'],
    ['#next-waiting .icon-slot', 'chat'],
    ['#no-tmux-banner .banner-icon', 'warning'],
    ['#breadcrumb-icon', 'pencil'],
    ['#topbar-handoff .btn-icon', 'handoff'],
    ['#switcher-search-icon', 'search'],
  ];
  document.querySelectorAll('[data-icon]').forEach((el) => { el.innerHTML = iconSvg(el.dataset.icon); });
  for (const [sel, name] of slots) {
    const el = $(sel);
    if (el) el.innerHTML = iconSvg(name);
  }
}

/* ---------- UI Notifications / Toasts ---------- */

function showError(msg) {
  const container = $('#toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast toast-error';
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function showToast(msg) {
  const container = $('#toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast toast-copied';
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

function formatDuration(sec) {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}h ${remM}m`;
}

let copiedToast = null;
let copiedToastHideTimer = null;
let copiedToastRemoveTimer = null;

function showCopiedIndicator() {
  const container = $('#toast-container');
  if (!container) return;

  clearTimeout(copiedToastHideTimer);
  clearTimeout(copiedToastRemoveTimer);
  if (!copiedToast?.isConnected) {
    copiedToast = document.createElement('div');
    copiedToast.className = 'toast toast-copied';
    copiedToast.textContent = 'Copied to clipboard';
    container.appendChild(copiedToast);
  }

  copiedToast.style.transition = 'none';
  copiedToast.style.opacity = '1';
  copiedToastHideTimer = setTimeout(() => {
    copiedToast.style.transition = 'opacity 0.2s ease';
    copiedToast.style.opacity = '0';
    copiedToastRemoveTimer = setTimeout(() => {
      copiedToast?.remove();
      copiedToast = null;
    }, 200);
  }, 1100);
}

/* ---------- In-App Modal Dialog (HIG / Confirmation / Input) ---------- */

let modalResolve = null;

function showModal({ title, message, inputPlaceholder = null, defaultValue = '', confirmText = 'Confirm', cancelText = 'Cancel', isDanger = false, choices = null }) {
  const modal = $('#modal');
  const titleEl = $('#modal-title');
  const bodyEl = $('#modal-body');
  const confirmBtn = $('#modal-confirm');
  const cancelBtn = $('#modal-cancel');

  titleEl.textContent = title;
  bodyEl.innerHTML = '';

  const msgP = document.createElement('div');
  msgP.textContent = message;
  bodyEl.appendChild(msgP);

  let inputEl = null;
  if (choices?.length) {
    inputEl = document.createElement('select');
    inputEl.size = Math.min(8, Math.max(2, choices.length));
    inputEl.setAttribute('aria-label', title);
    for (const choice of choices) {
      const option = document.createElement('option');
      option.value = choice.value;
      option.textContent = choice.label;
      inputEl.appendChild(option);
    }
    inputEl.value = choices.some((choice) => choice.value === defaultValue) ? defaultValue : choices[0].value;
    bodyEl.appendChild(inputEl);
  } else if (inputPlaceholder !== null) {
    inputEl = document.createElement('input');
    inputEl.type = 'text';
    inputEl.placeholder = inputPlaceholder;
    inputEl.value = defaultValue;
    inputEl.setAttribute('aria-label', title);
    bodyEl.appendChild(inputEl);
  }

  // The destructive weight is a class, not an inline colour: the palette lives
  // in style.css and nothing here should name a token.
  confirmBtn.textContent = confirmText;
  cancelBtn.textContent = cancelText;
  confirmBtn.className = isDanger ? 'btn-primary btn-danger' : 'btn-primary';

  modal.hidden = false;
  if (inputEl) {
    inputEl.focus();
    inputEl.select?.();
  } else {
    confirmBtn.focus();
  }

  return new Promise((resolve) => {
    modalResolve = (confirmed) => {
      modal.hidden = true;
      const val = inputEl ? inputEl.value.trim() : null;
      modalResolve = null;
      resolve({ confirmed, value: val });
    };

    confirmBtn.onclick = () => modalResolve(true);
    cancelBtn.onclick = () => modalResolve(false);

    modal.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Tab') {
        const controls = [inputEl, cancelBtn, confirmBtn].filter(Boolean);
        const index = controls.indexOf(document.activeElement);
        const next = (index + (e.shiftKey ? -1 : 1) + controls.length) % controls.length;
        e.preventDefault();
        controls[next].focus();
      } else if (e.key === 'Escape' && modalResolve) {
        e.preventDefault();
        modalResolve(false);
      }
    };

    if (inputEl) {
      inputEl.onkeydown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); modalResolve(true); }
      };
    }
  });
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalResolve) {
    modalResolve(false);
  }
});

/* ---------- Context Menu for Sidebar ---------- */

let ctxTargetSessionId = null;
const ctxMenu = $('#context-menu');

// The native menu is suppressed for the whole window, not just the terminal
// subtree: xterm's helper textarea, link overlays, and the sidebar all sit in
// different trees, and any one of them reaching the default handler puts a
// system menu on screen. Propagation is left alone so the sidebar's own
// oncontextmenu can still open the app menu below.
document.addEventListener('contextmenu', (event) => event.preventDefault(), { capture: true });
// A file dropped anywhere but a terminal would otherwise navigate the window to it.
document.addEventListener('dragover', (event) => event.preventDefault());
document.addEventListener('drop', (event) => event.preventDefault());

function showContextMenu(x, y, sessionId) {
  hideIdentityDetail();
  ctxTargetSessionId = sessionId;
  ctxMenu.style.left = `${Math.min(x, window.innerWidth - 180)}px`;
  ctxMenu.style.top = `${Math.min(y, window.innerHeight - 200)}px`;

  const meta = statusMetadata[sessionId] || {};
  const isWaiting = statuses[sessionId] === 'needs_input';
  const snoozeItem = $('#ctx-snooze');
  if (snoozeItem) {
    if (isWaiting) {
      snoozeItem.hidden = false;
      snoozeItem.textContent = meta.snoozed ? 'Unsnooze Attention' : 'Snooze Attention';
    } else {
      snoozeItem.hidden = true;
    }
  }

  ctxMenu.hidden = false;
}

function hideContextMenu() {
  ctxMenu.hidden = true;
  ctxTargetSessionId = null;
}

/* ---------- Native Context Menu for Terminal ---------- */

const hoveredTerminalLinks = new Map();

/* ---------- Terminal In-Pane Search (⌘F) ---------- */

let termSearchQuery = '';
let termSearchMatchCount = 0;
let currentTermSearchIdx = -1;
let termSearchRequest = 0;

function openTermSearch() {
  if (!hasActiveTerminal()) return;
  const searchEl = $('#term-search');
  if (!searchEl) return;
  searchEl.hidden = false;
  const input = $('#term-search-input');
  if (input) {
    input.focus();
    input.select();
    if (input.value) runTermSearch(input.value);
  }
}

function closeTermSearch() {
  const searchEl = $('#term-search');
  if (!searchEl) return;
  searchEl.hidden = true;
  termSearchRequest++;
  termSearchQuery = '';
  termSearchMatchCount = 0;
  currentTermSearchIdx = -1;
  const countEl = $('#term-search-count');
  if (countEl) countEl.textContent = '';
  if (hasActiveTerminal()) {
    terms.get(activeId).term.focus();
  }
}

async function runTermSearch(query) {
  termSearchQuery = (query || '').trim() ? query : '';
  termSearchMatchCount = 0;
  currentTermSearchIdx = -1;
  const countEl = $('#term-search-count');

  if (!termSearchQuery || !activeId || !terms.has(activeId)) {
    if (countEl) countEl.textContent = '';
    return;
  }

  const request = ++termSearchRequest;
  const sessionId = activeId;
  try {
    const result = await window.hangar.searchTerminal(sessionId, termSearchQuery, 'start');
    if (request !== termSearchRequest || sessionId !== activeId) return;
    termSearchMatchCount = result.matchCount;
    currentTermSearchIdx = result.matchCount > 0 ? 0 : -1;
    if (countEl) countEl.textContent = result.matchCount > 0 ? `1 of ${result.matchCount}` : '0 of 0';
    updateCopyModeBadge(sessionId, result);
  } catch (err) {
    if (request === termSearchRequest && countEl) countEl.textContent = 'Search failed';
  }
}

async function navigateTermSearch(step) {
  if (termSearchMatchCount === 0 || !activeId || !termSearchQuery) return;
  const sessionId = activeId;
  const direction = step < 0 ? 'previous' : 'next';
  try {
    const result = await window.hangar.searchTerminal(sessionId, termSearchQuery, direction);
    if (sessionId !== activeId) return;
    termSearchMatchCount = result.matchCount;
    if (termSearchMatchCount === 0) {
      currentTermSearchIdx = -1;
      const countEl = $('#term-search-count');
      if (countEl) countEl.textContent = '0 of 0';
      updateCopyModeBadge(sessionId, result);
      return;
    }
    currentTermSearchIdx = (currentTermSearchIdx + step + termSearchMatchCount) % termSearchMatchCount;
    const countEl = $('#term-search-count');
    if (countEl) countEl.textContent = `${currentTermSearchIdx + 1} of ${termSearchMatchCount}`;
    updateCopyModeBadge(sessionId, result);
  } catch {}
}

$('#term-search-input')?.addEventListener('input', (e) => {
  runTermSearch(e.target.value);
});

$('#term-search-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (e.shiftKey) navigateTermSearch(-1);
    else navigateTermSearch(1);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeTermSearch();
  }
});

$('#term-search-prev')?.addEventListener('click', () => navigateTermSearch(-1));
$('#term-search-next')?.addEventListener('click', () => navigateTermSearch(1));
$('#term-search-close')?.addEventListener('click', () => closeTermSearch());

/* ---------- Copy Mode / Scroll Position Indicator ---------- */

const terminalScrollStates = new Map();
const pendingScrollStateChecks = new Set();
const scrollStateRefreshTimers = new Map();

function updateCopyModeBadge(sessionId, nextState) {
  const state = {
    inCopyMode: !!nextState?.inCopyMode,
    scrollPosition: Math.max(0, Number(nextState?.scrollPosition) || 0),
  };
  terminalScrollStates.set(sessionId, state);
  if (sessionId !== activeId) return;
  const badge = $('#copy-mode-badge');
  if (!badge) return;
  if (state.inCopyMode) {
    badge.hidden = false;
    const textEl = $('#copy-mode-text');
    if (textEl) {
      textEl.textContent = state.scrollPosition > 0
        ? `Scrolled up (${state.scrollPosition} lines)`
        : 'Copy mode';
    }
  } else {
    badge.hidden = true;
  }
}

async function refreshTerminalScrollState(sessionId) {
  try {
    const next = await window.hangar.getTerminalScrollState(sessionId);
    updateCopyModeBadge(sessionId, next);
  } catch {}
}

function scheduleTerminalScrollStateRefresh(sessionId) {
  pendingScrollStateChecks.add(sessionId);
  clearTimeout(scrollStateRefreshTimers.get(sessionId));
  scrollStateRefreshTimers.set(sessionId, setTimeout(() => {
    scrollStateRefreshTimers.delete(sessionId);
    pendingScrollStateChecks.delete(sessionId);
    refreshTerminalScrollState(sessionId);
  }, 80));
}

async function scrollActiveTerminalToBottom() {
  if (!activeId) return;
  const sessionId = activeId;
  try {
    const next = await window.hangar.scrollTerminalToBottom(sessionId);
    updateCopyModeBadge(sessionId, next);
    terms.get(sessionId)?.term.focus();
  } catch {}
}

$('#copy-mode-exit')?.addEventListener('click', scrollActiveTerminalToBottom);

/* ---------- The "New" launcher popover ---------- */

/** Shut the open launcher, if any. Returns whether anything closed. */
function closeLauncher() {
  if (openLauncherProjectId === null) return false;
  openLauncherProjectId = null;
  render();
  return true;
}

window.addEventListener('click', (event) => {
  hideContextMenu();
  if (event.target && event.target.id === 'preset-modal') {
    closePresetModal();
  }
  if (event.target && event.target.id === 'handoff-modal') {
    closeHandoffModal();
  }

  const inLauncher = event.target instanceof Element
    && event.target.closest('.project-launcher');
  if (!inLauncher) closeLauncher();

  const inBreadcrumb = event.target instanceof Element
    && (event.target.closest('#breadcrumb-editor') || event.target.closest('#breadcrumb-pill'));
  if (!inBreadcrumb) closeBreadcrumbEditor();

  const inPopover = event.target instanceof Element
    && event.target.closest('#status-popover, .status-dot, #current-status');
  if (!inPopover) hideStatusPopover();
});

// Escape unwinds one layer at a time; the modal owns it while it is up.
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || modalResolve) return;
  if (!$('#switcher').hidden) {
    event.preventDefault();
    event.stopImmediatePropagation();
    closeSwitcher();
    return;
  }
  const handoffModal = $('#handoff-modal');
  if (handoffModal && !handoffModal.hidden) { closeHandoffModal(); return; }
  const presetModal = $('#preset-modal');
  if (presetModal && !presetModal.hidden) { closePresetModal(); return; }
  const popover = $('#status-popover');
  if (popover && !popover.classList.contains('hidden')) { hideStatusPopover(); return; }
  const editor = $('#breadcrumb-editor');
  if (editor && !editor.classList.contains('hidden')) {
    event.preventDefault();
    event.stopImmediatePropagation();
    closeBreadcrumbEditor();
    return;
  }
  const termSearch = $('#term-search');
  if (termSearch && !termSearch.hidden) {
    event.preventDefault();
    event.stopImmediatePropagation();
    closeTermSearch();
    return;
  }
  if (!ctxMenu.hidden) { hideContextMenu(); return; }
  const copyBadge = $('#copy-mode-badge');
  if (copyBadge && !copyBadge.hidden && activeId) {
    event.preventDefault();
    event.stopImmediatePropagation();
    scrollActiveTerminalToBottom();
    return;
  }
  closeLauncher();
}, { capture: true });


$('#ctx-note')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const id = ctxTargetSessionId;
  hideContextMenu();
  if (!id) return;
  if (id !== activeId) selectSession(id);
  openBreadcrumbEditor();
});

$('#ctx-snooze')?.addEventListener('click', async (e) => {
  e.stopPropagation();
  const id = ctxTargetSessionId;
  hideContextMenu();
  if (!id) return;
  const meta = statusMetadata[id] || {};
  const willSnooze = !meta.snoozed;
  try {
    await window.hangar.snoozeStatus(id, willSnooze);
    showToast(willSnooze ? 'Session attention snoozed' : 'Session attention unsnoozed');
  } catch (err) {
    showError(err.message);
  }
});

$('#ctx-conv')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const id = ctxTargetSessionId;
  hideContextMenu();
  if (id) promptSetConversationId(id);
});

$('#ctx-handoff')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const id = ctxTargetSessionId;
  hideContextMenu();
  if (id) openHandoffModal(id);
});

async function promptRenameSession(sessionId) {
  const session = state.sessions.find((row) => row.id === sessionId);
  if (!session) return;
  const renameButton = $('#inspector-rename');
  const restoreFocus = sessionId === activeId ? (renameButton.getClientRects().length ? renameButton : $('#current-title'))
    : $(`[data-session-id="${sessionId}"]`);
  const { confirmed, value } = await showModal({
    title: 'Rename Session',
    message: 'Give this chat a recognizable title. Leave blank to use its automatic chat title.',
    inputPlaceholder: sessionDisplayName({ ...session, title: null }),
    defaultValue: session.title || '',
    confirmText: 'Save',
  });
  if (confirmed) {
    try {
      state = await window.hangar.renameSession(sessionId, value || null);
      render();
    } catch (err) { showError(`Could not rename session: ${err.message}`); }
  }
  // Sidebar rows are rebuilt when state changes; resolve the new row on return.
  (restoreFocus?.isConnected ? restoreFocus : $(`[data-session-id="${sessionId}"]`))?.focus();
}

$('#topbar-rename').addEventListener('click', () => {
  if (activeId) promptRenameSession(activeId);
});
$('#ctx-rename')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const id = ctxTargetSessionId;
  hideContextMenu();
  if (id) promptRenameSession(id);
});

$('#ctx-kill')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const id = ctxTargetSessionId;
  hideContextMenu();
  if (id) confirmKillSession(id);
});

async function promptSetConversationId(sessionId, onSaved = null) {
  const session = state.sessions.find((s) => s.id === sessionId);
  if (!session) return;
  const currentId = session.conversationId || '';

  const { confirmed, value } = await showModal({
    title: 'Link Conversation ID (Advanced)',
    message: 'Link a conversation reference for agents with explicit resume support. Leave blank to remove the reference. Picker or continue commands choose context in the agent.',
    inputPlaceholder: 'e.g. session-uuid or identifier',
    defaultValue: currentId,
    confirmText: 'Save',
  });

  if (!confirmed) { $('#current-title')?.focus(); return; }

  try {
    const updatedState = await window.hangar.setSessionConversation(sessionId, value || null);
    state = updatedState;
    render();
    showToast(value ? 'Conversation identifier updated' : 'Conversation identifier removed');
    if (typeof onSaved === 'function') onSaved();
    else $('#current-title')?.focus();
  } catch (err) {
    showError(`Failed to update conversation ID: ${err.message}`);
  }
}

/* ---------- Breadcrumb Notes (F1) ---------- */

let breadcrumbSessionId = null;

function openBreadcrumbEditor(anchor = null) {
  if (!activeId) return;
  const active = state.sessions.find((s) => s.id === activeId);
  if (!active) return;

  const editor = $('#breadcrumb-editor');
  const input = $('#breadcrumb-input');
  const counter = $('#breadcrumb-counter');

  breadcrumbSessionId = active.id;
  input.value = active.note || '';
  counter.textContent = `${input.value.length}/500`;

  const preferred = anchor instanceof Element ? anchor : $('#breadcrumb-pill');
  const pill = preferred.getClientRects().length ? preferred : !$('#stopped').classList.contains('hidden') ? $('#stopped-edit-note') : $('#current-title');
  if (pill) {
    const pillRect = pill.getBoundingClientRect();
    const left = Math.max(20, Math.min(window.innerWidth - 400, pillRect.left));
    editor.style.left = `${left}px`;
    editor.style.top = `${Math.min(pillRect.bottom + 6, window.innerHeight - 160)}px`;
  }

  editor.classList.remove('hidden');
  input.focus();
  input.select();
}

function closeBreadcrumbEditor() {
  const editor = $('#breadcrumb-editor');
  if (editor) {
    const restoreFocus = editor.contains(document.activeElement);
    editor.classList.add('hidden');
    if (restoreFocus) $('#breadcrumb-pill').focus();
  }
}

async function saveBreadcrumbNote() {
  if (!activeId) return;
  const input = $('#breadcrumb-input');
  const val = input.value.trim();
  const note = val.length > 0 ? val.slice(0, 500) : null;
  const sessionId = breadcrumbSessionId;
  const saveButton = $('#breadcrumb-save');
  if (saveButton.disabled) return;
  saveButton.disabled = true;
  try {
    state = await window.hangar.setSessionNote(sessionId, note);
    closeBreadcrumbEditor();
    render();
  } catch (err) {
    $('#breadcrumb-editor').classList.remove('hidden');
    input.focus();
    showError(`Could not save note: ${err.message}`);
  } finally {
    saveButton.disabled = false;
  }
}

$('#breadcrumb-pill')?.addEventListener('click', (e) => {
  e.stopPropagation();
  openBreadcrumbEditor();
});

$('#breadcrumb-pill')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    e.stopPropagation();
    openBreadcrumbEditor();
  }
});

$('#breadcrumb-save')?.addEventListener('click', (e) => {
  e.stopPropagation();
  saveBreadcrumbNote();
});

$('#breadcrumb-cancel')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeBreadcrumbEditor();
});

$('#breadcrumb-input')?.addEventListener('input', (e) => {
  const counter = $('#breadcrumb-counter');
  if (counter) counter.textContent = `${e.target.value.length}/500`;
});

$('#breadcrumb-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.stopPropagation();
    closeBreadcrumbEditor();
  } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
    e.preventDefault();
    e.stopPropagation();
    saveBreadcrumbNote();
  }
});

$('#breadcrumb-editor').addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key !== 'Tab') return;
  const controls = [$('#breadcrumb-input'), $('#breadcrumb-cancel'), $('#breadcrumb-save')];
  const index = controls.indexOf(document.activeElement);
  e.preventDefault();
  controls[(index + (e.shiftKey ? -1 : 1) + controls.length) % controls.length].focus();
});

/* ---------- Status Explanation Popover (F4) ---------- */

let popoverRequest = 0;
const statusPopover = $('#status-popover');

function showStatusPopover(dotEl) {
  const sessionId = dotEl.getAttribute('data-session-id');
  if (!sessionId || !statusPopover) return;

  const request = ++popoverRequest;
  const rect = dotEl.getBoundingClientRect();
  const popoverWidth = 290;
  const left = Math.min(window.innerWidth - popoverWidth - 10, rect.right + 10);
  statusPopover.style.left = `${Math.max(10, left)}px`;
  statusPopover.style.top = `${Math.min(window.innerHeight - 200, Math.max(10, rect.top - 20))}px`;

  window.hangar.getStatusDetails(sessionId).then((details) => {
    if (request !== popoverRequest) return;
    const session = state.sessions.find((s) => s.id === sessionId);
    const resolvedDetails = details || {
      status: session?.pending ? 'exited' : (statuses[sessionId] || 'unknown'),
      reason: session?.pending ? 'Stopped — no managed process is running' : 'No observation recorded yet',
      source: 'none',
      waitingSince: null,
      transitionedAt: null,
      tailExcerpt: null,
      snoozed: false,
    };
    const lifecycle = session && lifecycleLabel(session);
    if (lifecycle) {
      resolvedDetails.reason = lifecycle === 'Starting'
        ? 'Launch requested; the terminal is not ready yet'
        : 'Stopped — no managed process is running';
      resolvedDetails.tailExcerpt = null;
      resolvedDetails.waitingSince = null;
      resolvedDetails.transitionedAt = null;
      resolvedDetails.source = 'none';
      resolvedDetails.snoozed = false;
    }
    const dot = $('#popover-dot');
    dot.className = 'status-dot status-' + resolvedDetails.status + (resolvedDetails.snoozed ? ' snoozed' : '');
    $('#popover-title').textContent = ((session && lifecycleLabel(session)) || resolvedDetails.status.replace('_', ' ')) + (resolvedDetails.snoozed ? ' (snoozed)' : '');

    let timeText = '';
    if (resolvedDetails.waitingSince && resolvedDetails.status === 'needs_input') {
      const sec = Math.max(0, Math.floor((Date.now() - resolvedDetails.waitingSince) / 1000));
      timeText = `Waiting ${formatDuration(sec)}`;
    } else if (resolvedDetails.transitionedAt) {
      const sec = Math.max(0, Math.floor((Date.now() - resolvedDetails.transitionedAt) / 1000));
      timeText = `${formatDuration(sec)} ago`;
    }
    $('#popover-time').textContent = timeText;
    $('#popover-reason').textContent = resolvedDetails.reason || 'No observation recorded';

    const excerptEl = $('#popover-excerpt');
    if (resolvedDetails.tailExcerpt) {
      excerptEl.textContent = resolvedDetails.tailExcerpt;
      excerptEl.classList.remove('hidden');
    } else {
      excerptEl.classList.add('hidden');
    }

    $('#popover-source').textContent = resolvedDetails.source === 'hook' ? 'Source: Webhook' : (resolvedDetails.source === 'none' ? 'Source: N/A' : 'Source: Detector poll');

    const snoozeBtn = $('#popover-snooze');
    if (!lifecycle && resolvedDetails.status === 'needs_input') {
      snoozeBtn.classList.remove('hidden');
      snoozeBtn.textContent = resolvedDetails.snoozed ? 'Unsnooze' : 'Snooze';
      snoozeBtn.onclick = async (e) => {
        e.stopPropagation();
        await window.hangar.snoozeStatus(sessionId, !resolvedDetails.snoozed);
        hideStatusPopover();
      };
    } else {
      snoozeBtn.classList.add('hidden');
    }

    statusPopover.classList.remove('hidden');
    statusPopover.setAttribute('aria-hidden', 'false');
  }).catch(() => {});
}

function hideStatusPopover() {
  popoverRequest++;
  if (statusPopover) {
    statusPopover.classList.add('hidden');
    statusPopover.setAttribute('aria-hidden', 'true');
  }
}

// The explanation card opens on request (click, Enter or Space), not on hover.
function toggleStatusPopover(dotEl) {
  const open = !statusPopover.classList.contains('hidden');
  if (open && statusPopover.dataset.sessionId === dotEl.getAttribute('data-session-id')) {
    hideStatusPopover();
    return;
  }
  statusPopover.dataset.sessionId = dotEl.getAttribute('data-session-id');
  showStatusPopover(dotEl);
}

$('#tree')?.addEventListener('click', (e) => {
  const dot = e.target.closest('.status-dot');
  if (dot) toggleStatusPopover(dot);
});

$('#tree')?.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('status-dot')) {
    e.preventDefault();
    e.stopPropagation();
    toggleStatusPopover(e.target);
  }
}, { capture: true });

/* ---------- Terminals & WebLinks ---------- */

// Normal drags are tmux copy-mode selections, so xterm emits no selection
// event. Observe the gesture without consuming it and acknowledge on release;
// tmux's MouseDragEnd binding copies through /usr/bin/pbcopy at the same point.
let terminalCopyGesture = null;
const terminalSelections = new Map(); // sessionId → most recent selected text, or null while pbcopy settles
document.addEventListener('mousedown', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const terminal = target?.closest('.term-wrap.active');
  if (event.button !== 0 || !terminal) {
    terminalCopyGesture = null;
    return;
  }
  terminalCopyGesture = {
    sessionId: activeId,
    x: event.clientX,
    y: event.clientY,
    moved: false,
    multiClick: event.detail >= 2,
  };
}, true);

document.addEventListener('mousemove', (event) => {
  if (!terminalCopyGesture) return;
  const dx = event.clientX - terminalCopyGesture.x;
  const dy = event.clientY - terminalCopyGesture.y;
  if (dx * dx + dy * dy >= 16) terminalCopyGesture.moved = true;
}, true);

document.addEventListener('mouseup', (event) => {
  const gesture = terminalCopyGesture;
  terminalCopyGesture = null;
  if (!gesture || event.button !== 0 || !gesture.sessionId) return;
  if (!gesture.moved && !gesture.multiClick) {
    terminalSelections.delete(gesture.sessionId);
    return;
  }

  // tmux owns ordinary mouse selection and writes it through pbcopy, so xterm's
  // getSelection() is empty. Remember that a real selection completed now and
  // read back the exact copied text after tmux's binding has settled. Marking
  // the entry immediately keeps Copy enabled even for a very fast right-click.
  terminalSelections.set(gesture.sessionId, null);
  setTimeout(() => {
    const text = window.hangar.readClipboardText();
    if (text) terminalSelections.set(gesture.sessionId, text);
    else terminalSelections.delete(gesture.sessionId);
    showCopiedIndicator();
  }, gesture.multiClick ? 375 : 75);
}, true);

const terms = new Map();   // sessionId → { term, fit, el }
const openingTerms = new Set(); // sessionIds with an in-flight term:open invoke
const parkedStarts = new Map(); // sessionId → requested resume mode until attachment completes
const resumePrompts = new Set(); // one recovery dialog per selected stopped row

function lifecycleLabel(session) {
  if (parkedStarts.has(session.id)) return 'Starting';
  if (session.pending) return 'Stopped';
  return null;
}

function startCapability(session) {
  const agent = state.agents[session.agentId] || {};
  const explicit = typeof agent.resumeCommand === 'string' && !!agent.resumeCommand.trim();
  const picker = typeof agent.resumePickerCommand === 'string' && !!agent.resumePickerCommand.trim();
  const shell = agent.kind === 'shell';
  const resume = !shell && ((explicit && !!session.conversationId) || picker);
  const label = shell ? 'Open terminal' : resume ? 'Resume' : 'Start session';
  return { explicit: !shell && explicit, picker: !shell && picker, shell, resume, label };
}
const wheelRemainders = new Map(); // sessionId → fractional terminal rows

/**
 * xterm 6 reduces every wheel event sent through a mouse protocol to one
 * up/down report, even when consumeWheelEvent() measured several rows. tmux
 * enables that protocol, so preserving the browser's pixel delta here is the
 * only way to retain macOS trackpad acceleration and momentum.
 */
function forwardWheelToTmux(sessionId, term, event) {
  if (term.modes.mouseTrackingMode === 'none' || event.deltaY === 0 || event.shiftKey) {
    return true;
  }

  const screen = term.element?.querySelector('.xterm-screen');
  const rect = screen?.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0 || term.cols <= 0 || term.rows <= 0) {
    return true;
  }

  const cellHeight = rect.height / term.rows;
  let pixels = event.deltaY;
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) pixels *= cellHeight;
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) pixels *= rect.height;

  let remainder = wheelRemainders.get(sessionId) || 0;
  const rows = pixels / cellHeight;
  if (remainder !== 0 && Math.sign(remainder) !== Math.sign(rows)) remainder = 0;
  remainder += rows;

  const wholeRows = Math.trunc(remainder);
  wheelRemainders.set(sessionId, remainder - wholeRows);
  if (wholeRows === 0) return false;

  const col = Math.max(1, Math.min(term.cols, Math.floor((event.clientX - rect.left) / rect.width * term.cols) + 1));
  const row = Math.max(1, Math.min(term.rows, Math.floor((event.clientY - rect.top) / rect.height * term.rows) + 1));
  const button = wholeRows < 0 ? 64 : 65; // SGR wheel up/down
  const report = `\x1b[<${button};${col};${row}M`;
  scheduleTerminalScrollStateRefresh(sessionId);
  window.hangar.termInput(sessionId, report.repeat(Math.abs(wholeRows)));
  return false;
}

// Command-Left, -Right and -Delete reach tmux as its User0–2 keys, which tmux
// turns into Control-A, -E and -U at a shell, or Home, End and Control-U when a
// full-screen program owns the pane (KEY_ROUTING in tmux.js, ADR-072/073). xterm itself drops Command chords. Option
// chords need nothing here: xterm's own M-Left/M-Right are routed the same way.
const COMMAND_EDITING_KEYS = { ArrowLeft: '\x1b[9001~', ArrowRight: '\x1b[9002~', Backspace: '\x1b[9003~' };

function commandEditingSequence(event) {
  if (event.isComposing || !event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
  return COMMAND_EDITING_KEYS[event.key] || null;
}

// Backslash-quote every ASCII character zsh or bash would interpret, as
// Terminal.app does for a Finder drop; non-ASCII text is literal to both shells.
// Control characters have no quoting that survives every shell and line editor
// (a backslash-newline is a line continuation), so a caller must reject them.
const UNQUOTABLE_PATH = /[\x00-\x1f\x7f-\x9f]/;

function shellEscapePath(filePath) {
  return filePath.replace(/[^\w\-.,:+@%/=\u00a0-\uffff]/g, '\\$&');
}

/** Resolve dropped Files to shell words, or say why the drop types nothing. */
function droppedPathText(files) {
  const paths = [];
  let notOnDisk = 0;
  const unquotable = [];
  for (const file of files) {
    let filePath = '';
    try { filePath = window.hangar.pathForFile(file); } catch {}
    if (!filePath) notOnDisk += 1;
    else if (UNQUOTABLE_PATH.test(filePath)) unquotable.push(file.name);
    else paths.push(filePath);
  }
  // All or nothing: a command missing one of the dropped arguments is worse
  // than no insertion at all.
  if (unquotable.length) {
    // JSON quoting shows the offending character instead of breaking the message.
    return { error: `Nothing was inserted: ${unquotable.map((name) => JSON.stringify(name)).join(', ')} has a line break or control character in its name.` };
  }
  if (notOnDisk) {
    return { error: notOnDisk === files.length
      ? 'Nothing was inserted: only files and folders from disk can be dropped.'
      : `Nothing was inserted: ${notOnDisk} of ${files.length} dropped items are not files on disk.` };
  }
  return { text: paths.map(shellEscapePath).join(' ') + ' ' };
}

/**
 * Option-click positions the shell cursor, as in Terminal.app (ADR-073). The
 * signed distance is counted in characters, not cells, so a wide CJK or emoji
 * cell is one arrow press. Main sends the arrows only if tmux confirms the
 * pane is a shell line on the main screen; anything else sends nothing.
 */
function optionClickMove(sessionId, term, event) {
  const screen = term.element?.querySelector('.xterm-screen');
  const rect = screen?.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return;
  const buffer = term.buffer.active;
  const row = Math.floor((event.clientY - rect.top) / rect.height * term.rows);
  let col = Math.round((event.clientX - rect.left) / rect.width * term.cols);
  if (row < 0 || row >= term.rows || col < 0) return;
  const fromRow = buffer.cursorY;
  const fromCol = buffer.cursorX;
  // Past the end of the text means the end of the text, never trailing blanks.
  const line = buffer.getLine(buffer.viewportY + row);
  if (!line) return;
  let end = 0;
  for (let x = term.cols - 1; x >= 0; x -= 1) {
    const chars = line.getCell(x)?.getChars();
    if (chars && chars !== ' ') { end = x + 1; break; }
  }
  col = Math.min(col, row === fromRow ? Math.max(end, fromCol) : end);

  const forward = row > fromRow || (row === fromRow && col > fromCol);
  let [x, y] = forward ? [fromCol, fromRow] : [col, row];
  const [stopX, stopY] = forward ? [col, row] : [fromCol, fromRow];
  let chars = 0;
  while (y < stopY || (y === stopY && x < stopX)) {
    if ((buffer.getLine(buffer.viewportY + y)?.getCell(x)?.getWidth() ?? 1) > 0) chars += 1;
    x += 1;
    if (x >= term.cols) { x = 0; y += 1; }
  }
  if (chars === 0) return;
  window.hangar.moveTerminalCursor(sessionId, fromCol, fromRow, row, forward ? chars : -chars)
    .catch((err) => showError(`Could not move the cursor: ${err.message}`));
}

function applyScreenReader() {
  for (const { term } of terms.values()) term.options.screenReaderMode = !!state.screenReader;
}

function getTerm(sessionId) {
  if (terms.has(sessionId)) return terms.get(sessionId);

  const el = document.createElement('div');
  el.className = 'term-wrap';
  $('#terminals').appendChild(el);

  const term = new Terminal({
    // Agent CLIs draw their own marks — Claude Code's ✻, spinner and box-drawing
    // frames, powerline separators, emoji. `SF Mono, Menlo, monospace` covers
    // none of the symbol blocks, and `monospace` resolves to one more Latin
    // face, so those characters had nothing to fall back to. The two Apple
    // faces below carry the dingbat, arrow, geometric and emoji blocks.
    fontFamily: '"JetBrains Mono Variable", "JetBrains Mono", "SF Mono", SFMono-Regular, Menlo, Monaco, "Apple Symbols", "Apple Color Emoji", monospace',
    fontSize: currentFontSize,
    lineHeight: 1.2,
    cursorBlink: true,
    allowProposedApi: true,
    // A glyph taken from a fallback face is not built to the cell width of the
    // primary one; without this it is drawn at its natural size and spills over
    // its neighbour instead of being fitted to the cell.
    rescaleOverlappingGlyphs: true,
    scrollback: 0,            // tmux owns scrollback; don't duplicate it
    macOptionIsMeta: getMacOptionIsMeta(),
    macOptionClickForcesSelection: true,
    // xterm's own Option-click mover reads its wrap markers, which tmux never
    // sets, and sends Up/Down for other rows: in a shell that recalls history.
    // optionClickMove() replaces it.
    altClickMovesCursor: false,
    // Only while VoiceOver (or another AT) runs: in this mode xterm ignores
    // insertText input, which is how the emoji picker and Character Viewer type.
    screenReaderMode: !!state.screenReader,
    // Agent CLIs paint truecolor picked for one background (usually dark: pale
    // yellow-green, light blue, light grey) that the palettes above cannot reach.
    // xterm nudges any cell below WCAG AA contrast until it passes, in either
    // appearance.
    minimumContrastRatio: 4.5,
    theme: {
      ...terminalTheme(),
      selectionBackground: appearance.selectionBackground,
      selectionForeground: appearance.selectionForeground,
      selectionInactiveBackground: appearance.selectionInactiveBackground,
    },
  });

  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);

  // xterm defaults to Unicode 6 widths, where most emoji are one cell, and
  // counts every part of a skin-tone or ZWJ sequence. tmux 3.7 draws each as
  // one two-cell cluster, so the cursor drifted after them (ADR-073).
  term.loadAddon(new UnicodeGraphemesAddon.UnicodeGraphemesAddon());
  term.unicode.activeVersion = '15-graphemes';

  // Clickable links via url:open IPC (Finding 1.4)
  if (typeof WebLinksAddon !== 'undefined' && WebLinksAddon.WebLinksAddon) {
    const webLinks = new WebLinksAddon.WebLinksAddon(
      (_e, uri) => window.hangar.openUrl(uri),
      {
        hover: (_event, uri) => hoveredTerminalLinks.set(sessionId, uri),
        leave: () => hoveredTerminalLinks.delete(sessionId),
      },
    );
    term.loadAddon(webLinks);
  }

  term.open(el);
  term.attachCustomWheelEventHandler((event) => forwardWheelToTmux(sessionId, term, event));
  // xterm 6 collapses Shift/Ctrl-Enter to CR. Agent editors need Shift-Enter;
  // regular shells need a bracketed-paste newline to avoid execution.
  term.attachCustomKeyEventHandler((event) => {
    const editing = commandEditingSequence(event);
    if (editing) {
      if (event.type === 'keydown') term.input(editing, true);
      event.preventDefault();
      return false;
    }
    if (event.key !== 'Enter' || event.isComposing || event.altKey || event.metaKey
      || (!event.shiftKey && !event.ctrlKey)) return true;
    if (event.type === 'keydown') {
      const session = state.sessions.find((s) => s.id === sessionId);
      const shell = state.agents[session?.agentId]?.kind === 'shell';
      if (shell && term.modes.bracketedPasteMode) term.paste('\n');
      else term.input('\x1b[13;2u', true);
    }
    event.preventDefault();
    return false;
  });
  term.onData((data) => {
    const isMouseReport = data.startsWith('\x1b[<') || data.startsWith('\x1b[M');
    if (!isMouseReport) terminalSelections.delete(sessionId);
    if (terminalScrollStates.get(sessionId)?.inCopyMode) scheduleTerminalScrollStateRefresh(sessionId);
    window.hangar.termInput(sessionId, data, submittedChatTitle(sessionId, term, data));
  });
  let selectionCopyTimer = null;
  term.onSelectionChange(() => {
    const selection = term.getSelection();
    if (selection) {
      terminalSelections.set(sessionId, selection);
      // tmux's MouseDragEnd binding may run pbcopy after xterm reports its
      // selection. Let that event settle, then make the renderer the final
      // clipboard writer so an empty tmux copy cannot erase the selected text.
      clearTimeout(selectionCopyTimer);
      selectionCopyTimer = setTimeout(() => {
        window.hangar.copyText(selection);
        showCopiedIndicator();
      }, 75);
    }
  });
  // Dropping files types their shell-escaped paths, as Terminal.app does: one
  // paste, a trailing space, no Return. A paste rather than keystrokes keeps
  // bracketed paste, which is how agent CLIs recognise a dropped image path.
  const isFileDrag = (event) => !!event.dataTransfer?.types.includes('Files');
  el.addEventListener('dragover', (event) => {
    event.preventDefault();
    const accept = isFileDrag(event) && el.classList.contains('active');
    event.dataTransfer.dropEffect = accept ? 'copy' : 'none';
    el.classList.toggle('drop-target', accept);
  });
  el.addEventListener('dragleave', (event) => {
    if (!el.contains(event.relatedTarget)) el.classList.remove('drop-target');
  });
  el.addEventListener('drop', (event) => {
    event.preventDefault();
    el.classList.remove('drop-target');
    // Only the visible, live terminal accepts a drop; a hidden or stopped one
    // must never receive input meant for the session on screen.
    if (!isFileDrag(event) || activeId !== sessionId || !el.classList.contains('active')) return;
    const files = [...event.dataTransfer.files];
    if (!files.length) return;
    const { text, error } = droppedPathText(files);
    if (error) { showError(error); return; }
    term.paste(text);
    term.focus();
  });
  // An Option-click (no drag, no selection) positions the cursor; an Option-drag
  // still selects, as macOptionClickForcesSelection makes it.
  let optionPress = null;
  el.addEventListener('mousedown', (event) => {
    optionPress = event.button === 0 && event.altKey && !event.metaKey && !event.ctrlKey
      && !event.shiftKey && event.detail === 1 ? { x: event.clientX, y: event.clientY } : null;
  }, true);
  el.addEventListener('mouseup', (event) => {
    const press = optionPress;
    optionPress = null;
    if (!press || Math.hypot(event.clientX - press.x, event.clientY - press.y) > 3 || term.hasSelection()) return;
    if (terminalScrollStates.get(sessionId)?.inCopyMode) return;
    optionClickMove(sessionId, term, event);
  }, true);
  el.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    hideContextMenu();
    const linkUrl = hoveredTerminalLinks.get(sessionId) || null;
    const hasSelection = Boolean(term.getSelection()) || terminalSelections.has(sessionId);
    window.hangar.showTerminalContextMenu(sessionId, hasSelection, linkUrl)
      .catch((err) => showError(`Could not open terminal menu: ${err.message}`));
  }, { capture: true });

  const entry = { term, fit, el };
  terms.set(sessionId, entry);
  return entry;
}

/**
 * Resize the terminal to its wrapper. Returns false when xterm has not measured
 * a cell yet — proposeDimensions() gives nothing and fit() would silently no-op,
 * leaving the terminal at its 80x24 default.
 */
function fitTerm(entry) {
  const { term, fit } = entry;
  let dims;
  try { dims = fit.proposeDimensions(); } catch { return false; }
  if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return false;
  if (dims.cols !== term.cols || dims.rows !== term.rows) {
    try { fit.fit(); } catch { return false; }
  }
  return true;
}

function showTerm(sessionId, resume = false) {
  if (portsView) { portsView = false; render(); }
  if (openingTerms.has(sessionId)) return;
  const session = state.sessions.find((s) => s.id === sessionId);
  if (!session) return;
  const starting = !!session.pending;
  openingTerms.add(sessionId);
  if (starting) {
    parkedStarts.set(sessionId, resume);
    hideIdentityDetail();
    render();
  }
  const entry = getTerm(sessionId);
  if (!starting && activeId === sessionId) {
    for (const [id, { el }] of terms) el.classList.toggle('active', id === sessionId);
    entry.term.focus();
  }

  let failure = null;
  let attempts = 0;
  const attempt = () => {
    // A stopped terminal stays hidden until the launch succeeds. Its initial
    // default dimensions are refit after the live wrapper becomes visible.
    if (!starting && !fitTerm(entry) && ++attempts < 10) {
      requestAnimationFrame(attempt);
      return;
    }
    Promise.resolve()
      .then(() => window.hangar.termOpen(sessionId, entry.term.cols, entry.term.rows, resume))
      .then((res) => {
        if (res && res.ok === false) throw new Error(res.error);
      })
      .catch((err) => {
        if (starting) failure = err.message;
        else showError(`Could not open session: ${err.message}`);
      })
      .finally(() => {
        openingTerms.delete(sessionId);
        parkedStarts.delete(sessionId);
        render();
        if (activeId !== sessionId) return;
        if (failure) {
          offerResumeRetry(sessionId, resume, failure);
        } else {
          entry.term.focus();
          scheduleRefit();
        }
      });
  };
  // Starting uses default terminal dimensions and must continue if the window
  // becomes occluded before its next animation frame. Refit after attachment.
  if (starting) attempt();
  else requestAnimationFrame(attempt);
}

/** Refit the active terminal after any layout change and push the new size to tmux. */
let refitTimer = null;
function scheduleRefit() {
  clearTimeout(refitTimer);
  refitTimer = setTimeout(() => {
    if (!hasActiveTerminal()) return;
    const entry = terms.get(activeId);
    const before = `${entry.term.cols}x${entry.term.rows}`;
    if (!fitTerm(entry)) return;
    if (`${entry.term.cols}x${entry.term.rows}` !== before) {
      window.hangar.termResize(activeId, entry.term.cols, entry.term.rows);
    }
  }, 100);
}

// Window resize is only one of the things that moves this box: the ports panel
// filling in, collapsing it, and the sidebar opening or shutting all do too.
new ResizeObserver(scheduleRefit).observe($('#terminals'));

function refreshTerminalFontsAndRefit() {
  for (const [, entry] of terms) {
    // Re-assert fontFamily by toggling to force optionsService to fire _onOptionChange
    // and trigger CharSizeService/WidthCache re-measurement with the loaded web font metrics
    const orig = entry.term.options.fontFamily;
    entry.term.options.fontFamily = 'monospace';
    entry.term.options.fontFamily = orig;
  }
  scheduleRefit();
}

if (document.fonts) {
  document.fonts.ready.then(refreshTerminalFontsAndRefit).catch(() => {});
  document.fonts.addEventListener?.('loadingdone', refreshTerminalFontsAndRefit);
}

const LOCALHOST_PORT_REGEX = /(?:https?:\/\/)?(?:localhost|127\.0\.0\.1):(\d{2,5})/i;
let portScanDebounce = null;

window.hangar.onTermData(({ sessionId, data }) => {
  // create the terminal if data arrives before we've rendered it
  getTerm(sessionId).term.write(data);
  if (pendingScrollStateChecks.delete(sessionId)) {
    clearTimeout(scrollStateRefreshTimers.get(sessionId));
    scrollStateRefreshTimers.delete(sessionId);
    refreshTerminalScrollState(sessionId);
  }
  if (LOCALHOST_PORT_REGEX.test(data)) {
    // Debounce port refreshes triggered by terminal output (Finding 2.6)
    clearTimeout(portScanDebounce);
    portScanDebounce = setTimeout(refreshPorts, 1000);
  }
});

window.hangar.onTermContextAction(({ sessionId, action, linkUrl }) => {
  const entry = terms.get(sessionId);
  if (!entry) return;

  if (action === 'copy') {
    const selection = entry.term.getSelection()
      || terminalSelections.get(sessionId)
      || (terminalSelections.has(sessionId) ? window.hangar.readClipboardText() : '');
    if (selection) {
      window.hangar.copyText(selection);
      showCopiedIndicator();
    }
  } else if (action === 'paste') {
    const text = window.hangar.readClipboardText();
    if (text) entry.term.paste(text);
  } else if (action === 'select-all') {
    entry.term.selectAll();
  } else if (action === 'clear') {
    clearTerminal(sessionId);
  } else if (action === 'open-link' && linkUrl) {
    window.hangar.openUrl(linkUrl).catch((err) => showError(`Could not open link: ${err.message}`));
  } else if (action === 'copy-link' && linkUrl) {
    window.hangar.copyText(linkUrl);
    showCopiedIndicator();
  }
});

function updateStatusDot(sessionId, status, snoozed = false) {
  const sessionEl = $(`.session[data-session-id="${sessionId}"]`);
  if (!sessionEl) return;
  const dot = sessionEl.querySelector('.status-dot');
  if (dot) {
    dot.className = 'status-dot status-' + status + (snoozed ? ' snoozed' : '');
    const readableStatus = status.replace('_', ' ') + (snoozed ? ' (snoozed)' : '');
    dot.setAttribute('aria-label', `Status: ${readableStatus}`);
    dot.setAttribute('data-session-id', sessionId);
  }
  sessionEl.classList.toggle('attention', isWaitingStatus(sessionId));
}

window.hangar.onStatusChanged(({ sessionId, status, waitingSince, snoozed, promptKind, seen, reason, tailExcerpt }) => {
  statuses[sessionId] = status;
  statusMetadata[sessionId] = {
    waitingSince: waitingSince || null,
    snoozed: !!snoozed,
    promptKind: promptKind || null,
    seen: !!seen,
    reason: reason || null,
    tailExcerpt: tailExcerpt || null,
  };
  // Fine-grained update in place to avoid destroying typing/inputs (Finding 4.1)
  updateStatusDot(sessionId, status, snoozed);
  refreshAttention();
  refreshSessionInspector();
  refreshWaitingDurations();
  if (!$('#switcher').hidden) {
    const selected = swItems[swIndex]?.id;
    updateSwitcher($('#switcher-input').value);
    const index = swItems.findIndex((item) => item.id === selected);
    if (index >= 0) swIndex = index;
    renderSwitcher();
  }
});

function refreshWaitingDurations() {
  document.querySelectorAll('[data-waiting-session]').forEach((el) => {
    const id = el.dataset.waitingSession;
    const meta = statusMetadata[id];
    const session = state.sessions.find((row) => row.id === id);
    const waiting = !session?.pending && isWaitingStatus(id) && meta?.waitingSince;
    el.textContent = waiting ? formatDuration(Math.max(0, Math.floor((Date.now() - meta.waitingSince) / 1000))) : '';
  });
}
setInterval(refreshWaitingDurations, 1000);

/* ---------- Sidebar ---------- */

const SIDEBAR_KEY = 'hangar.sidebarCollapsed';

function setSidebarCollapsed(collapsed) {
  const hadSidebarFocus = $('#sidebar').contains(document.activeElement) || document.activeElement === $('#sidebar-resizer') || document.activeElement === $('#sidebar-collapse');
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  const btn = $('#sidebar-collapse');
  if (btn) btn.setAttribute('aria-expanded', String(!collapsed));
  $('#sidebar-expand').setAttribute('aria-expanded', String(!collapsed));
  if (collapsed && hadSidebarFocus) $('#sidebar-expand').focus();
  else if (!collapsed && document.activeElement === $('#sidebar-expand')) btn?.focus();
  try { localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0'); } catch {}
  // the transition moves the terminal box for ~180ms after the class flips
  setTimeout(scheduleRefit, 200);
}

function toggleSidebar() {
  setSidebarCollapsed(!document.body.classList.contains('sidebar-collapsed'));
}

$('#sidebar-collapse').onclick = toggleSidebar;
$('#sidebar-expand').onclick = toggleSidebar;
$('#sidebar-search').onclick = openSwitcher;
window.addEventListener('hangar:toggle-sidebar', toggleSidebar);

/* ---------- Sidebar Resizing ---------- */

const resizer = $('#sidebar-resizer');
let isResizing = false;

function setSidebarWidth(width) {
  const value = Math.max(220, Math.min(600, width));
  document.documentElement.style.setProperty('--sidebar-width', `${value}px`);
  resizer.setAttribute('aria-valuenow', String(value));
  return value;
}

function saveSidebarWidth() {
  try { localStorage.setItem('hangar.sidebarWidth', `${resizer.getAttribute('aria-valuenow')}px`); } catch {}
}

if (resizer) {
  resizer.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    resizer.focus();
    isResizing = true;
    resizer.classList.add('is-resizing');
    document.body.style.cursor = 'col-resize';

    // Disable transitions during resize for smooth dragging
    $('#sidebar').style.transition = 'none';
  });

  window.addEventListener('mousemove', (e) => {
    if (!isResizing) return;

    setSidebarWidth(e.clientX);
  });

  window.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      resizer.classList.remove('is-resizing');
      document.body.style.cursor = '';

      // Restore transition
      $('#sidebar').style.transition = '';

      // Trigger terminal refit
      scheduleRefit();

      // Save width
      saveSidebarWidth();
    }
  });
  resizer.addEventListener('keydown', (e) => {
    const current = Number(resizer.getAttribute('aria-valuenow'));
    const step = e.shiftKey ? 32 : 16;
    const widths = { ArrowLeft: current - step, ArrowRight: current + step, Home: 220, End: 600 };
    if (!(e.key in widths)) return;
    e.preventDefault();
    setSidebarWidth(widths[e.key]);
    saveSidebarWidth();
    scheduleRefit();
  });
  resizer.addEventListener('dblclick', () => {
    setSidebarWidth(236);
    saveSidebarWidth();
    scheduleRefit();
  });
}

// Restore saved width on load
try {
  const savedWidth = localStorage.getItem('hangar.sidebarWidth');
  if (/^\d+(?:\.\d+)?px$/.test(savedWidth || '')) setSidebarWidth(parseFloat(savedWidth));
} catch {}

/* ---------- Native workspace chrome ---------- */

function agentIcon(agent) {
  const icon = document.createElement('span');
  icon.className = 'agent-icon';
  icon.setAttribute('aria-hidden', 'true');
  if (agent.color) icon.style.setProperty('--agent-color', agent.color);
  const file = agent.icon?.file;
  if (typeof file === 'string' && /^agent-icons\/[a-z0-9-]+\.png$/.test(file)) {
    if (agent.icon.monochrome) {
      icon.classList.add('agent-mask');
      icon.style.maskImage = `url("${file}")`;
    } else {
      const img = document.createElement('img'); img.src = file; img.alt = ''; img.width = 16; img.height = 16;
      icon.append(img);
    }
  } else {
    icon.innerHTML = iconSvg(agent.kind === 'shell' ? 'terminal' : 'chat');
  }
  return icon;
}

function waitingSessionsInOrder() {
  return orderedSessions().filter((s) => !s.pending && !!s.tmuxName && isWaitingStatus(s.id))
    .sort((a, b) => (statusMetadata[a.id]?.waitingSince || 0) - (statusMetadata[b.id]?.waitingSince || 0));
}

let attentionSignature = '';
function refreshAttention() {
  const waiting = waitingSessionsInOrder();
  $('#attention-count').textContent = waiting.length;
  const signature = JSON.stringify([portsView, activeId, waiting.map((s) => [s.id, sessionDisplayName(s), s.agentId])]);
  if (signature === attentionSignature) { refreshWaitingDurations(); return; }
  attentionSignature = signature;
  const list = $('#attention-list');
  const focusedId = list.contains(document.activeElement) ? document.activeElement.dataset.attentionSession : null;
  list.replaceChildren();
  for (const session of waiting) {
    const row = document.createElement('button');
    row.className = 'attention-row' + (!portsView && activeId === session.id ? ' active' : '');
    row.dataset.attentionSession = session.id;
    row.setAttribute('aria-label', sessionContext(session));
    const label = document.createElement('span');
    label.className = 'attention-label';
    label.textContent = sessionDisplayName(session);
    const duration = document.createElement('span');
    duration.className = 'waiting-duration';
    duration.dataset.waitingSession = session.id;
    row.append(agentIcon(state.agents[session.agentId] || {}), label, duration);
    row.onclick = () => selectSession(session.id);
    list.append(row);
  }
  if (!waiting.length) {
    const empty = document.createElement('p');
    empty.className = 'attention-empty';
    empty.textContent = 'Nothing right now';
    list.append(empty);
  }
  if (focusedId) [...list.children].find((el) => el.dataset.attentionSession === focusedId)?.focus({ preventScroll: true });
  refreshWaitingDurations();
}

// Tell main which terminal is on screen, so a reply that finishes while you
// watch it, or that you open, counts as seen.
let reportedViewing;
function reportViewing() {
  const session = !portsView && state.sessions.find((s) => s.id === activeId);
  const viewing = session && !session.pending ? session.id : null;
  if (viewing === reportedViewing) return;
  reportedViewing = viewing;
  window.hangar.setViewing(viewing).catch(() => {});
}

function observedStatus(session) {
  if (parkedStarts.has(session.id)) return 'Starting…';
  if (session.pending) return 'Stopped';
  const status = statuses[session.id];
  const meta = statusMetadata[session.id];
  const labels = { needs_input: 'Waiting for input', working: 'Working', idle: 'No recent output', exited: 'Agent exited' };
  let label = labels[status] || 'Not yet observed';
  if (status === 'needs_input' && meta?.promptKind === 'approval') label = 'Needs approval';
  if (status === 'needs_input' && meta?.promptKind === 'reply' && meta.seen) label = 'Reply seen';
  return label + (meta?.snoozed ? ' · snoozed' : '');
}

function refreshWorkspaceChrome() {
  const firstRun = !state.projects.length && !state.sessions.length;
  document.body.classList.toggle('first-run', firstRun);
  document.body.classList.toggle('ports-view', portsView);
  $('#terminals').classList.toggle('hidden', portsView);
  $('#ports').classList.toggle('hidden', !portsView);
  $('#ports-toolbar').hidden = !portsView;
  $('#topbar-right').hidden = portsView;
  $('#sidebar-ports').classList.toggle('active', portsView);
  $('#sidebar-ports').setAttribute('aria-pressed', String(portsView));
  $('#sidebar-ports-count').textContent = portsError ? '?' : portsCheckedAt ? String(portRows.length) : '—';
  $('#running-count').textContent = `${state.sessions.filter((s) => !s.pending && s.tmuxName).length} running`;
  if (portsView) {
    $('#current-title').textContent = 'Listening Ports';
    const age = portsCheckedAt ? Math.max(0, Math.floor((Date.now() - portsCheckedAt) / 1000)) : null;
    const subtitle = portsError ? 'Scan unavailable — last result may be out of date'
      : portsCheckedAt ? `${portRows.length} ports — checked ${age === 0 ? 'just now' : `${age} seconds ago`}` : 'Checking local TCP listeners…';
    $('#current-subtitle').textContent = subtitle;
    setFullContext($('#current-title'), 'Listening Ports');
    setFullContext($('#current-subtitle'), subtitle);
  }
  if (firstRun) {
    const list = $('#ready-agents');
    list.replaceChildren();
    for (const agent of Object.values(state.agents)) {
      if (agent.kind === 'shell') continue;
      const row = document.createElement('div'); row.className = 'ready-row';
      const label = document.createElement('span'); label.textContent = agent.label;
      const configured = document.createElement('span'); configured.textContent = 'Configured';
      row.append(agentIcon(agent), label, configured); list.append(row);
    }
    if (!list.children.length) { const row = document.createElement('div'); row.className = 'ready-row'; row.textContent = 'No agent CLIs configured'; list.append(row); }
    $('#ready-tmux').textContent = state.noTmux ? 'Unavailable' : 'Available';
  }
}

function addDetail(list, title, value, className = '') {
  const key = document.createElement('dt'); key.textContent = title;
  const text = document.createElement('dd'); text.textContent = value || '—'; text.className = className;
  list.append(key, text);
}

function refreshSessionInspector() {
  const session = state.sessions.find((s) => s.id === activeId);
  const selectedPort = portsView && portRows.find((r) => portKey(r) === selectedPortKey);
  $('#session-inspector').hidden = portsView || !session;
  $('#port-inspector').hidden = !portsView;
  $('#inspector-empty').classList.toggle('hidden', portsView || !!session);
  if (portsView) { renderPortInspector(selectedPort); return; }
  const status = $('#current-status');
  status.classList.toggle('hidden', !session);
  if (!session) return;
  status.classList.toggle('needs_input', statuses[session.id] === 'needs_input' && !session.pending);
  status.textContent = observedStatus(session);
  status.dataset.sessionId = session.id;
  const details = $('#inspector-session-details'); details.replaceChildren();
  const agent = state.agents[session.agentId] || {};
  const project = state.projects.find((p) => p.id === session.projectId);
  addDetail(details, 'Agent', agent.label || session.agentId);
  addDetail(details, 'State', observedStatus(session));
  addDetail(details, 'Created', session.createdAt ? new Date(session.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Not recorded');
  addDetail(details, 'Folder', session.launchPath || session.worktreePath || project?.path || 'Unknown', 'folder-path');
  $('#inspector-note-section').hidden = !!session.pending;
  $('#inspector-observation').hidden = !!session.pending;
  $('#inspector-ports-section').hidden = !!session.pending;
  $('#inspector-conversation').classList.toggle('conversation-first', !!session.pending);
  $('#inspector-note').textContent = session.note || '';
  const meta = statusMetadata[session.id];
  $('#inspector-reason').textContent = session.pending ? 'No managed process is running for this stopped session.'
    : meta?.reason || 'No status observation is available yet. The terminal remains the source of truth.';
  $('#inspector-excerpt').hidden = session.pending || !meta?.tailExcerpt;
  $('#inspector-excerpt').textContent = meta?.tailExcerpt || '';
  const snooze = $('#inspector-snooze');
  snooze.hidden = session.pending || statuses[session.id] !== 'needs_input';
  snooze.textContent = meta?.snoozed ? 'Unsnooze Attention' : 'Snooze Attention';
  $('#inspector-conversation').hidden = agent.kind === 'shell';
  const reference = session.conversationId || session.autoTitleConversationId;
  const cap = startCapability(session);
  // A recovered title reference is saved context, not an established resume target.
  // Show it before launch without promoting it to conversationId.
  $('#inspector-conversation-heading').textContent = session.conversationId ? 'Linked conversation'
    : reference ? 'Saved conversation' : 'Conversation';
  const conversationTitle = $('#inspector-conversation-title');
  conversationTitle.hidden = !session.autoTitle || !reference || session.autoTitleConversationId !== reference;
  conversationTitle.textContent = conversationTitle.hidden ? '' : session.autoTitle;
  $('#inspector-conversation-id').textContent = reference || (session.pending && cap.resume
    ? 'Resume available in agent' : 'Conversation not identified yet');
  const conversationHint = $('#inspector-conversation-hint');
  conversationHint.hidden = !!session.conversationId;
  conversationHint.textContent = session.pending && cap.picker
    ? 'Resume opens the agent’s conversation picker or continue action.'
    : reference ? 'Recovered from saved history. An exact resume link has not been established.'
    : session.pending ? 'Conversation details will appear after the agent identifies a conversation.'
    : 'Conversation details will appear when the agent identifies the active conversation.';
  $('#inspector-link').textContent = session.conversationId ? 'Change Conversation…' : 'Set Conversation ID…';
  const ports = $('#inspector-ports'); ports.replaceChildren();
  if (portsError) {
    const unknown = document.createElement('p'); unknown.textContent = 'Port scan unavailable. Could not determine current listeners.'; ports.append(unknown);
  } else {
    const rows = session.pending ? [] : portRows.filter((r) => r.sessionId === session.id);
    for (const row of rows) {
      const item = document.createElement('div'); item.className = 'inspector-port';
      const num = document.createElement('button'); num.className = 'text-button'; num.textContent = row.port;
      num.onclick = () => window.hangar.openUrl(`http://localhost:${row.port}`).catch((err) => showError(err.message));
      const process = document.createElement('span'); process.className = 'port-process'; process.textContent = row.command;
      const pid = document.createElement('small'); pid.textContent = ` · ${row.pid}`; process.append(pid); process.title = `${row.command} · PID ${row.pid}`;
      const stop = document.createElement('button'); stop.className = 'btn-secondary'; stop.textContent = 'Stop';
      stop.setAttribute('aria-label', `Stop ${row.command}, process ${row.pid}`); stop.onclick = () => stopPortProcess(row);
      item.append(num, process, stop); ports.append(item);
    }
    if (!rows.length) { const empty = document.createElement('p'); empty.textContent = !portsCheckedAt ? 'Checking listeners…' : 'No attributed listeners.'; ports.append(empty); }
  }
  $('#inspector-all-ports').textContent = portsError ? 'All listening ports — scan unavailable…' : `All listening ports${portsCheckedAt ? ` (${portRows.length})` : ''}…`;
  const waiting = waitingSessionsInOrder();
  const current = waiting.findIndex((s) => s.id === activeId);
  const next = waiting[(current + 1) % waiting.length];
  $('#next-waiting').hidden = !next || (waiting.length === 1 && next.id === activeId);
  $('#next-waiting-title').textContent = next ? sessionDisplayName(next) : '';
}

function renderPortInspector(row) {
  const inspector = $('#port-inspector'); inspector.replaceChildren();
  const title = document.createElement('h2'); title.className = 'port-inspector-title';
  title.textContent = row ? `Port ${row.port}` : 'Listening Ports'; inspector.append(title);
  if (!row) {
    const hint = document.createElement('p'); hint.className = 'port-inspector-note';
    hint.textContent = 'Select a listener to see its process, session, and stop action.'; inspector.append(hint); return;
  }
  const details = document.createElement('dl'); details.className = 'port-details';
  addDetail(details, 'Process', row.command); addDetail(details, 'PID', String(row.pid)); addDetail(details, 'Address', row.address);
  const owner = state.sessions.find((s) => s.id === row.sessionId);
  addDetail(details, 'Session', owner ? sessionDisplayName(owner) : 'Unknown ownership');
  addDetail(details, 'Project', row.projectName || 'Unknown'); inspector.append(details);
  const actions = document.createElement('div'); actions.className = 'port-inspector-actions';
  const open = document.createElement('button'); open.className = 'btn-secondary'; open.textContent = 'Open in Browser';
  open.onclick = () => window.hangar.openUrl(`http://localhost:${row.port}`).catch((err) => showError(err.message));
  const stop = document.createElement('button'); stop.className = 'btn-secondary'; stop.textContent = 'Stop Process…'; stop.disabled = !!portsError;
  stop.onclick = () => stopPortProcess(row); actions.append(open, stop); inspector.append(actions);
  if (owner) { const link = document.createElement('button'); link.className = 'text-button'; link.style.marginTop = '16px'; link.textContent = 'Go to Session'; link.onclick = () => selectSession(owner.id); inspector.append(link); }
  const note = document.createElement('p'); note.className = 'port-inspector-note';
  note.textContent = portsError ? 'The scan is unavailable. This is a previous observation; refresh before stopping the process.'
    : owner ? 'Stopping the process may close other ports it owns. The session stays open.'
    : 'Ownership could not be connected to a managed session. Verify the process before stopping it.';
  inspector.append(note);
}

function renderStoppedSession(session) {
  const stopped = !!session?.pending && !parkedStarts.has(session.id);
  $('#stopped').classList.toggle('hidden', !stopped);
  if (!stopped) return;
  const agent = state.agents[session.agentId] || {};
  const cap = startCapability(session);
  $('#stopped-title').textContent = sessionDisplayName(session);
  $('#stopped-agent-icon').replaceChildren(agentIcon(agent));
  $('#stopped-note-text').textContent = session.note || 'Add a note to remember where you left off.';
  $('#stopped-resume').textContent = cap.resume ? 'Resume' : cap.shell ? 'Open Terminal' : 'Start Session';
  $('#stopped-fresh').hidden = !cap.resume;
  $('#stopped-explanation').textContent = cap.shell
    ? 'Opens a new terminal in this folder. Output from the earlier terminal is not kept.'
    : cap.explicit && session.conversationId ? 'Resumes the linked conversation in a new terminal. Output from the earlier terminal is not kept.'
    : cap.picker ? 'Opens the agent’s configured conversation picker or continue action. Output from the earlier terminal is not kept.'
    : 'Starts a new agent conversation in this folder. This agent has no configured resume action.';
}

function setInspectorVisible(visible) {
  const hadFocus = $('#inspector').contains(document.activeElement);
  document.body.classList.toggle('inspector-hidden', !visible);
  $('#inspector-toggle').setAttribute('aria-expanded', String(visible));
  if (!visible && hadFocus) $('#inspector-toggle').focus();
  try { localStorage.setItem('hangar.inspectorHidden', visible ? '0' : '1'); } catch {}
  scheduleRefit();
}

$('#inspector-toggle').onclick = () => setInspectorVisible(document.body.classList.contains('inspector-hidden'));
$('#inspector-rename').onclick = () => activeId && promptRenameSession(activeId);
$('#inspector-link').onclick = () => activeId && promptSetConversationId(activeId);
$('#inspector-snooze').onclick = async () => {
  const id = activeId;
  if (!id) return;
  try { await window.hangar.snoozeStatus(id, !statusMetadata[id]?.snoozed); } catch (err) { showError(err.message); }
};
$('#next-waiting').onclick = jumpToNextWaitingSession;
$('#stopped-resume').onclick = () => activeId && openStoppedSession(activeId);
$('#stopped-fresh').onclick = () => activeId && showTerm(activeId, false);
$('#stopped-edit-note').onclick = (event) => openBreadcrumbEditor(event.currentTarget);
$('#stopped-handoff').onclick = () => activeId && openHandoffModal(activeId);
$('#current-status').onclick = (event) => toggleStatusPopover(event.currentTarget);
$('#current-status').onkeydown = (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  toggleStatusPopover(event.currentTarget);
};
setInterval(() => { if (portsView) refreshWorkspaceChrome(); }, 1000);

/* ---------- Sidebar Reordering ---------- */

// The row being dragged. dataTransfer contents are unreadable during dragover,
// so drop targets read this instead. Rebuilding the tree mid-drag would detach
// the drag source, so render() waits for the drag to end.
let sidebarDrag = null;
let renderAfterDrag = false;

function clearDropMarks() {
  $('#tree').querySelectorAll('.drop-before, .drop-after')
    .forEach((el) => el.classList.remove('drop-before', 'drop-after'));
}

/** Move `id` to sit before `beforeId` (null: last) among `siblingIds`, unless that is where it is. */
async function moveSidebarItem(kind, id, beforeId, siblingIds) {
  const index = siblingIds.indexOf(id);
  if (beforeId === id || beforeId === (siblingIds[index + 1] ?? null)) return;
  try {
    state = kind === 'project'
      ? await window.hangar.moveProject(id, beforeId)
      : await window.hangar.moveSession(id, beforeId);
    render();
  } catch (err) {
    showError(err.message);
  }
}

/** ⌥⌘↑ / ⌥⌘↓ moves the focused row: the keyboard path for drag to reorder. */
function handleReorderKey(e, kind, id, siblingIds) {
  if (!e.altKey || !e.metaKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return false;
  e.preventDefault();
  const index = siblingIds.indexOf(id);
  if (e.key === 'ArrowUp' && index > 0) moveSidebarItem(kind, id, siblingIds[index - 1], siblingIds);
  if (e.key === 'ArrowDown' && index < siblingIds.length - 1) {
    moveSidebarItem(kind, id, siblingIds[index + 2] ?? null, siblingIds);
  }
  return true;
}

/**
 * Let `handle` drag `target` (a project group or a session row) among the rows
 * of the same `group`. A drop on the top half of a row lands before it; on the
 * bottom half, after it.
 */
function enableReorder(handle, target, kind, id, group, siblingIds) {
  handle.draggable = true;
  handle.addEventListener('dragstart', (e) => {
    e.stopPropagation();
    sidebarDrag = { kind, id, group };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(`application/x-clihanger-${kind}`, id);
    hideIdentityDetail();
    requestAnimationFrame(() => target.classList.add('dragging'));
  });
  handle.addEventListener('dragend', () => {
    sidebarDrag = null;
    target.classList.remove('dragging');
    clearDropMarks();
    if (renderAfterDrag) render();
  });
  const accepts = () => sidebarDrag?.kind === kind && sidebarDrag.group === group;
  const dropsAfter = (e) => {
    const rect = target.getBoundingClientRect();
    return e.clientY > rect.top + rect.height / 2;
  };
  target.addEventListener('dragover', (e) => {
    if (!accepts()) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const after = dropsAfter(e);
    if (target.classList.contains(after ? 'drop-after' : 'drop-before')) return;
    clearDropMarks();
    if (sidebarDrag.id !== id) target.classList.add(after ? 'drop-after' : 'drop-before');
  });
  target.addEventListener('dragleave', (e) => {
    if (!target.contains(e.relatedTarget)) target.classList.remove('drop-before', 'drop-after');
  });
  target.addEventListener('drop', (e) => {
    if (!accepts()) return;
    e.preventDefault();
    e.stopPropagation();
    clearDropMarks();
    const beforeId = dropsAfter(e) ? siblingIds[siblingIds.indexOf(id) + 1] ?? null : id;
    moveSidebarItem(kind, sidebarDrag.id, beforeId, siblingIds);
  });
}

/* ---------- Rendering Tree & Affordances ---------- */

function render() {
  if (sidebarDrag) {
    renderAfterDrag = true;
    return;
  }
  renderAfterDrag = false;
  const tree = $('#tree');
  const treeScrollTop = $('.sidebar-scroll').scrollTop;
  const focused = tree.contains(document.activeElement) ? document.activeElement : null;
  const focusKey = focused?.dataset.sidebarFocus;
  const focusProject = focused?.closest('.project')?.dataset.projectId;
  hideIdentityDetail();
  tree.innerHTML = '';

  const groups = [
    ...state.projects.map((p) => ({
      project: p,
      sessions: state.sessions.filter((s) => s.projectId === p.id),
    })),
  ];

  const orphans = state.sessions.filter((s) => !s.projectId);
  if (orphans.length) {
    groups.push({ project: { id: null, name: 'Unassigned' }, sessions: orphans });
  }

  const projectIds = state.projects.map((p) => p.id);
  for (const g of groups) {
    const isCollapsed = g.project.id && collapsedProjects.has(g.project.id);
    const wrap = document.createElement('div');
    wrap.className = 'project' + (isCollapsed ? ' collapsed' : '') + (!g.sessions.length ? ' empty-project' : '');
    wrap.dataset.projectId = g.project.id || 'unassigned';
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', g.project.name);

    const row = document.createElement('div');
    row.className = 'project-row';
    const toggle = document.createElement(g.project.id ? 'button' : 'div');
    toggle.className = 'project-toggle';
    toggle.dataset.sidebarFocus = `project:${g.project.id}`;
    setFullContext(toggle, [g.project.name, g.project.path].filter(Boolean).join('\n'));
    if (g.project.id) {
      toggle.innerHTML = iconSvg('chevronDown', 'icon-sm project-chevron');
      toggle.setAttribute('aria-expanded', String(!isCollapsed));
      toggle.onclick = (e) => {
        e.stopPropagation();
        if (collapsedProjects.has(g.project.id)) collapsedProjects.delete(g.project.id);
        else collapsedProjects.add(g.project.id);
        try { localStorage.setItem('hangar.collapsedProjects', JSON.stringify([...collapsedProjects])); } catch {}
        render();
      };
      toggle.onkeydown = (e) => {
        if (handleReorderKey(e, 'project', g.project.id, projectIds)) return;
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        if ((e.key === 'ArrowRight') === !!isCollapsed) toggle.click();
      };
    }
    toggle.insertAdjacentHTML('beforeend', iconSvg('folder', 'project-folder'));

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = g.project.name;
    if (g.project.id) {
      row.oncontextmenu = async (e) => {
        e.preventDefault();
        const { confirmed } = await showModal({
          title: 'Remove Project',
          message: `Remove "${g.project.name}" from CliHanger? Active sessions will become unassigned.`,
          confirmText: 'Remove',
          isDanger: true,
        });
        if (!confirmed) return;
        try {
          state = await window.hangar.removeProject(g.project.id);
          render();
        } catch (err) {
          showError(err.message);
        }
      };
    }
    toggle.appendChild(name);
    if (g.sessions.length) {
      const count = document.createElement('span');
      count.className = 'project-count';
      count.textContent = g.sessions.length;
      count.setAttribute('aria-hidden', 'true');
      toggle.appendChild(count);
      toggle.setAttribute('aria-label', `${toggle.getAttribute('aria-label')}\n${g.sessions.length} session${g.sessions.length === 1 ? '' : 's'}`);
    }
    row.appendChild(toggle);

    if (g.project.id) {
      const actions = document.createElement('div');
      actions.className = 'project-actions';

      const launchBtn = document.createElement('button');
      launchBtn.className = 'project-launch-btn';
      launchBtn.title = `New terminal or agent in ${g.project.name}`;
      launchBtn.dataset.sidebarFocus = `launch:${g.project.id}`;
      launchBtn.setAttribute('aria-label', `New session in ${g.project.name}`);
      launchBtn.setAttribute('aria-expanded', String(openLauncherProjectId === g.project.id));
      launchBtn.innerHTML = iconSvg('plus');
      launchBtn.onclick = (e) => {
        e.stopPropagation();
        if (openLauncherProjectId !== g.project.id) delete projectPresetsCache[g.project.id];
        openLauncherProjectId = openLauncherProjectId === g.project.id ? null : g.project.id;
        collapsedProjects.delete(g.project.id);
        try { localStorage.setItem('hangar.collapsedProjects', JSON.stringify([...collapsedProjects])); } catch {}
        render();
      };
      actions.appendChild(launchBtn);

      row.appendChild(actions);
      enableReorder(row, wrap, 'project', g.project.id, 'projects', projectIds);
    }
    wrap.appendChild(row);

    if (g.project.id && openLauncherProjectId === g.project.id) {
      const launcher = document.createElement('div');
      launcher.className = 'project-launcher';

      const heading = document.createElement('div');
      heading.className = 'launcher-heading';
      heading.innerHTML = '<span>Start Session</span><small>⇧ click for worktree</small>';
      launcher.appendChild(heading);

      for (const [agentId, agent] of Object.entries(state.agents)) {
        const btn = document.createElement('button');
        btn.className = 'launcher-option';
        btn.dataset.sidebarFocus = `option:${g.project.id}:${agentId}`;
        btn.title = `Start ${agent.label} (⇧-click for git worktree)`;
        btn.setAttribute('aria-label', `Start ${agent.label}`);
        const launcherIcon = document.createElement('span');
        launcherIcon.className = 'launcher-icon';
        launcherIcon.style.setProperty('--launcher-color', agent.color);
        launcherIcon.innerHTML = agent.kind === 'shell'
          ? iconSvg('terminal')
          : '<span class="launcher-dot"></span>';

        const copy = document.createElement('span');
        copy.className = 'launcher-copy';
        const label = document.createElement('strong');
        label.textContent = agent.label;
        const kind = document.createElement('small');
        kind.textContent = agent.kind === 'shell' ? 'Regular shell' : 'Agent CLI';
        copy.append(label, kind);

        const arrow = document.createElement('span');
        arrow.innerHTML = iconSvg('chevronDown', 'launcher-arrow');
        btn.append(launcherIcon, copy, arrow);
        btn.onclick = async (e) => {
          e.stopPropagation();
          let branch = undefined;
          if (e.altKey || e.shiftKey) {
            const { confirmed, value } = await showModal({
              title: `Create Git Worktree (${agent.label})`,
              message: 'Enter a branch name for an isolated worktree:',
              inputPlaceholder: 'feature-branch',
              confirmText: 'Create Worktree',
            });
            if (!confirmed || !value) return;
            branch = value;
          }
          try {
            state = await window.hangar.createSession(g.project.id, agentId, branch);
            activeId = state.lastActiveSessionId;
            openLauncherProjectId = null;
            render();
            if (activeId) showTerm(activeId);
          } catch (err) {
            showError(err.message);
          }
        };
        launcher.appendChild(btn);
      }

      // Project Presets (F3)
      if (projectPresetsCache[g.project.id] === undefined) {
        projectPresetsCache[g.project.id] = null;
        window.hangar.listPresets(g.project.id).then((res) => {
          projectPresetsCache[g.project.id] = res;
          if (openLauncherProjectId === g.project.id) render();
        }).catch(() => {});
      }

      const presetsData = projectPresetsCache[g.project.id];
      if (presetsData?.error) {
        const error = document.createElement('div');
        error.className = 'launcher-heading';
        error.textContent = presetsData.error;
        launcher.appendChild(error);
      }
      const presetEntries = Object.entries(presetsData?.presets || {});
      if (presetEntries.length > 0) {
        const divider = document.createElement('div');
        divider.className = 'launcher-preset-divider';
        launcher.appendChild(divider);

        const presetHeading = document.createElement('div');
        presetHeading.className = 'launcher-heading';
        presetHeading.innerHTML = '<span>Presets</span><small>launch multiple</small>';
        launcher.appendChild(presetHeading);

        for (const [pName, pSessions] of presetEntries) {
          const pBtn = document.createElement('button');
          pBtn.className = 'launcher-option launcher-preset';
          pBtn.dataset.sidebarFocus = `preset:${g.project.id}:${pName}`;
          const sessionCount = Array.isArray(pSessions) ? pSessions.length : 0;
          pBtn.setAttribute('aria-label', `Preset ${pName}`);

          const pIcon = document.createElement('span');
          pIcon.className = 'launcher-icon';
          pIcon.innerHTML = iconSvg('package');

          const pCopy = document.createElement('span');
          pCopy.className = 'launcher-copy';
          const pLabel = document.createElement('strong');
          pLabel.textContent = pName;
          const pKind = document.createElement('small');
          pKind.textContent = `${sessionCount} session${sessionCount === 1 ? '' : 's'}`;
          pCopy.append(pLabel, pKind);

          const pArrow = document.createElement('span');
          pArrow.innerHTML = iconSvg('chevronDown', 'launcher-arrow');
          pBtn.append(pIcon, pCopy, pArrow);

          pBtn.onclick = (e) => {
            e.stopPropagation();
            openLauncherProjectId = null;
            render();
            openPresetModal(g.project.id, pName);
          };
          launcher.appendChild(pBtn);
        }
      }

      wrap.appendChild(launcher);
    }

    const sessionsContainer = document.createElement('div');
    sessionsContainer.className = 'project-sessions';

    const sessionIds = g.sessions.map((s) => s.id);
    const sessionGroup = `sessions:${g.project.id}`;
    for (const s of g.sessions) {
      const agent = state.agents[s.agentId] || { label: s.agentId, color: '#7b7b7c' };
      const el = document.createElement('div');
      el.setAttribute('data-session-id', s.id);
      el.dataset.sidebarFocus = `session:${s.id}`;
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      const st = s.pending ? 'exited' : (statuses[s.id] || 'unknown');
      const meta = statusMetadata[s.id] || {};
      const isSnoozed = !!meta.snoozed;

      const dot = document.createElement('span');
      dot.className = 'status-dot status-' + st + (isSnoozed ? ' snoozed' : '');
      const readableStatus = (lifecycleLabel(s) || st.replace('_', ' ')) + (isSnoozed ? ' (snoozed)' : '');
      dot.setAttribute('aria-label', `Status: ${readableStatus}`);
      dot.setAttribute('role', 'status');
      dot.setAttribute('data-session-id', s.id);
      dot.tabIndex = 0;
      dot.dataset.sidebarFocus = `status:${s.id}`;
      const waitingLabel = document.createElement('span');
      waitingLabel.className = 'waiting-duration';
      waitingLabel.dataset.waitingSession = s.id;

      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = sessionDisplayName(s);
      label.ondblclick = (e) => {
        e.stopPropagation();
        promptRenameSession(s.id);
      };
      const copy = document.createElement('div');
      copy.className = 'session-copy';
      copy.appendChild(label);
      const secondary = document.createElement('span');
      secondary.className = 'session-secondary';
      // An untitled row already contains the agent label. Custom titles need it
      // as secondary context; a saved note is always useful for recognition.
      secondary.textContent = [lifecycleLabel(s), agent.label, s.note?.replace(/\s+/g, ' ')]
        .filter(Boolean).join(' · ');
      if (secondary.textContent) copy.appendChild(secondary);
      setFullContext(el, sessionContext(s));

      el.className = 'session'
        + (!portsView && s.id === activeId ? ' active' : '')
        + (s.pending ? ' pending' : '')
        + (!s.pending && isWaitingStatus(s.id) ? ' attention' : '');

      // Closing a session is a per-row affordance, revealed on hover, rather
      // than a button in the topbar that only ever acted on the active one.
      const closeBtn = document.createElement('button');
      closeBtn.className = 'session-close';
      closeBtn.dataset.sidebarFocus = `close:${s.id}`;
      closeBtn.title = 'Close session';
      closeBtn.setAttribute('aria-label', `Close session ${sessionDisplayName(s)}`);
      closeBtn.innerHTML = iconSvg('close', 'icon-sm');
      closeBtn.onclick = (ce) => {
        ce.stopPropagation();
        confirmKillSession(s.id);
      };

      const stateLabel = document.createElement('span');
      stateLabel.className = 'session-state';
      stateLabel.textContent = lifecycleLabel(s) || '';
      el.append(agentIcon(agent), copy, stateLabel, dot, waitingLabel, closeBtn);
      dot.hidden = !!s.pending;
      el.onclick = () => selectSession(s.id);
      el.onkeydown = (ke) => {
        if (ke.target !== el) return;
        if (handleReorderKey(ke, 'session', s.id, sessionIds)) return;
        if (ke.key === 'Enter' || ke.key === ' ') {
          ke.preventDefault();
          selectSession(s.id);
        }
      };

      // Right-click context menu (Finding 4.9)
      el.oncontextmenu = (ce) => {
        ce.preventDefault();
        showContextMenu(ce.clientX, ce.clientY, s.id);
      };

      enableReorder(el, el, 'session', s.id, sessionGroup, sessionIds);
      sessionsContainer.appendChild(el);
    }

    wrap.appendChild(sessionsContainer);
    tree.appendChild(wrap);
  }
  $('.sidebar-scroll').scrollTop = treeScrollTop;

  if (focusKey) {
    const candidates = [...tree.querySelectorAll('[data-sidebar-focus]')];
    const target = candidates.find((el) => el.dataset.sidebarFocus === focusKey && el.getClientRects().length)
      || candidates.find((el) => el.dataset.sidebarFocus === `launch:${focusProject}` && el.getClientRects().length);
    target?.focus({ preventScroll: true });
  }

  const active = state.sessions.find((s) => s.id === activeId);
  const activeAgent = active ? (state.agents[active.agentId]?.label ?? active.agentId) : '';
  const activeDisplay = active
    ? sessionDisplayName(active)
    : 'No session selected';
  $('#current-title').textContent = activeDisplay;
  setFullContext($('#current-title'), active ? sessionContext(active) : activeDisplay);
  $('#topbar-rename').classList.toggle('hidden', !active);
  const activeProject = active ? state.projects.find((p) => p.id === active.projectId) : null;
  let subtitleText = 'Choose a project and start a terminal or agent';
  if (active) {
    const projName = activeProject?.name || 'Unassigned';
    if (active.worktreePath) {
      const wtName = active.worktreePath.split('/').pop();
      subtitleText = `${projName} · worktree: ${wtName}`;
    } else if (activeProject?.path) {
      subtitleText = `${projName} · ${activeProject.path}`;
    } else {
      subtitleText = projName;
    }
  }
  $('#current-subtitle').textContent = active ? `${activeProject?.name || 'Unassigned'} — ${activeAgent}` : subtitleText;
  setFullContext($('#current-subtitle'), active
    ? [...new Set([activeAgent, activeProject?.name || 'Unassigned', activeProject?.path,
      active.worktreePath, active.launchPath].filter(Boolean))].join('\n')
    : subtitleText);

  // Breadcrumb pill (F1)
  const breadcrumbPill = $('#breadcrumb-pill');
  if (active && breadcrumbPill) {
    breadcrumbPill.classList.remove('hidden');
    const note = active.note;
    if (note) {
      $('#breadcrumb-text').textContent = 'Edit Note';
      breadcrumbPill.classList.remove('empty-pill');
      setFullContext(breadcrumbPill, `Edit task note: ${note}`);
    } else {
      $('#breadcrumb-text').textContent = 'Add Note';
      breadcrumbPill.classList.add('empty-pill');
      setFullContext(breadcrumbPill, 'Add a task note to this session');
    }
  } else if (breadcrumbPill) {
    breadcrumbPill.classList.add('hidden');
    closeBreadcrumbEditor();
  }

  // Topbar handoff button (F5)
  const topbarHandoff = $('#topbar-handoff');
  if (topbarHandoff) {
    if (active) {
      topbarHandoff.classList.remove('hidden');
      topbarHandoff.onclick = () => openHandoffModal(active.id);
    } else {
      topbarHandoff.classList.add('hidden');
    }
  }

  const isParked = !!(active && (active.pending || parkedStarts.has(active.id)));
  for (const [id, { el, term }] of terms) {
    const visible = !portsView && !!active && !isParked && id === active.id;
    if (!visible && el.contains(document.activeElement)) term.blur();
    el.classList.toggle('active', visible);
  }
  const starting = !!active && parkedStarts.has(active.id);
  $('#session-opening').classList.toggle('hidden', !starting);
  $('#session-opening').textContent = starting
    ? (parkedStarts.get(active.id) ? 'Resuming conversation…' : 'Opening terminal…') : '';

  const noTmuxBanner = $('#no-tmux-banner');
  if (noTmuxBanner) noTmuxBanner.hidden = !state.noTmux;

  const emptyEl = $('#empty');
  if (!active) {
    emptyEl.classList.remove('hidden');
    const emptyTitle = emptyEl.querySelector('.empty-title');
    const emptyDesc = emptyEl.querySelector('.empty-desc');
    const emptyBtn = emptyEl.querySelector('#empty-add-project');
    if (state.projects.length === 0) {
      if (emptyTitle) emptyTitle.textContent = 'CliHanger';
      if (emptyDesc) emptyDesc.textContent = 'Run your coding agents side by side, see which one is waiting for you, and keep track of the ports your sessions use.';
      if (emptyBtn) emptyBtn.hidden = false;
    } else {
      if (emptyTitle) emptyTitle.textContent = state.sessions.length ? 'Open a conversation' : 'Start your first session';
      if (emptyDesc) emptyDesc.textContent = state.sessions.length
        ? 'Select a chat in the sidebar to continue.'
        : 'Click + beside a project, then choose a terminal or agent CLI.';
      if (emptyBtn) emptyBtn.hidden = true;
    }
  } else {
    emptyEl.classList.toggle('hidden', !!active);
  }
  refreshWorkspaceChrome();
  refreshAttention();
  reportViewing();
  renderStoppedSession(active);
  refreshSessionInspector();
}

async function offerResumeRetry(sessionId, resume, message) {
  if (resumePrompts.has(sessionId) || activeId !== sessionId) return;
  resumePrompts.add(sessionId);
  const { confirmed } = await showModal({
    title: resume ? 'Could not resume conversation' : 'Could not open terminal',
    message, confirmText: 'Retry', cancelText: 'Close',
  });
  resumePrompts.delete(sessionId);
  if (activeId !== sessionId) return;
  if (confirmed) showTerm(sessionId, resume);
  else { render(); $('#stopped-resume').focus(); }
}

function openStoppedSession(sessionId) {
  if (resumePrompts.has(sessionId) || openingTerms.has(sessionId)) return;
  const session = state.sessions.find((row) => row.id === sessionId);
  if (!session?.pending) return;
  showTerm(sessionId, startCapability(session).resume);
}

function selectSession(id) {
  portsView = false;
  if (activeId !== id && resumePrompts.size && modalResolve) modalResolve(false);
  if (activeId !== id) {
    closeBreadcrumbEditor();
    closeTermSearch();
  }
  activeId = id;
  render();
  updateCopyModeBadge(id, terminalScrollStates.get(id));
  const session = state.sessions.find((s) => s.id === id);
  if (session && !session.pending) {
    showTerm(id);
    refreshTerminalScrollState(id);
  } else if (session) {
    $('#stopped-resume').focus();
  } else {
    $('#current-title').focus();
  }
}

/* ---------- Ports Panel (Finding 2.4, 4.11) ---------- */

async function refreshPorts() {
  const request = ++portsRequest;
  try {
    const rows = await window.hangar.listPorts();
    if (request !== portsRequest) return;
    portRows = rows.sort((a, b) => a.port - b.port || a.pid - b.pid);
    portsError = null;
    portsCheckedAt = Date.now();
  } catch (err) {
    if (request !== portsRequest) return;
    portsError = err.message;
    // Retain the last successful observation; an unavailable scan is not zero.
  }
  renderPorts();
  refreshWorkspaceChrome();
  refreshSessionInspector();
}

function portKey(row) { return `${row.pid}:${row.port}`; }

function showPorts() {
  closeBreadcrumbEditor();
  closeTermSearch();
  portsView = true;
  render();
  renderPorts();
  $('#sidebar-ports').focus();
}

function renderPorts() {
  const body = $('#ports-body');
  const focusedKey = body.contains(document.activeElement) ? document.activeElement.dataset.portKey : null;
  const scrollTop = body.scrollTop;
  body.replaceChildren();
  const query = $('#ports-filter').value.trim().toLowerCase();
  const rows = portRows.filter((r) => {
    const session = state.sessions.find((s) => s.id === r.sessionId);
    return [r.port, r.pid, r.command, r.address, r.projectName, session && sessionDisplayName(session)]
      .filter((value) => value != null).join(' ').toLowerCase().includes(query);
  });
  if (!portRows.some((r) => portKey(r) === selectedPortKey)) selectedPortKey = null;
  const groups = new Map();
  for (const row of rows) {
    const group = portsGrouped ? (row.sessionId || 'unattributed') : 'all';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(row);
  }
  for (const [id, entries] of [...groups].sort(([a], [b]) => a === 'unattributed' ? 1 : b === 'unattributed' ? -1 : 0)) {
    if (portsGrouped) {
      const heading = document.createElement('div');
      heading.className = 'port-group-heading';
      const session = state.sessions.find((s) => s.id === id);
      if (session) heading.append(agentIcon(state.agents[session.agentId] || {}));
      const name = document.createElement('span');
      name.textContent = session ? sessionDisplayName(session) : 'Unknown ownership';
      const project = document.createElement('small');
      project.textContent = session ? (entries[0].projectName || 'Unassigned') : 'Could not attribute to a session';
      heading.append(name, project);
      body.append(heading);
    }
    for (const r of entries) {
      const row = document.createElement('div');
      row.className = 'port-row' + (portKey(r) === selectedPortKey ? ' selected' : '');
      row.tabIndex = 0;
      row.setAttribute('role', 'listitem');
      row.dataset.portKey = portKey(r);
      row.setAttribute('aria-label', `Port ${r.port}, ${r.command}, process ${r.pid}, ${r.address}`);
      for (const [value, cls] of [[r.port, 'num'], [r.command, 'cmd'], [r.pid, 'pid'], [r.address, 'address']]) {
        const span = document.createElement('span');
        span.className = cls;
        span.textContent = value;
        if (cls === 'cmd' || cls === 'address') span.title = String(value);
        row.append(span);
      }
      // Every listener can be stopped from its row, so stopping never depends
      // on the inspector being open or on the port being attributed.
      const stop = document.createElement('button');
      stop.className = 'port-stop';
      stop.disabled = !!portsError;
      stop.setAttribute('aria-label', `Stop ${r.command}, process ${r.pid}, port ${r.port}`);
      stop.innerHTML = iconSvg('stop', 'icon-sm');
      stop.onclick = (event) => { event.stopPropagation(); stopPortProcess(r); };
      row.append(stop);
      row.onclick = () => { selectedPortKey = portKey(r); renderPorts(); refreshSessionInspector(); };
      row.onkeydown = (event) => {
        if (event.target !== row) return;
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); row.click(); }
        if ((event.key === 'Backspace' || event.key === 'Delete') && !portsError) { event.preventDefault(); stopPortProcess(r); }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const items = [...body.querySelectorAll('.port-row')];
          items[items.indexOf(row) + (event.key === 'ArrowDown' ? 1 : -1)]?.focus();
        }
      };
      body.append(row);
    }
  }
  if (!rows.length) {
    const empty = document.createElement('p');
    empty.id = 'ports-empty';
    empty.textContent = portsError ? 'Listening ports are unavailable. Check again to retry.'
      : query ? 'No ports match your search.' : 'No local TCP listeners found.';
    body.append(empty);
  }
  body.scrollTop = scrollTop;
  if (focusedKey) [...body.querySelectorAll('.port-row')].find((r) => r.dataset.portKey === focusedKey)?.focus({ preventScroll: true });
  const scanMessage = $('#ports-scan-message');
  scanMessage.hidden = !portsError;
  scanMessage.textContent = portsError ? `Could not inspect ports: ${portsError}.${portsCheckedAt ? ' Showing the last successful scan; it may be out of date.' : ' Listening ports could not be determined.'}` : '';
  $('#ports-footer').textContent = portsError ? 'Scan unavailable · Check again to retry'
    : `${rows.length} of ${portRows.length} listening ports · Ownership follows the session’s process chain`;
  $('#ports-group-session').setAttribute('aria-pressed', String(portsGrouped));
  $('#ports-group-all').setAttribute('aria-pressed', String(!portsGrouped));
}

async function stopPortProcess(row) {
  const { confirmed } = await showModal({
    title: `Stop ${row.command}?`,
    message: `Stop process ${row.pid}, which is listening on port ${row.port}? This may close every listener owned by this process.`,
    confirmText: 'Stop Process', isDanger: true,
  });
  if (!confirmed) return;
  try {
    const result = await window.hangar.killPort(row.pid);
    if (!result.ok) showError(result.message);
    await refreshPorts();
  } catch (err) { showError(err.message); }
}

$('#ports-refresh').onclick = refreshPorts;
$('#sidebar-ports').onclick = showPorts;
$('#ports-filter').oninput = renderPorts;
$('#ports-group-session').onclick = () => { portsGrouped = true; renderPorts(); };
$('#ports-group-all').onclick = () => { portsGrouped = false; renderPorts(); };
$('#inspector-all-ports').onclick = showPorts;

/* ---------- Session Lifecycle & Termination ---------- */

async function terminateSession(dyingId) {
  try {
    await window.hangar.termClose(dyingId);
  } catch {}
  terms.get(dyingId)?.term.dispose();
  terms.get(dyingId)?.el.remove();
  terms.delete(dyingId);
  wheelRemainders.delete(dyingId);
  terminalScrollStates.delete(dyingId);
  terminalSelections.delete(dyingId);
  pendingScrollStateChecks.delete(dyingId);
  clearTimeout(scrollStateRefreshTimers.get(dyingId));
  scrollStateRefreshTimers.delete(dyingId);
  hoveredTerminalLinks.delete(dyingId);

  state = await window.hangar.killSession(dyingId);
  if (state.lastWarning) {
    showError(state.lastWarning);
  }

  // Closing a session selects nothing. Promoting a neighbour attaches a
  // terminal the user did not ask for, and on a row they may not even have been
  // looking at — closing a background session used to yank the view sideways.
  // Only the session that was on screen loses its selection.
  if (activeId === dyingId) activeId = null;

  render();
}

/** Confirm, then kill. The one path to killing a session from the sidebar. */
async function confirmKillSession(sessionId) {
  const session = state.sessions.find((s) => s.id === sessionId);
  const name = session ? sessionDisplayName(session) : 'session';
  const sidebarReturnKey = document.activeElement?.dataset.sidebarFocus;
  const restoreCloseFocus = () => {
    const target = [...$('#tree').querySelectorAll('[data-sidebar-focus]')]
      .find((el) => el.dataset.sidebarFocus === sidebarReturnKey);
    if (target?.getClientRects().length) target.focus();
  };

  const { confirmed } = await showModal({
    title: 'Close Session',
    message: `Close "${name}"? Any background processes and uncommitted work in isolated worktrees may be lost.`,
    confirmText: 'Close Session',
    isDanger: true,
  });
  if (!confirmed) { restoreCloseFocus(); return; }

  try {
    await terminateSession(sessionId);
  } catch (err) {
    showError(err.message);
    restoreCloseFocus();
  }
}

/* ---------- Keyboard & Shortcuts ---------- */

function orderedSessions() {
  const out = [];
  for (const p of state.projects) {
    out.push(...state.sessions.filter((s) => s.projectId === p.id));
  }
  out.push(...state.sessions.filter((s) => !s.projectId));
  return out;
}

window.addEventListener('keydown', (e) => {
  if (modalResolve || !$('#breadcrumb-editor').classList.contains('hidden')) return;

  // ⌘1..9 — jump to Nth session
  if (e.metaKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
    const target = orderedSessions()[Number(e.key) - 1];
    if (target) { e.preventDefault(); selectSession(target.id); }
    return;
  }

  // ⌘+ / ⌘= — zoom in (font size)
  if (e.metaKey && (e.key === '+' || e.key === '=')) {
    e.preventDefault();
    setFontSize(currentFontSize + 1);
    return;
  }

  // ⌘- — zoom out (font size)
  if (e.metaKey && !e.shiftKey && e.key === '-') {
    e.preventDefault();
    setFontSize(currentFontSize - 1);
    return;
  }

  // ⌘0 — actual size (font size default)
  if (e.metaKey && !e.shiftKey && e.key === '0') {
    e.preventDefault();
    setFontSize(DEFAULT_FONT_SIZE);
    return;
  }

  // ⌘F — find in terminal
  if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    openTermSearch();
    return;
  }

  // ⌘K — clear active terminal scrollback & screen (macOS Terminal parity)
  if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
    if (hasActiveTerminal()) {
      e.preventDefault();
      clearActiveTerminal();
      return;
    }
  }

  // ⌘P — quick switcher (toggle open/close)
  if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'p') {
    e.preventDefault();
    if (!$('#switcher').hidden) closeSwitcher();
    else openSwitcher();
    return;
  }

  // ⌘B — show/hide the sidebar
  if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'b') {
    e.preventDefault();
    toggleSidebar();
    return;
  }

  // ⌘⇧N — new session in the current project with its default agent
  if (e.metaKey && e.shiftKey && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    createNewDefaultSession();
    return;
  }

  // ⌘⇧J — jump to next waiting session (F2)
  if (e.metaKey && e.shiftKey && e.key.toLowerCase() === 'j') {
    e.preventDefault();
    e.stopImmediatePropagation();
    jumpToNextWaitingSession();
    return;
  }

  // Fallback ⌘K when no terminal is active
  if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (!$('#switcher').hidden) closeSwitcher();
    else openSwitcher();
    return;
  }
}, { capture: true });

function jumpToNextWaitingSession() {
  const waitingSessions = waitingSessionsInOrder();
  if (waitingSessions.length === 0) { showToast('No sessions waiting for attention'); return; }

  // Find next session after activeId
  const currentIndex = waitingSessions.findIndex((s) => s.id === activeId);
  const nextSession = (currentIndex >= 0 && currentIndex < waitingSessions.length - 1)
    ? waitingSessions[currentIndex + 1]
    : waitingSessions[0];

  selectSession(nextSession.id);
  const durSec = Math.max(0, Math.floor((Date.now() - (statusMetadata[nextSession.id]?.waitingSince || Date.now())) / 1000));
  showToast(`Jumped to ${sessionDisplayName(nextSession)} (waiting ${formatDuration(durSec)})`);
}

async function createNewDefaultSession() {
  const active = state.sessions.find((s) => s.id === activeId);
  const project = state.projects.find((p) => p.id === active?.projectId)
               ?? state.projects[0];
  if (project) {
    const defaultAgent = project.defaultAgent || Object.keys(state.agents)[0] || 'default';
    try {
      state = await window.hangar.createSession(project.id, defaultAgent);
      activeId = state.lastActiveSessionId;
      render();
      if (activeId) showTerm(activeId);
    } catch (err) {
      showError(err.message);
    }
  }
}

window.addEventListener('hangar:new-session', () => createNewDefaultSession());
window.addEventListener('hangar:quick-switcher', () => {
  if (!$('#switcher').hidden) closeSwitcher();
  else openSwitcher();
});
window.addEventListener('hangar:next-waiting', () => jumpToNextWaitingSession());
window.addEventListener('hangar:zoom-in', () => setFontSize(currentFontSize + 1));
window.addEventListener('hangar:zoom-out', () => setFontSize(currentFontSize - 1));
window.addEventListener('hangar:zoom-reset', () => setFontSize(DEFAULT_FONT_SIZE));
window.addEventListener('hangar:clear-terminal', () => clearActiveTerminal());
window.addEventListener('hangar:find-terminal', () => openTermSearch());
window.addEventListener('hangar:set-option-meta', (e) => setMacOptionIsMeta(Boolean(e.detail)));


/* ---------- Quick Switcher (Finding 2.6, 4.13, F2) ---------- */

let swItems = [];
let swIndex = 0;
let currentSearchToken = 0;
let searchDebounce = null;
let switcherFromSidebar = false;

function openSwitcher() {
  switcherFromSidebar = document.activeElement === $('#sidebar-search');
  $('#switcher').hidden = false;
  const input = $('#switcher-input');
  input.value = '';
  input.focus();
  updateSwitcher('');
}

function closeSwitcher() {
  hideIdentityDetail();
  $('#switcher').hidden = true;
  if (switcherFromSidebar && !document.body.classList.contains('sidebar-collapsed')) {
    $('#sidebar-search').focus();
  } else if (!portsView && activeId && terms.has(activeId) && !state.sessions.find((s) => s.id === activeId)?.pending && !parkedStarts.has(activeId)) {
    terms.get(activeId).term.focus();
  } else {
    document.body.focus();
  }
}

function updateSwitcher(query) {
  const q = query.toLowerCase().trim();
  const token = ++currentSearchToken;

  swItems = orderedSessions().map((s) => {
    const project = state.projects.find((p) => p.id === s.projectId);
    const agent = state.agents[s.agentId] || { label: s.agentId, color: '#7b7b7c' };
    const meta = statusMetadata[s.id] || {};
    return {
      id: s.id,
      title: sessionDisplayName(s),
      fullContext: sessionContext(s),
      note: s.note || null,
      sub: project?.name ?? 'unassigned',
      snippet: null,
      color: agent.color,
      status: s.pending ? 'exited' : (statuses[s.id] || 'unknown'),
      lifecycle: lifecycleLabel(s),
      waitingSince: meta.waitingSince || null,
      snoozed: !!meta.snoozed,
      waiting: !s.pending && isWaitingStatus(s.id),
      haystack: `${sessionDisplayName(s)} ${s.note ?? ''} ${agent.label} ${project?.name ?? ''} ${s.tmuxName}`.toLowerCase(),
    };
  });

  if (q) swItems = swItems.filter((i) => i.haystack.includes(q));

  // Attention queue sorting (F2):
  // 1. Active waiting sessions (needs_input, not snoozed, not a seen reply), oldest waitingSince first
  // 2. Snoozed waiting sessions (needs_input && snoozed), oldest waitingSince first
  // 3. All other sessions in default order
  swItems.sort((a, b) => {
    const aWait = !!a.waiting;
    const bWait = !!b.waiting;
    if (aWait && bWait) {
      return (a.waitingSince || 0) - (b.waitingSince || 0);
    }
    if (aWait !== bWait) return bWait - aWait;

    const aSnooze = a.status === 'needs_input' && a.snoozed;
    const bSnooze = b.status === 'needs_input' && b.snoozed;
    if (aSnooze && bSnooze) {
      return (a.waitingSince || 0) - (b.waitingSince || 0);
    }
    if (aSnooze !== bSnooze) return bSnooze - aSnooze;

    return 0;
  });

  swIndex = 0;
  renderSwitcher();

  if (q.length >= 2) {
    window.hangar.searchScrollback(q).then((searchResults) => {
      if (token !== currentSearchToken) return;
      // Show snippet matches even for sessions whose name already matched (Finding 4.13)
      for (const res of searchResults) {
        if (!res.matches || res.matches.length === 0) continue;
        const existing = swItems.find((i) => i.id === res.sessionId);
        if (existing) {
          existing.snippet = res.matches[res.matches.length - 1].line;
        } else {
          const agent = state.agents[res.agentId] || { label: res.agentId, color: '#7b7b7c' };
          const meta = statusMetadata[res.sessionId] || {};
          swItems.push({
            id: res.sessionId,
            title: sessionDisplayName(state.sessions.find((s) => s.id === res.sessionId)
              || { id: res.sessionId, title: res.title, agentId: res.agentId }),
            fullContext: [res.title, agent.label, res.projectName].filter(Boolean).join('\n'),
            note: null,
            sub: res.projectName,
            snippet: res.matches[res.matches.length - 1].line,
            color: agent.color,
            status: statuses[res.sessionId] || 'idle',
            waitingSince: meta.waitingSince || null,
            snoozed: !!meta.snoozed,
            waiting: isWaitingStatus(res.sessionId),
          });
        }
      }
      renderSwitcher();
    }).catch(() => {});
  }
}

function renderSwitcher() {
  const box = $('#switcher-results');
  box.innerHTML = '';
  const detailButton = $('#switcher-context');
  const selectedItem = swItems[swIndex];
  detailButton.disabled = !selectedItem;
  setFullContext(detailButton, selectedItem?.fullContext || selectedItem?.title || 'No selected session');

  if (swItems.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'sw-empty';
    empty.textContent = 'No matching sessions or projects';
    box.appendChild(empty);
    return;
  }

  swItems.forEach((item, i) => {
    const el = document.createElement('div');
    el.className = 'sw-item' + (i === swIndex ? ' sel' : '') + (item.snoozed ? ' snoozed' : '');
    el.setAttribute('role', 'option');
    setFullContext(el, item.fullContext || item.title);

    const dot = document.createElement('span');
    dot.className = 'status-dot status-' + item.status + (item.snoozed ? ' snoozed' : '');

    const title = document.createElement('span');
    title.className = 'sw-title';
    title.textContent = item.title;

    el.append(dot, title);
    if (item.lifecycle) {
      const life = document.createElement('span');
      life.className = 'sw-sub';
      life.textContent = item.lifecycle;
      el.append(life);
      dot.setAttribute('aria-label', item.lifecycle);
    }

    if (item.waiting || (item.status === 'needs_input' && item.snoozed)) {
      const waitSpan = document.createElement('span');
      waitSpan.className = 'sw-waiting' + (item.snoozed ? ' snoozed' : '');
      if (item.waitingSince) {
        const sec = Math.max(0, Math.floor((Date.now() - item.waitingSince) / 1000));
        waitSpan.textContent = item.snoozed ? `snoozed (${formatDuration(sec)})` : `waiting ${formatDuration(sec)}`;
      } else {
        waitSpan.textContent = item.snoozed ? 'snoozed' : 'waiting';
      }
      el.append(waitSpan);
    }

    if (item.snippet) {
      const snip = document.createElement('span');
      snip.className = 'sw-snippet';
      snip.textContent = item.snippet;
      el.append(snip);
    } else if (item.note) {
      const snip = document.createElement('span');
      snip.className = 'sw-snippet';
      const pencilIcon = document.createElement('span');
      pencilIcon.innerHTML = iconSvg('pencil', 'icon-sm');
      const noteTxt = document.createTextNode(' ' + item.note);
      snip.append(pencilIcon, noteTxt);
      el.append(snip);
    }

    const sub = document.createElement('span');
    sub.className = 'sw-sub';
    sub.textContent = item.sub;
    el.append(sub);

    el.onclick = () => { closeSwitcher(); selectSession(item.id); };
    box.appendChild(el);

    if (i === swIndex) {
      requestAnimationFrame(() => el.scrollIntoView({ block: 'nearest' }));
    }
  });
}

$('#switcher-input').addEventListener('input', (e) => {
  const val = e.target.value;
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => updateSwitcher(val), 150);
});

$('#switcher-input').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    swIndex = Math.min(swIndex + 1, swItems.length - 1);
    renderSwitcher();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    swIndex = Math.max(swIndex - 1, 0);
    renderSwitcher();
  } else if (e.key === 'Enter') {
    const item = swItems[swIndex];
    if (item) { closeSwitcher(); selectSession(item.id); }
  }
});

$('#switcher-context').addEventListener('click', (e) => showIdentityDetail(e.currentTarget));
$('#switcher').addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const details = $('#switcher-context');
    (document.activeElement === $('#switcher-input') && !details.disabled
      ? details : $('#switcher-input')).focus();
  }
});

/* ---------- Preset Preview & Launch Modal (F3) ---------- */

async function openPresetModal(projectId, presetName) {
  const modal = $('#preset-modal');
  if (!modal) return;

  const project = state.projects.find((p) => p.id === projectId);
  if (!project) return;

  $('#preset-modal-title').textContent = `Preset: ${presetName}`;
  $('#preset-modal-subtitle').textContent = `Loading configuration for ${project.name}…`;
  $('#preset-modal-source').textContent = '';
  $('#preset-modal-errors').classList.add('hidden');
  $('#preset-modal-entries').innerHTML = '<div style="padding: 20px; text-align: center; color: var(--muted); font-size: 12px;">Validating preset entries…</div>';
  $('#preset-modal-retry').classList.add('hidden');
  const launchBtn = $('#preset-modal-launch');
  launchBtn.disabled = true;
  launchBtn.textContent = 'Launch Preset';

  modal.hidden = false;
  const pendingModal = { projectId, presetName, isLaunching: false };
  activePresetModal = pendingModal;

  try {
    const preview = await window.hangar.previewPreset(projectId, presetName);
    if (activePresetModal !== pendingModal) return;
    activePresetModal = { projectId, presetName, preview, isLaunching: false, results: null };
    renderPresetModal();
  } catch (err) {
    $('#preset-modal-subtitle').textContent = 'Error previewing preset';
    const errEl = $('#preset-modal-errors');
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
    $('#preset-modal-entries').innerHTML = '';
  }
}

function renderPresetModal() {
  if (!activePresetModal) return;
  const { projectId, presetName, preview, isLaunching, results } = activePresetModal;
  const project = state.projects.find((p) => p.id === projectId);

  $('#preset-modal-title').textContent = `Preset: ${presetName}`;
  $('#preset-modal-subtitle').textContent = `${preview.entries.length} session${preview.entries.length === 1 ? '' : 's'} in ${project?.name || 'project'}`;
  $('#preset-modal-source').textContent = preview.source ? (preview.source.includes('.hangar.json') ? '.hangar.json' : 'presets.json') : '';

  const errorsBanner = $('#preset-modal-errors');
  if (preview.errors && preview.errors.length > 0) {
    errorsBanner.innerHTML = '';
    preview.errors.forEach((e) => {
      const row = document.createElement('div');
      row.textContent = `• ${e}`;
      errorsBanner.appendChild(row);
    });
    errorsBanner.classList.remove('hidden');
  } else {
    errorsBanner.classList.add('hidden');
  }

  const entriesContainer = $('#preset-modal-entries');
  entriesContainer.innerHTML = '';

  preview.entries.forEach((entry) => {
    const card = document.createElement('div');
    card.className = 'preset-entry-card' + (entry.valid ? '' : ' has-error');

    // Check if result exists
    const launchSuccess = results?.successful?.find((s) => s.index === entry.index);
    const launchFail = results?.failed?.find((f) => f.index === entry.index);
    if (launchSuccess) card.classList.add('launched');
    if (launchFail) card.classList.add('has-error');

    const icon = document.createElement('div');
    icon.className = 'preset-entry-icon';
    icon.style.setProperty('--entry-color', entry.agentColor);
    icon.innerHTML = entry.agentKind === 'shell' ? iconSvg('terminal') : '<span class="launcher-dot"></span>';

    const info = document.createElement('div');
    info.className = 'preset-entry-info';

    const titleRow = document.createElement('div');
    titleRow.className = 'preset-entry-title-row';
    const name = document.createElement('span');
    name.className = 'preset-entry-name';
    name.textContent = entry.title;
    const agentBadge = document.createElement('span');
    agentBadge.className = 'preset-entry-agent';
    agentBadge.textContent = `(${entry.agentLabel})`;
    titleRow.append(name, agentBadge);

    const meta = document.createElement('div');
    meta.className = 'preset-entry-meta';
    const pathSpan = document.createElement('span');
    pathSpan.className = 'preset-entry-path' + (entry.pathExists ? '' : ' missing');
    const folderIcon = document.createElement('span');
    folderIcon.innerHTML = iconSvg('folder', 'icon-sm');
    const pathText = document.createTextNode(' ' + (entry.resolvedPath || entry.relativePath));
    pathSpan.append(folderIcon, pathText);
    if (!entry.pathExists) {
      pathSpan.title = `Missing directory: ${entry.resolvedPath}`;
    }
    meta.appendChild(pathSpan);

    if (entry.command) {
      const cmdSpan = document.createElement('span');
      cmdSpan.className = 'preset-entry-cmd';
      cmdSpan.textContent = `$ ${entry.command}`;
      meta.appendChild(cmdSpan);
    }

    if (entry.note) {
      const noteSpan = document.createElement('span');
      noteSpan.className = 'preset-entry-note';
      noteSpan.style.color = 'var(--text-soft)';
      const pencilIcon = document.createElement('span');
      pencilIcon.innerHTML = iconSvg('pencil', 'icon-sm');
      const noteText = document.createTextNode(' ' + entry.note);
      noteSpan.append(pencilIcon, noteText);
      meta.appendChild(noteSpan);
    }

    if (launchFail) {
      const errSpan = document.createElement('div');
      errSpan.style.color = 'var(--danger)';
      errSpan.style.fontSize = '11px';
      errSpan.style.marginTop = '4px';
      errSpan.textContent = `Failed: ${launchFail.error}`;
      info.append(titleRow, meta, errSpan);
    } else {
      info.append(titleRow, meta);
    }

    const statusEl = document.createElement('div');
    statusEl.className = 'preset-entry-status';
    if (launchSuccess) {
      statusEl.innerHTML = iconSvg('check');
      statusEl.title = 'Launched';
      statusEl.style.color = 'var(--success)';
    } else if (launchFail) {
      statusEl.innerHTML = iconSvg('warning');
      statusEl.title = launchFail.error;
      statusEl.style.color = 'var(--danger)';
    } else if (!entry.valid) {
      statusEl.innerHTML = iconSvg('close');
      statusEl.title = entry.errors.join('; ');
      statusEl.style.color = 'var(--danger)';
    } else {
      statusEl.innerHTML = '<span class="status-dot status-idle"></span>';
      statusEl.title = 'Ready';
    }

    card.append(icon, info, statusEl);
    entriesContainer.appendChild(card);
  });

  const launchBtn = $('#preset-modal-launch');
  const retryBtn = $('#preset-modal-retry');

  if (isLaunching) {
    launchBtn.disabled = true;
    launchBtn.textContent = 'Launching…';
    retryBtn.classList.add('hidden');
  } else if (results && results.failed.length > 0) {
    launchBtn.disabled = true;
    launchBtn.textContent = 'Launch Preset';
    retryBtn.classList.remove('hidden');
    retryBtn.textContent = `Retry Failed (${results.failed.length})`;
  } else if (!preview.valid) {
    launchBtn.disabled = true;
    launchBtn.textContent = 'Cannot Launch (Errors)';
    retryBtn.classList.add('hidden');
  } else {
    launchBtn.disabled = false;
    launchBtn.textContent = `Launch Preset (${preview.entries.length})`;
    retryBtn.classList.add('hidden');
  }
}

async function doLaunchPreset(selectedIndices = null) {
  if (!activePresetModal || activePresetModal.isLaunching) return;
  activePresetModal.isLaunching = true;
  renderPresetModal();

  try {
    const res = await window.hangar.launchPreset(
      activePresetModal.projectId,
      activePresetModal.presetName,
      selectedIndices
    );
    activePresetModal.isLaunching = false;

    // Merge results if this was a retry
    if (activePresetModal.results) {
      const prevSuccess = activePresetModal.results.successful || [];
      const newSuccess = res.successful || [];
      activePresetModal.results = {
        successful: [...prevSuccess, ...newSuccess],
        failed: res.failed || [],
        state: res.state,
      };
    } else {
      activePresetModal.results = res;
    }

    if (res.state) {
      state = res.state;
      activeId = state.lastActiveSessionId;
      render();
      if (activeId) showTerm(activeId);
    }

    if (activePresetModal.results.failed.length === 0) {
      showToast(`Launched preset "${activePresetModal.presetName}" (${activePresetModal.results.successful.length} sessions)`);
      closePresetModal();
    } else {
      showToast(`Preset launched with ${activePresetModal.results.failed.length} error(s)`);
      renderPresetModal();
    }
  } catch (err) {
    activePresetModal.isLaunching = false;
    showError(err.message);
    renderPresetModal();
  }
}

function closePresetModal() {
  if (activePresetModal?.isLaunching) return;
  const modal = $('#preset-modal');
  if (modal) modal.hidden = true;
  activePresetModal = null;
}

$('#preset-modal-cancel')?.addEventListener('click', closePresetModal);
$('#preset-modal-launch')?.addEventListener('click', () => doLaunchPreset());
$('#preset-modal-retry')?.addEventListener('click', () => {
  if (activePresetModal?.results?.failed) {
    const retryIndices = activePresetModal.results.failed.map((f) => f.index);
    doLaunchPreset(retryIndices);
  }
});

/* ---------- Session Handoff Modal (F5) ---------- */

let activeHandoffSessionId = null;
let currentHandoffRawData = null;

function formatHandoffText(data, includeScrollback) {
  const lines = [
    `### Session Context Handoff`,
    `- **Session:** ${data.title} (${data.agentLabel})`,
    `- **Project:** ${data.projectName}${data.projectPath ? ` (\`${data.projectPath}\`)` : ''}`,
    `- **Working Directory:** \`${data.launchPath || 'unknown'}\``,
  ];

  if (data.note) {
    lines.push(`- **Task Note:** ${data.note}`);
  }

  lines.push(`- **Status:** ${data.status} (captured at ${data.captureTime})`);

  if (data.conversationId) lines.push(`- **Conversation ID:** ${data.conversationId}`);

  if (!includeScrollback && !data.isParked && data.scrollbackStatus !== 'error') {
    return lines.join('\n');
  }

  if (data.isParked) {
    lines.push('', `*(Live terminal output unavailable: session is parked)*`);
  } else if (data.scrollbackStatus === 'error') {
    lines.push('', `*(Failed to capture terminal output: ${data.scrollbackError || 'unknown error'})*`);
  } else if (data.scrollbackStatus === 'empty' || !data.scrollback) {
    lines.push('', `*(Terminal scrollback is empty)*`);
  } else {
    lines.push('', `#### Terminal Output:`, '```text');
    if (data.scrollbackTruncated) {
      lines.push(`[... earlier output omitted; showing the last ${data.scrollbackLines} lines ...]`);
    }
    lines.push(data.scrollback);
    lines.push('```');
  }

  return lines.join('\n');
}

function updateHandoffInfo() {
  const textarea = $('#handoff-text');
  const infoEl = $('#handoff-info');
  if (textarea && infoEl) {
    const chars = textarea.value.length;
    const lines = textarea.value ? textarea.value.split('\n').length : 0;
    infoEl.textContent = `${lines} lines · ${chars} characters`;
  }
}

async function openHandoffModal(sessionId) {
  const modal = $('#handoff-modal');
  if (!modal) return;

  activeHandoffSessionId = sessionId;
  currentHandoffRawData = null;

  const badgeEl = $('#handoff-session-badge');
  const indicatorEl = $('#handoff-status-indicator');
  const checkbox = $('#handoff-include-scrollback');
  const textarea = $('#handoff-text');
  const copyBtn = $('#handoff-modal-copy');
  const infoEl = $('#handoff-info');

  if (badgeEl) badgeEl.textContent = '…';
  if (indicatorEl) indicatorEl.textContent = 'Capturing session context…';
  if (checkbox) {
    checkbox.checked = true;
    checkbox.disabled = true;
  }
  if (textarea) {
    textarea.value = 'Generating session context handoff…';
    textarea.disabled = true;
  }
  if (copyBtn) copyBtn.disabled = true;
  if (infoEl) infoEl.textContent = '';

  modal.hidden = false;

  try {
    const data = await window.hangar.getSessionHandoff(sessionId);
    if (activeHandoffSessionId !== sessionId) return;

    currentHandoffRawData = data;

    if (badgeEl) badgeEl.textContent = data.agentLabel;
    if (checkbox) {
      if (data.isParked) {
        checkbox.checked = false;
        checkbox.disabled = true;
        if (indicatorEl) indicatorEl.textContent = 'Parked session (no live terminal)';
      } else if (data.scrollbackStatus === 'error') {
        checkbox.checked = false;
        checkbox.disabled = true;
        if (indicatorEl) indicatorEl.textContent = `Capture error: ${data.scrollbackError || 'unknown'}`;
      } else if (data.scrollbackStatus === 'empty') {
        checkbox.checked = true;
        checkbox.disabled = false;
        if (indicatorEl) indicatorEl.textContent = 'Terminal scrollback empty';
      } else {
        checkbox.checked = true;
        checkbox.disabled = false;
        if (indicatorEl) {
          indicatorEl.textContent = `${data.scrollbackLines} lines captured (full scrollback)`;
        }
      }
    }

    if (textarea) {
      textarea.value = formatHandoffText(data, checkbox ? checkbox.checked : true);
      textarea.disabled = false;
      textarea.focus();
    }
    if (copyBtn) copyBtn.disabled = false;
    updateHandoffInfo();
  } catch (err) {
    if (activeHandoffSessionId !== sessionId) return;
    if (indicatorEl) indicatorEl.textContent = `Failed to generate handoff: ${err.message}`;
    if (textarea) {
      textarea.value = `Error generating handoff: ${err.message}`;
      textarea.disabled = true;
    }
    if (copyBtn) copyBtn.disabled = true;
  }
}

function closeHandoffModal() {
  const modal = $('#handoff-modal');
  if (modal) modal.hidden = true;
  activeHandoffSessionId = null;
  currentHandoffRawData = null;
}

$('#handoff-modal-cancel')?.addEventListener('click', closeHandoffModal);

$('#handoff-include-scrollback')?.addEventListener('change', (e) => {
  if (!currentHandoffRawData) return;
  const textarea = $('#handoff-text');
  if (textarea) {
    textarea.value = formatHandoffText(currentHandoffRawData, e.target.checked);
    updateHandoffInfo();
  }
});

$('#handoff-text')?.addEventListener('input', updateHandoffInfo);

$('#handoff-modal-copy')?.addEventListener('click', () => {
  const textarea = $('#handoff-text');
  if (!textarea || !textarea.value) return;
  try {
    window.hangar.copyText(textarea.value);
    showToast('Session handoff copied to clipboard');
    closeHandoffModal();
  } catch (err) {
    showError(`Failed to copy to clipboard: ${err.message}`);
  }
});

/* ---------- Project Actions ---------- */

const addProjectHandler = async () => {
  try {
    state = await window.hangar.addProject();
    render();
  } catch (err) {
    showError(err.message);
  }
};

$('#add-project').onclick = addProjectHandler;
$('#empty-add-project').onclick = addProjectHandler;

/* ---------- Global State Listeners & Boot ---------- */

window.hangar.onStateChanged((s) => {
  applyAppearance(s.appearance);
  state = s;
  applyScreenReader();
  // Only an explicit `focusSession` moves the selection. Following
  // `lastActiveSessionId` instead meant every broadcast that happened to carry a
  // different one — a reconcile after a session died, say — silently switched
  // the user to another terminal.
  if (s.focusSession && s.focusSession !== activeId) {
    selectSession(s.focusSession);
  } else {
    render();
  }
});

(async () => {
  mountStaticIcons();
  if (document.fonts) {
    try { await document.fonts.ready; } catch {}
  }
  try {
    setSidebarCollapsed(localStorage.getItem(SIDEBAR_KEY) === '1');
  } catch {
    setSidebarCollapsed(false);
  }

  setInspectorVisible(localStorage.getItem('hangar.inspectorHidden') !== '1');

  try {
    state = await window.hangar.getState();
    applyAppearance(state.appearance);
  } catch (err) {
    showError(`Failed to load state: ${err.message}`);
  }
  await Promise.all(state.sessions.filter((s) => !s.pending).map(async (session) => {
    const previous = statusMetadata[session.id];
    try {
      const details = await window.hangar.getStatusDetails(session.id);
      if (details && statusMetadata[session.id] === previous) {
        statuses[session.id] = details.status;
        statusMetadata[session.id] = details;
      }
    } catch {}
  }));
  activeId = state.lastActiveSessionId ?? state.sessions[0]?.id ?? null;
  render();
  // A stopped selection displays saved context; app launch starts no CLI.
  const activeSession = state.sessions.find((s) => s.id === activeId);
  if (activeSession?.pending) { render(); }
  else if (activeSession) showTerm(activeId);
  refreshPorts();
  setInterval(refreshPorts, 5000);
})();
