'use strict';

// Pure command composition, shared by launchers and Settings previews.
function quoteArg(value) {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function validateOptions(agent, label = 'Agent') {
  if (agent.launchOptions === undefined) return;
  const options = agent.launchOptions;
  if (!Array.isArray(options) || options.length > 5) {
    throw new Error(`${label}: launchOptions must be an array of at most five options`);
  }
  if (options.length && (agent.kind === 'shell' || !agent.command?.trim())) {
    throw new Error(`${label}: launch options require an agent command, not a plain shell`);
  }
  const ids = new Set();
  const groups = new Set();
  for (const option of options) {
    if (!option || typeof option !== 'object' || Array.isArray(option)
      || typeof option.id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(option.id) || ids.has(option.id)) {
      throw new Error(`${label}: each launch option needs a unique id (letters, numbers, hyphens)`);
    }
    ids.add(option.id);
    if (typeof option.label !== 'string' || !option.label.trim() || option.label.length > 120) {
      throw new Error(`${label}/${option.id}: label must be 1–120 characters`);
    }
    if (!Array.isArray(option.args) || !option.args.length || option.args.length > 32
      || option.args.some((arg) => typeof arg !== 'string' || arg.length > 4096 || /[\x00-\x1f\x7f]/.test(arg))) {
      throw new Error(`${label}/${option.id}: args must contain 1–32 single-line strings`);
    }
    for (const key of ['enabled', 'dangerous']) {
      if (option[key] !== undefined && typeof option[key] !== 'boolean') {
        throw new Error(`${label}/${option.id}: ${key} must be a boolean`);
      }
    }
    if (option.description !== undefined && (typeof option.description !== 'string' || option.description.length > 500)) {
      throw new Error(`${label}/${option.id}: description must be a string of at most 500 characters`);
    }
    if (option.group !== undefined && (typeof option.group !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(option.group))) {
      throw new Error(`${label}/${option.id}: group must use letters, numbers and hyphens`);
    }
    if (option.appliesTo !== undefined && (!Array.isArray(option.appliesTo) || !option.appliesTo.length
      || option.appliesTo.some((mode) => !['fresh', 'resume'].includes(mode)))) {
      throw new Error(`${label}/${option.id}: appliesTo must contain fresh and/or resume`);
    }
    if (option.enabled && option.group) {
      // Treat groups as exclusive even if their modes do not overlap. The UI
      // uses the same rule, so a JSON edit cannot create hidden conflicts.
      if (groups.has(option.group)) throw new Error(`${label}: only one option in group ${option.group} may be enabled`);
      groups.add(option.group);
    }
  }
}

function optionArgs(agent, mode = 'fresh') {
  validateOptions(agent);
  return (agent.launchOptions || [])
    .filter((option) => option.enabled && (!option.appliesTo || option.appliesTo.includes(mode)))
    .flatMap((option) => option.args).map(quoteArg).join(' ');
}

function applyLaunchOptions(agent, command = agent.command, mode = 'fresh') {
  const args = optionArgs(agent, mode);
  if (!command?.trim()) return command || '';
  return args ? `${command.trim()} ${args}` : command;
}

// A command written before launch options existed may carry an option's flags
// directly ("agy --dangerously-skip-permissions"). When the command is exactly
// the base command followed by whole option arg runs, return those options with
// the matching ones enabled; otherwise null. Only plain tokens are considered.
function migrateBakedOptions(command, baseCommand, options) {
  if (typeof command !== 'string' || !Array.isArray(options) || !options.length) return null;
  const base = baseCommand.trim();
  if (!base || !command.trim().startsWith(base + ' ')) return null;
  const rest = command.trim().slice(base.length).trim().split(/\s+/);
  if (rest.some((token) => !/^[A-Za-z0-9._\/=:-]+$/.test(token))) return null;
  const enabled = new Set();
  const groups = new Set();
  let i = 0;
  while (i < rest.length) {
    const match = options.find((option) => !enabled.has(option.id)
      && !(option.group && groups.has(option.group))
      && option.args.every((arg, k) => rest[i + k] === arg));
    if (!match) return null;
    enabled.add(match.id);
    if (match.group) groups.add(match.group);
    i += match.args.length;
  }
  return options.map((option) => ({ ...option, enabled: enabled.has(option.id) }));
}

function validateOptionsPlaceholder(template) {
  let quote = null;
  let escaped = false;
  for (let i = 0; i < template.length; i++) {
    if (template.startsWith('{options}', i)) {
      if (quote || escaped || (i > 0 && !/\s/.test(template[i - 1]))
        || (i + 9 < template.length && !/\s/.test(template[i + 9]))) {
        throw new Error('Options placeholder must be a standalone unquoted argument');
      }
      i += 8;
      continue;
    }
    if (escaped) { escaped = false; continue; }
    if (template[i] === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) { if (template[i] === quote) quote = null; }
    else if (template[i] === "'" || template[i] === '"') quote = template[i];
  }
  if (quote || escaped) throw new Error('Unbalanced quoting in resume template');
}

module.exports = { validateOptions, applyLaunchOptions, optionArgs, validateOptionsPlaceholder, migrateBakedOptions };
