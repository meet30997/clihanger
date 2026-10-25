'use strict';

const { clipboard, contextBridge, ipcRenderer, webUtils } = require('electron');
const {
  validateInvokeRequest,
  validateInvokeResponse,
  validateEvent,
} = require('./ipc-contract');

function invokeChecked(channel, payload) {
  validateInvokeRequest(channel, payload);
  return ipcRenderer.invoke(channel, payload).then((result) => {
    validateInvokeResponse(channel, result);
    return result;
  });
}

contextBridge.exposeInMainWorld('hangar', {
  // State agent data may include a bundled icon descriptor (file, monochrome).
  getState:      ()               => invokeChecked('state:get'),
  addProject:    ()               => invokeChecked('project:add'),
  removeProject: (projectId)      => invokeChecked('project:remove', { projectId }),
  moveProject:   (projectId, beforeProjectId) =>
                                     invokeChecked('project:move', { projectId, beforeProjectId }),
  moveSession:   (sessionId, beforeSessionId) =>
                                     invokeChecked('session:move', { sessionId, beforeSessionId }),
  createSession: (projectId, agentId, branch) =>
                                     invokeChecked('session:create', { projectId, agentId, branch }),
  renameSession: (sessionId, title) =>
                                     invokeChecked('session:rename', { sessionId, title }),
  listSessionHistory: (sessionId) => invokeChecked('session:history', { sessionId }),
  linkSessionHistory: (sessionId, conversationId) =>
                                     invokeChecked('session:link-history', { sessionId, conversationId }),
  setSessionNote: (sessionId, note) =>
                                     invokeChecked('session:note', { sessionId, note }),
  setSessionConversation: (sessionId, conversationId) =>
                                     invokeChecked('session:conversation', { sessionId, conversationId }),
  setViewing:   (sessionId)      => invokeChecked('session:viewing', { sessionId }),
  snoozeStatus: (sessionId, snoozed) =>
                                     invokeChecked('status:snooze', { sessionId, snoozed }),
  getStatusDetails: (sessionId) =>
                                     invokeChecked('status:details', { sessionId }),
  searchScrollback: (query)       => invokeChecked('session:search', { query }),
  killSession:   (sessionId)      => invokeChecked('session:kill', { sessionId }),
  getSessionHandoff: (sessionId, lines) =>
                                     invokeChecked('session:handoff', { sessionId, lines }),

  // presets — Phase 2 (F3)
  listPresets:   (projectId)      => invokeChecked('preset:list', { projectId }),
  previewPreset: (projectId, presetName) =>
                                     invokeChecked('preset:preview', { projectId, presetName }),
  launchPreset:  (projectId, presetName, selectedIndices) =>
                                     invokeChecked('preset:launch', { projectId, presetName, selectedIndices }),

  // terminal — wired up in Phase 3
  termOpen:   (sessionId, cols, rows, resume) =>
                                     invokeChecked('term:open', { sessionId, cols, rows, resume }),
  termInput:  (sessionId, data, chatTitle) => invokeChecked('term:input', { sessionId, data, chatTitle }),
  termResize: (sessionId, cols, rows) => invokeChecked('term:resize', { sessionId, cols, rows }),
  termClose:  (sessionId)             => invokeChecked('term:close', { sessionId }),
  clearTerminal: (sessionId)          => invokeChecked('term:clear', { sessionId }),
  moveTerminalCursor: (sessionId, fromCol, fromRow, toRow, chars) =>
                                     invokeChecked('term:move-cursor', { sessionId, fromCol, fromRow, toRow, chars }),
  searchTerminal: (sessionId, query, direction) =>
                                     invokeChecked('term:search', { sessionId, query, direction }),
  getTerminalScrollState: (sessionId) => invokeChecked('term:scroll-state', { sessionId }),
  scrollTerminalToBottom: (sessionId) => invokeChecked('term:scroll-bottom', { sessionId }),
  showTerminalContextMenu: (sessionId, hasSelection, linkUrl) =>
                                     invokeChecked('term:context-menu', { sessionId, hasSelection, linkUrl }),
  copyText:   (text)                  => {
    if (typeof text === 'string' && text.length > 0) clipboard.writeText(text);
  },
  readClipboardText: ()               => clipboard.readText(),
  // File.path is gone since Electron 32; a dropped File's path comes from here.
  pathForFile: (file)                 => webUtils.getPathForFile(file),

  // ports — Phase 4
  listPorts: ()    => invokeChecked('ports:list'),
  killPort:  (pid) => invokeChecked('ports:kill', { pid }),
  openUrl:   (url) => invokeChecked('url:open', { url }),

  // State rows carry autoTitle and its optional autoTitleConversationId source
  // alongside the explicit title. Preserve these during live metadata updates.
  // events from main
  onStateChanged:  (cb) => ipcRenderer.on('state:changed',  (_e, s) => cb(validateEvent('state:changed', s))),
  onTermData:      (cb) => ipcRenderer.on('term:data',      (_e, p) => cb(validateEvent('term:data', p))),
  onStatusChanged: (cb) => ipcRenderer.on('status:changed', (_e, p) => cb(validateEvent('status:changed', p))),
  onTermContextAction: (cb) => ipcRenderer.on('term:context-action', (_e, p) => cb(validateEvent('term:context-action', p))),
});
