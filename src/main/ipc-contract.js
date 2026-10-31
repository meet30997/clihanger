'use strict';

/**
 * Authoritative executable top-level IPC contract.
 *
 * Defines and enforces the IPC surface across the application.
 * main.js and preload.js validate live traffic against this registry on both sides.
 */

const nothing = () => ({ kind: 'void' });
const object = (required, optional = [], nullable = false) => ({
  kind: 'object', required, optional, nullable,
});
const array = (required, optional = []) => ({
  kind: 'array', required, optional,
});

const state = (extraOptional = []) => object(
  ['version', 'projects', 'sessions', 'lastActiveSessionId', 'agents', 'appearance'],
  ['noTmux', 'screenReader', ...extraOptional]
);

const invokes = {
  'state:get':             { request: nothing(), response: state() },
  'agents:get':            { request: nothing(), response: object(['json', 'revision', 'agents'], ['error']) },
  'agents:preview':        { request: object(['json']), response: object(['valid', 'agents', 'previews'], ['error']) },
  'agents:save':           { request: object(['json', 'revision']), response: object(['ok'], ['configuration', 'error']) },
  'project:add':           { request: nothing(), response: state() },
  'project:remove':        { request: object(['projectId']), response: state() },
  'project:move':          { request: object(['projectId', 'beforeProjectId']), response: state() },
  'session:move':          { request: object(['sessionId', 'beforeSessionId']), response: state() },
  'session:create':        { request: object(['projectId', 'agentId'], ['branch']), response: state() },
  'session:rename':        { request: object(['sessionId', 'title']), response: state() },
  'session:history':       { request: object(['sessionId']), response: array(['conversationId', 'title', 'createdAt', 'updatedAt']) },
  'session:link-history':  { request: object(['sessionId', 'conversationId']), response: state() },
  'session:note':          { request: object(['sessionId', 'note']), response: state() },
  'session:conversation':  { request: object(['sessionId', 'conversationId']), response: state() },
  'status:snooze':         { request: object(['sessionId', 'snoozed']), response: object(['ok', 'snoozed']) },
  'status:details':        { request: object(['sessionId']), response: object(
    ['status', 'waitingSince', 'snoozed', 'transitionedAt', 'reason', 'tailExcerpt', 'source'], ['promptKind', 'seen', 'stale'], true
  ) },
  'session:kill':          { request: object(['sessionId']), response: state(['lastWarning']) },
  'session:viewing':       { request: object(['sessionId']), response: nothing() },
  'term:open':             { request: object(['sessionId', 'cols', 'rows'], ['resume']), response: object(['ok'], ['error']) },
  'term:input':            { request: object(['sessionId', 'data'], ['chatTitle']), response: nothing() },
  'term:resize':           { request: object(['sessionId', 'cols', 'rows']), response: nothing() },
  'term:close':            { request: object(['sessionId']), response: nothing() },
  'term:copy-selection':   { request: object(['sessionId']), response: object(['copied']) },
  'term:clear':            { request: object(['sessionId']), response: object(['ok']) },
  'term:move-cursor':      { request: object(['sessionId', 'fromCol', 'fromRow', 'toRow', 'chars']), response: object(['moved']) },
  'term:search':           { request: object(['sessionId', 'query', 'direction']), response: object(
    ['matchCount', 'inCopyMode', 'scrollPosition']
  ) },
  'term:scroll-state':     { request: object(['sessionId']), response: object(['inCopyMode', 'scrollPosition']) },
  'term:scroll-bottom':    { request: object(['sessionId']), response: object(['inCopyMode', 'scrollPosition']) },
  'term:context-menu':     { request: object(['sessionId', 'hasSelection'], ['linkUrl']), response: nothing() },
  'ports:list':            { request: nothing(), response: array(
    ['port', 'pid', 'command', 'address', 'sessionId', 'agentId', 'projectName']
  ) },
  'ports:kill':            { request: object(['pid']), response: object(['ok', 'message']) },
  'url:open':              { request: object(['url']), response: object(['ok']) },
  'session:search':        { request: object(['query']), response: array(
    ['sessionId', 'title', 'agentId', 'projectName', 'matchCount', 'matches']
  ) },
  'preset:list':           { request: object(['projectId']), response: object(['presets', 'source'], ['error']) },
  'preset:preview':        { request: object(['projectId', 'presetName']), response: object(
    ['presetName', 'valid', 'errors', 'entries', 'source']
  ) },
  'preset:launch':         { request: object(['projectId', 'presetName'], ['selectedIndices']), response: object(
    ['successful', 'failed', 'state']
  ) },
  'session:handoff':       { request: object(['sessionId'], ['lines']), response: object([
    'sessionId', 'title', 'agentId', 'agentLabel', 'projectName', 'projectPath', 'launchPath',
    'worktreePath', 'note', 'conversationId', 'status', 'isParked', 'captureTime', 'scrollback',
    'scrollbackLines', 'scrollbackTruncated', 'scrollbackStatus', 'scrollbackError', 'formattedMarkdown',
  ]) },
};

const events = {
  'term:data':      object(['sessionId', 'data']),
  'state:changed':  state(['focusSession']),
  'status:changed': object(['sessionId', 'status'], ['waitingSince', 'snoozed', 'promptKind', 'seen', 'stale', 'reason', 'tailExcerpt']),
  'term:context-action': object(['sessionId', 'action'], ['linkUrl']),
};

function validateShape(value, shape, label) {
  if (shape.kind === 'void') {
    if (value !== undefined) throw new TypeError(`${label} must be empty`);
    return value;
  }

  if (shape.kind === 'array') {
    if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
    value.forEach((item, index) => validateObject(item, shape, `${label}[${index}]`));
    return value;
  }

  if (shape.nullable && value === null) return value;
  validateObject(value, shape, label);
  return value;
}

function validateObject(value, shape, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }

  const allowed = new Set([...shape.required, ...shape.optional]);
  const keys = Object.keys(value);
  const missing = shape.required.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  const extra = keys.filter((key) => !allowed.has(key));
  if (missing.length || extra.length) {
    const details = [];
    if (missing.length) details.push(`missing ${missing.join(', ')}`);
    if (extra.length) details.push(`undocumented ${extra.join(', ')}`);
    throw new TypeError(`${label} shape mismatch (${details.join('; ')})`);
  }
}

function invokeShape(channel) {
  const shape = invokes[channel];
  if (!shape) throw new TypeError(`Undocumented invoke channel: ${channel}`);
  return shape;
}

function validateInvokeRequest(channel, payload) {
  return validateShape(payload, invokeShape(channel).request, `${channel} request`);
}

function validateInvokeResponse(channel, payload) {
  return validateShape(payload, invokeShape(channel).response, `${channel} response`);
}

function validateEvent(channel, payload) {
  const shape = events[channel];
  if (!shape) throw new TypeError(`Undocumented event channel: ${channel}`);
  return validateShape(payload, shape, `${channel} event`);
}

module.exports = {
  invokes,
  events,
  validateShape,
  validateInvokeRequest,
  validateInvokeResponse,
  validateEvent,
};
