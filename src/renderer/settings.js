'use strict';

(() => {
  const find = (selector) => document.querySelector(selector);
  const dialog = find('#settings-dialog');
  const editor = find('#settings-json');
  const tabs = [...dialog.querySelectorAll('[role="tab"]')];
  let savedJson = '';
  let revision = null;
  let effective = {};
  let previews = {};
  let selected = null;
  let valid = false;
  let busy = false;
  let opener = null;
  let previewTimer;
  let pendingAction = null;
  let generation = 0;

  const dirty = () => editor.value !== savedJson;
  function error(message = '') {
    find('#settings-error').textContent = message;
    find('#settings-error').hidden = !message;
  }
  function updateStatus(message) {
    find('#settings-save').disabled = busy || !valid || !dirty() || !revision;
    find('#settings-reload').disabled = busy;
    find('#settings-edit').disabled = busy || !revision;
    find('#settings-copy').disabled = busy || !revision;
    find('#settings-format').disabled = busy || editor.readOnly;
    editor.disabled = busy;
    dialog.querySelectorAll('#settings-options input').forEach((input) => { input.disabled = busy || !valid; });
    find('#settings-agent-list').inert = busy;
    find('#settings-agent-detail').inert = busy;
    find('#settings-status').textContent = message || (busy ? 'Saving…' : dirty()
      ? 'Unsaved changes' : 'Saved · Running sessions keep their current options.');
  }
  function selectTab(tab) {
    for (const item of tabs) {
      const on = item === tab;
      item.setAttribute('aria-selected', String(on));
      item.tabIndex = on ? 0 : -1;
      document.getElementById(item.getAttribute('aria-controls')).hidden = !on;
    }
  }
  function renderAgents(restoreOption = null) {
    const focusedOption = restoreOption || document.activeElement?.closest('#settings-options input')?.id;
    const list = find('#settings-agent-list');
    list.replaceChildren();
    const agents = Object.entries(effective).filter(([, agent]) => agent.kind !== 'shell' && agent.command);
    if (!agents.some(([id]) => id === selected)) selected = agents[0]?.[0];
    for (const [id, agent] of agents) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = agent.label;
      button.setAttribute('aria-pressed', String(id === selected));
      button.addEventListener('click', () => { selected = id; renderAgents(); find('#settings-agent-name').focus(); });
      list.appendChild(button);
    }
    const agent = effective[selected];
    find('#settings-agent-name').textContent = agent?.label || 'No agent selected';
    find('#settings-agent-name').tabIndex = -1;
    find('#settings-agent-command').textContent = agent?.command || '';
    const options = find('#settings-options');
    options.replaceChildren();
    for (const [index, option] of (agent?.launchOptions || []).entries()) {
      const row = document.createElement('label');
      row.className = 'settings-option' + (option.dangerous ? ' settings-option-danger' : '');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.id = `settings-option-${index}`;
      checkbox.checked = !!option.enabled;
      checkbox.disabled = !valid || busy;
      const text = document.createElement('span');
      const label = document.createElement('strong');
      label.textContent = option.label + (option.dangerous ? ' · Use with care' : '');
      const detail = document.createElement('span');
      detail.textContent = option.description || '';
      detail.hidden = !option.description;
      const args = document.createElement('code');
      args.textContent = option.args.map((arg) => /\s/.test(arg) ? JSON.stringify(arg) : arg).join(' ');
      const modes = document.createElement('small');
      modes.textContent = option.appliesTo?.length === 1 ? (option.appliesTo[0] === 'fresh' ? 'New sessions only' : 'Resume only') : '';
      text.append(label, detail, args, modes);
      checkbox.addEventListener('change', () => toggleOption(index, checkbox.checked));
      row.append(checkbox, text);
      options.appendChild(row);
    }
    if (!options.childElementCount) {
      const empty = document.createElement('p');
      empty.className = 'settings-hint settings-no-options';
      empty.textContent = !agent
        ? 'Add an agent CLI in the JSON file to configure launch options.'
        : 'No launch options defined. Add up to five launchOptions in the JSON file to create checkboxes for this agent.';
      options.appendChild(empty);
    }
    const commands = find('#settings-previews');
    commands.replaceChildren();
    find('#settings-command-preview').hidden = !agent;
    for (const [key, label] of [['fresh', 'New session'], ['picker', 'Resume picker'], ['resume', 'Resume by ID']]) {
      const command = previews[selected]?.[key];
      if (!command && key !== 'fresh') continue;
      const name = document.createElement('dt');
      name.textContent = label;
      const value = document.createElement('dd');
      const code = document.createElement('code');
      code.textContent = valid ? (command || 'Project shell') : 'Fix the JSON to preview this command.';
      value.appendChild(code);
      commands.append(name, value);
    }
    if (focusedOption && (document.activeElement === document.body || document.activeElement.closest('#settings-options'))) {
      document.getElementById(focusedOption)?.focus();
    }
  }
  async function refreshPreview() {
    clearTimeout(previewTimer);
    const json = editor.value;
    const request = ++generation;
    const focusedOption = document.activeElement?.closest('#settings-options input')?.id;
    valid = false;
    updateStatus();
    try {
      const result = await window.hangar.previewAgentConfiguration(json);
      if (request !== generation || !dialog.open || editor.value !== json) return;
      valid = result.valid;
      error(result.error);
      if (valid) { effective = result.agents; previews = result.previews; }
      renderAgents(focusedOption);
    } catch (err) { if (request === generation) error(err.message); }
    updateStatus();
  }
  function toggleOption(index, checked) {
    if (!valid || busy) return;
    try {
      const data = JSON.parse(editor.value);
      // Inherited options become explicit only when the user changes this agent.
      if (!data[selected]) throw new Error('Add this agent to the JSON file before changing its options.');
      const options = JSON.parse(JSON.stringify(effective[selected].launchOptions));
      options[index].enabled = checked;
      if (checked && options[index].group) {
        options.forEach((option, i) => { if (i !== index && option.group === options[index].group) option.enabled = false; });
      }
      data[selected].launchOptions = options;
      // A migrated command moves its baked-in flags into these options.
      data[selected].command = effective[selected].command;
      editor.value = JSON.stringify(data, null, 2) + '\n';
      refreshPreview();
    } catch (err) { error(err.message); renderAgents(); }
  }
  async function loadFile(focusReload = false) {
    busy = true;
    valid = false;
    revision = null;
    error();
    updateStatus('Loading…');
    try {
      const result = await window.hangar.getAgentConfiguration();
      if (!dialog.open) return;
      editor.value = savedJson = result.json;
      revision = result.revision;
      effective = result.agents;
      editor.readOnly = true;
      find('#settings-edit').textContent = 'Edit JSON';
      if (result.error) selectTab(tabs[1]);
    } catch (err) { error(err.message); }
    finally { busy = false; }
    if (revision) await refreshPreview();
    else updateStatus('Could not load agents.json. Reload to try again.');
    if (focusReload && dialog.open) find('#settings-reload').focus();
  }
  function close() {
    generation++;
    clearTimeout(previewTimer);
    dialog.close();
    restoreFocusFrom(dialog, opener);
    opener = null;
  }
  function requestAction(action) {
    if (busy) return;
    if (!dirty()) { action(); return; }
    pendingAction = action;
    find('#settings-discard').hidden = false;
    find('#settings-keep').focus();
  }
  async function open() {
    if (dialog.open || modalResolve || !find('#preset-modal').hidden || !find('#handoff-modal').hidden
      || !find('#breadcrumb-editor').classList.contains('hidden')) return;
    if (helpDialog.open) closeHelp();
    closeMoreMenu();
    opener = document.activeElement;
    closeLauncher();
    if (!find('#switcher').hidden) closeSwitcher();
    hideStatusPopover();
    selected = null;
    effective = {};
    previews = {};
    savedJson = '';
    editor.value = '';
    pendingAction = null;
    find('#settings-discard').hidden = true;
    selectTab(tabs[0]);
    dialog.showModal();
    await loadFile();
  }
  async function save() {
    if (busy || !valid || !dirty() || !revision) return;
    busy = true;
    error();
    updateStatus();
    try {
      const result = await window.hangar.saveAgentConfiguration(editor.value, revision);
      if (!result.ok) { error(result.error); return; }
      savedJson = editor.value = result.configuration.json;
      revision = result.configuration.revision;
      find('#settings-discard').hidden = true;
      pendingAction = null;
    } catch (err) { error(err.message); }
    finally { busy = false; updateStatus(); find('#settings-reload').focus(); }
  }
  find('#sidebar-settings').addEventListener('click', open);
  find('#ready-settings').addEventListener('click', open);
  window.addEventListener('hangar:settings', open);
  find('#settings-close').addEventListener('click', () => requestAction(close));
  find('#settings-reload').addEventListener('click', () => requestAction(() => loadFile(true)));
  find('#settings-save').addEventListener('click', save);
  find('#settings-keep').addEventListener('click', () => { pendingAction = null; find('#settings-discard').hidden = true; editor.readOnly ? find('#settings-save').focus() : editor.focus(); });
  find('#settings-confirm-discard').addEventListener('click', () => {
    const action = pendingAction;
    pendingAction = null;
    find('#settings-discard').hidden = true;
    action?.();
  });
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); requestAction(close); });
  find('#settings-edit').addEventListener('click', () => {
    editor.readOnly = !editor.readOnly;
    find('#settings-edit').textContent = editor.readOnly ? 'Edit JSON' : 'Finish editing';
    updateStatus();
    editor.focus();
  });
  find('#settings-copy').addEventListener('click', () => { window.hangar.copyText(editor.value); updateStatus('JSON copied.'); });
  find('#settings-format').addEventListener('click', () => {
    try { editor.value = JSON.stringify(JSON.parse(editor.value), null, 2) + '\n'; refreshPreview(); }
    catch (err) { error(err.message); }
  });
  editor.addEventListener('input', () => {
    generation++;
    valid = false;
    updateStatus();
    clearTimeout(previewTimer);
    previewTimer = setTimeout(refreshPreview, 180);
  });
  for (const tab of tabs) tab.addEventListener('click', () => selectTab(tab));
  dialog.querySelector('[role="tablist"]').addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = tabs.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    selectTab(tabs[next]);
    tabs[next].focus();
  });
  window.addEventListener('keydown', (event) => {
    const shortcut = event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key === ',';
    if (!dialog.open) {
      if (shortcut) { event.preventDefault(); event.stopImmediatePropagation(); open(); }
      return;
    }
    if (event.key === 'Escape' || shortcut) {
      event.preventDefault();
      event.stopImmediatePropagation();
      requestAction(close);
    } else if (event.metaKey || event.ctrlKey) {
      if (event.metaKey && !event.shiftKey && event.key.toLowerCase() === 's') {
        event.preventDefault();
        save();
      }
      // Native text editing (including Control-key Emacs bindings) and macOS
      // window/application actions remain available.
      if (event.metaKey && !['a', 'c', 'v', 'x', 'z', 'y', 'q', 'h', 'm', 'w', 's', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'backspace', 'delete'].includes(event.key.toLowerCase())) event.preventDefault();
      event.stopImmediatePropagation();
    } else if (event.key === 'Tab') {
      cycleFocus(event, dialog);
      event.stopImmediatePropagation();
    }
  }, { capture: true });
  // Menu accelerators dispatch these events directly, bypassing keydown.
  for (const name of ['toggle-sidebar', 'new-session', 'quick-switcher', 'next-waiting', 'zoom-in', 'zoom-out', 'zoom-reset', 'clear-terminal', 'find-terminal', 'set-option-meta']) {
    window.addEventListener(`hangar:${name}`, (event) => { if (dialog.open) event.stopImmediatePropagation(); }, { capture: true });
  }
})();
