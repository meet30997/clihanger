'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadAgents } = require('./agents');

const HANGAR_DIR = path.join(os.homedir(), '.hangar');
const GLOBAL_PRESETS_FILE = path.join(HANGAR_DIR, 'presets.json');

/**
 * Load raw presets configured for a project.
 * Checks project-local <projectPath>/.hangar.json first,
 * then checks ~/.hangar/presets.json for fallback / global project presets.
 *
 * @param {string} projectPath Absolute path to project directory
 * @param {string} [projectName] Project display name
 * @returns {{ presets: Record<string, any[]>, source: string | null, error?: string }}
 */
function loadProjectPresets(projectPath, projectName) {
  const result = { presets: {}, source: null };
  let localFound = false;

  // 1. Check project-local .hangar.json
  if (projectPath && typeof projectPath === 'string') {
    const localFile = path.join(projectPath, '.hangar.json');
    if (fs.existsSync(localFile)) {
      try {
        const raw = fs.readFileSync(localFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          if (parsed.presets && typeof parsed.presets === 'object' && !Array.isArray(parsed.presets)) {
            result.presets = { ...parsed.presets };
            result.source = localFile;
            localFound = true;
          } else {
            result.error = 'Invalid .hangar.json: "presets" must be an object keyed by preset name';
          }
        } else {
          result.error = 'Invalid .hangar.json: expected an object';
        }
      } catch (err) {
        result.error = `Failed to parse .hangar.json: ${err.message}`;
      }
    }
  }

  // 2. Check global ~/.hangar/presets.json
  if (fs.existsSync(GLOBAL_PRESETS_FILE)) {
    try {
      const raw = fs.readFileSync(GLOBAL_PRESETS_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      const projects = parsed?.projects || parsed;
      if (!projects || typeof projects !== 'object' || Array.isArray(projects)) {
        result.error = result.error || 'Invalid presets.json: projects must be an object';
      } else {
        const projectKey = (projectPath && projects[projectPath])
          ? projectPath
          : (projectName && projects[projectName])
            ? projectName
            : (projectPath && projects[path.basename(projectPath)])
              ? path.basename(projectPath)
              : null;

        if (projectKey && projects[projectKey]) {
          const globalForProject = projects[projectKey];
          if (globalForProject && typeof globalForProject === 'object' && !Array.isArray(globalForProject)) {
            // Project-local presets take precedence over global ones
            result.presets = { ...globalForProject, ...result.presets };
            if (!localFound) result.source = GLOBAL_PRESETS_FILE;
          } else {
            result.error = result.error || `Invalid presets.json: project ${projectKey} must contain a preset object`;
          }
        }
      }
    } catch (err) {
      if (!result.error) {
        result.error = `Failed to parse ~/.hangar/presets.json: ${err.message}`;
      }
    }
  }

  return result;
}

/**
 * Validate and resolve a list of preset session entries against project path and loaded agents.
 * Pure validation: does not spawn processes or start sessions.
 *
 * @param {string} projectPath
 * @param {string} presetName
 * @param {any[]} rawEntries
 * @param {Record<string, any>} [agentsMap]
 * @returns {{ valid: boolean, errors: string[], entries: any[] }}
 */
function validatePreset(projectPath, presetName, rawEntries, agentsMap = null) {
  const agents = agentsMap || loadAgents();
  const errors = [];
  const resolvedEntries = [];

  if (!Array.isArray(rawEntries)) {
    return {
      valid: false,
      errors: [`Preset "${presetName}" entries must be an array`],
      entries: [],
    };
  }

  if (rawEntries.length === 0) {
    return {
      valid: false,
      errors: [`Preset "${presetName}" has no session entries configured`],
      entries: [],
    };
  }

  rawEntries.forEach((raw, idx) => {
    const entryErrors = [];
    const index = idx + 1;

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`Entry #${index}: must be an object`);
      return;
    }

    // 1. Agent validation
    const agentId = raw.agentId;
    if (!agentId || typeof agentId !== 'string' || !agentId.trim()) {
      entryErrors.push(`Entry #${index}: missing "agentId"`);
    } else if (!Object.hasOwn(agents, agentId.trim())) {
      entryErrors.push(`Entry #${index}: unknown agent "${agentId.trim()}" (not found in agents.json)`);
    }
    const cleanAgentId = agentId && typeof agentId === 'string' ? agentId.trim() : null;
    const agent = cleanAgentId ? agents[cleanAgentId] : null;

    for (const field of ['path', 'command', 'title', 'note']) {
      if (raw[field] !== undefined && typeof raw[field] !== 'string') {
        entryErrors.push(`Entry #${index}: "${field}" must be a string`);
      }
    }

    // 2. Working directory resolution & check
    const rawPath = typeof raw.path === 'string' && raw.path.trim() ? raw.path.trim() : '.';
    let resolvedPath = null;
    let pathExists = false;
    let pathIsDirectory = false;

    if (projectPath && typeof projectPath === 'string') {
      try {
        resolvedPath = path.resolve(projectPath, rawPath);
        if (fs.existsSync(resolvedPath)) {
          pathExists = true;
          const stat = fs.statSync(resolvedPath);
          pathIsDirectory = stat.isDirectory();
          if (!pathIsDirectory) {
            entryErrors.push(`Entry #${index}: path "${rawPath}" is a file, not a directory`);
          }
        } else {
          entryErrors.push(`Entry #${index}: directory "${rawPath}" does not exist (${resolvedPath})`);
        }
      } catch (err) {
        entryErrors.push(`Entry #${index}: invalid path "${rawPath}": ${err.message}`);
      }
    } else {
      entryErrors.push(`Entry #${index}: cannot resolve path because project path is missing`);
    }

    // 3. Command check (only shell / terminal agents support custom startup commands)
    const rawCommand = typeof raw.command === 'string' && raw.command.trim() ? raw.command.trim() : null;
    let commandAllowed = true;
    if (rawCommand) {
      const isShell = agent && (agent.kind === 'shell' || !agent.command);
      if (!isShell) {
        commandAllowed = false;
        entryErrors.push(`Entry #${index}: custom "command" is only supported for shell/terminal agents (agent "${cleanAgentId}" is an agent CLI)`);
      }
    }

    // 4. Title & Note
    const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 100) : null;
    const note = typeof raw.note === 'string' && raw.note.trim() ? raw.note.trim().slice(0, 500) : null;

    if (entryErrors.length > 0) {
      errors.push(...entryErrors);
    }

    resolvedEntries.push({
      index: idx,
      agentId: cleanAgentId,
      agentLabel: agent?.label || cleanAgentId || 'Unknown',
      agentColor: agent?.color || '#7b7b7c',
      agentKind: agent?.kind || 'agent',
      title: title || agent?.label || 'Session',
      note,
      relativePath: rawPath,
      resolvedPath,
      pathExists,
      pathIsDirectory,
      command: rawCommand || agent?.command || null,
      commandAllowed,
      valid: entryErrors.length === 0,
      errors: entryErrors,
    });
  });

  return {
    valid: errors.length === 0,
    errors,
    entries: resolvedEntries,
  };
}

/**
 * Preview a specific preset for a project. Upfront validation only.
 *
 * @param {string} projectPath
 * @param {string} projectName
 * @param {string} presetName
 * @returns {{ presetName: string, valid: boolean, errors: string[], entries: any[], source: string | null }}
 */
function previewPreset(projectPath, projectName, presetName) {
  const { presets, source, error } = loadProjectPresets(projectPath, projectName);
  if (error) {
    return {
      presetName,
      valid: false,
      errors: [error],
      entries: [],
      source,
    };
  }

  const rawEntries = presets[presetName];
  if (!rawEntries) {
    return {
      presetName,
      valid: false,
      errors: [`Preset "${presetName}" not found for this project`],
      entries: [],
      source,
    };
  }

  const validation = validatePreset(projectPath, presetName, rawEntries);
  return {
    presetName,
    valid: validation.valid,
    errors: validation.errors,
    entries: validation.entries,
    source,
  };
}

module.exports = {
  loadProjectPresets,
  validatePreset,
  previewPreset,
  GLOBAL_PRESETS_FILE,
};
