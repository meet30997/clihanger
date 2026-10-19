'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { fileURLToPath } = require('url');
const transcriptCache = new Map();
const activityCache = new Map();

function cleanTitle(value) {
  return [...String(value || '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim()]
    .slice(0, 100).join('');
}

function timestamp(value) {
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sameProject(candidate, projectPath) {
  try {
    const pathname = candidate.startsWith('file:') ? fileURLToPath(candidate) : candidate;
    return path.resolve(pathname) === path.resolve(projectPath);
  } catch { return false; }
}

async function readTranscript(filename) {
  const info = await fs.promises.stat(filename);
  if (info.size > 25 * 1024 * 1024) return null;
  const signature = `${info.size}:${info.mtimeMs}`;
  const cached = transcriptCache.get(filename);
  if (cached?.signature === signature) return cached.value;
  const stream = fs.createReadStream(filename, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let firstMessage = '', named = '', createdAt = null, updatedAt = null, conversationId = null;
  const messages = [];
  try {
    for await (const line of lines) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      conversationId ||= row.sessionId;
      const time = timestamp(row.timestamp);
      if (time !== null) {
        createdAt = createdAt === null ? time : Math.min(createdAt, time);
        updatedAt = updatedAt === null ? time : Math.max(updatedAt, time);
      }
      if (row.type === 'custom-title' && row.customTitle) named = cleanTitle(row.customTitle);
      if (row.type === 'summary' && row.summary && !named) named = cleanTitle(row.summary);
      if (row.type === 'user') {
        const content = row.message?.content;
        const text = typeof content === 'string' ? content : Array.isArray(content)
          ? content.filter((part) => part.type === 'text').map((part) => part.text).join(' ') : '';
        if (text && !text.trim().startsWith('<')) {
          firstMessage ||= cleanTitle(text);
          messages.push({ text: cleanTitle(text), at: time });
          if (messages.length > 32) messages.shift();
        }
      }
    }
  } finally { lines.close(); stream.destroy(); }
  const title = named || firstMessage;
  const value = conversationId && title ? { conversationId, title, createdAt, updatedAt, firstMessage, messages } : null;
  if (transcriptCache.size >= 256) transcriptCache.delete(transcriptCache.keys().next().value);
  transcriptCache.set(filename, { signature, value });
  return value;
}

async function readActivity(config) {
  if (!config?.path) return new Map();
  const filename = config.path.replace(/^~(?=\/)/, os.homedir());
  let info;
  try { info = await fs.promises.stat(filename); } catch (err) {
    if (err.code === 'ENOENT') return new Map();
    throw err;
  }
  const signature = `${info.size}:${info.mtimeMs}:${JSON.stringify(config)}`;
  const cached = activityCache.get(filename);
  if (cached?.signature === signature) return cached.messages;
  const length = Math.min(info.size, 4 * 1024 * 1024);
  const file = await fs.promises.open(filename, 'r');
  const bytes = Buffer.alloc(length);
  try { await file.read(bytes, 0, length, info.size - length); } finally { await file.close(); }
  let text = bytes.toString('utf8');
  if (info.size > length) text = text.slice(text.indexOf('\n') + 1);
  const messages = new Map();
  for (const line of text.split('\n')) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const id = row[config.idField];
    const content = row[config.textField];
    if (!id || typeof content !== 'string' || content.startsWith('/')) continue;
    const rawTime = row[config.timestampField];
    const at = timestamp(config.timestampUnit === 'seconds' ? Number(rawTime) * 1000 : rawTime);
    const entries = messages.get(String(id)) || [];
    entries.push({ text: cleanTitle(content), at });
    if (entries.length > 32) entries.splice(1, 1);
    messages.set(String(id), entries);
  }
  if (activityCache.size >= 256) activityCache.delete(activityCache.keys().next().value);
  activityCache.set(filename, { signature, messages });
  return messages;
}

async function list(projectPath, config) {
  if (!config || typeof config.path !== 'string' || !projectPath) return [];
  const projectKey = projectPath.replace(/[^a-zA-Z0-9]/g, '-');
  const filename = config.path.replace(/^~(?=\/)/, os.homedir()).replace('{projectKey}', projectKey);
  if (!fs.existsSync(filename)) return [];
  let candidates;
  if (config.format === 'sqlite') {
    // Native stores are always opened read-only. SQL and paths are trusted
    // agent configuration; project values remain bound parameters.
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(filename, { readOnly: true });
    try {
      candidates = db.prepare(config.query).all({ $projectPath: projectPath }).filter((row) => {
        if (row.projectPath) return sameProject(row.projectPath, projectPath);
        try { return JSON.parse(row.projectPaths).some((item) => sameProject(item, projectPath)); }
        catch { return false; }
      });
    } finally { db.close(); }
  } else if (config.format === 'transcript-jsonl') {
    const names = (await fs.promises.readdir(filename)).filter((name) => name.endsWith('.jsonl'));
    const files = await Promise.all(names.map(async (name) => ({
      filename: path.join(filename, name), mtime: (await fs.promises.stat(path.join(filename, name))).mtimeMs,
    })));
    candidates = [];
    for (const file of files.sort((a, b) => b.mtime - a.mtime).slice(0, 100)) {
      const candidate = await readTranscript(file.filename);
      if (candidate) candidates.push(candidate);
    }
  } else { return []; }
  const activity = await readActivity(config.activity);
  return candidates.filter((row) => typeof row.conversationId === 'string' && row.conversationId.trim())
    .map((row) => ({
    conversationId: String(row.conversationId), title: cleanTitle(row.title),
    createdAt: timestamp(row.createdAt), updatedAt: timestamp(row.updatedAt),
    messages: [...(row.messages || []), ...(row.firstMessage
      ? [{ text: cleanTitle(row.firstMessage), at: timestamp(row.createdAt) }] : []),
      ...(activity.get(String(row.conversationId)) || [])],
  })).filter((row) => row.title && row.conversationId)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

// Historical rows never recorded the native ID. A unique native creation in
// the two minutes following launch can recover a label, not a resume link.
function creationMatch(session, candidates) {
  const matches = candidates.filter((row) => row.createdAt !== null &&
    row.createdAt >= session.createdAt - 2000 && row.createdAt <= session.createdAt + 120000);
  return matches.length === 1 ? matches[0] : null;
}

function submissionMatch(submission, candidates) {
  if (!submission) return null;
  const text = cleanTitle(submission.text);
  const matches = candidates.filter((row) => row.messages?.some((message) => message.text === text &&
    message.at !== null && message.at >= submission.at - 2000 && message.at <= submission.at + 120000));
  return matches.length === 1 ? matches[0] : null;
}

module.exports = { list, creationMatch, submissionMatch, cleanTitle };
