# Configuration

CliHanger stores all configuration and runtime state in `~/.hangar/`.

```
~/.hangar/
├── agents.json     # User-editable agent and terminal definitions
├── state.json      # App-managed session and project state (disposable cache)
├── tmux.conf       # tmux configuration for the private socket
├── hook.sh         # Shell script for CLI status reporting
├── hook.token      # Authentication token for the local hook receiver
└── presets.json    # Optional: session presets per project
```

A project can also keep its presets in a `.hangar.json` file at the project root, which takes
priority over `~/.hangar/presets.json`.

---

## 1. Defining Agents (`~/.hangar/agents.json`)

CliHanger treats agents as data. No agent IDs or commands are hardcoded in the application. Adding an agent only takes a JSON edit.

On first launch, CliHanger copies its bundled defaults to `~/.hangar/agents.json`. The defaults
define four agents: `terminal` (a plain shell), `claude`, `codex` and `agy` (Antigravity). The
complete file ships in [`src/main/defaults/agents.json`](../src/main/defaults/agents.json). Two
entries from it:

```json
{
  "terminal": {
    "label": "Terminal",
    "command": "",
    "color": "#adadad",
    "kind": "shell"
  },
  "claude": {
    "label": "Claude Code",
    "command": "claude",
    "color": "#d97757",
    "resumePickerCommand": "{command} --resume",
    "resumeCommand": "{command} --resume {conversationId}",
    "resumeFailurePattern": "No\\s+conversation\\s+found\\s+with\\s+session\\s+ID",
    "conversationHistory": {
      "format": "transcript-jsonl",
      "path": "~/.claude/projects/{projectKey}"
    },
    "icon": { "file": "agent-icons/provider-1.png", "monochrome": true }
  }
}
```

If `agents.json` is not valid JSON, CliHanger logs an error and falls back to the bundled defaults.

### Schema Reference

Each key in the object is an `<agentId>`. It is slugified into tmux session names (`hangar_<project>_<agentId>_<n>`), so use alphanumeric characters and hyphens (`[A-Za-z0-9-]`).

| Field | Type | Required | Description |
|---|---|---|---|
| `label` | string | Yes | Display name in the sidebar, launcher, and switcher. |
| `command` | string | Yes | The executable or shell command launched in the session. Empty (`""`) for standard interactive shells. |
| `color` | string (`#rrggbb`) | Yes | Accent color used for sidebar indicators, status dots, and badges. |
| `kind` | `"shell"` | No | Marks a plain terminal session. Plain shells do not get classified as "exited agents" when idle. |
| `icon` | object | No | `{ "file": "agent-icons/<name>.png", "monochrome": boolean }`. Must name a PNG bundled in `src/renderer/agent-icons/` (lowercase letters, digits and hyphens). `monochrome: true` tints the icon with `color`. Without an icon, the agent gets a generic chat icon (or a terminal icon for `kind: "shell"`). |
| `resumeCommand` | string | No | Template for resuming a conversation by ID. Supports `{command}` and `{conversationId}` (alias `{id}`). The ID is shell-quoted; if the template has no ID placeholder, the ID is appended. |
| `resumePickerCommand` | string | No | Command launched when resuming without a specific conversation ID, e.g. the CLI's own picker. Only `{command}` is allowed. |
| `resumeFailurePattern` | string (regex) | No | Case-insensitive regex tested against the first 2.5s of output to catch rejected resume attempts. |
| `chatPromptPattern` | string (regex) | No | Regex matching user prompt lines to automatically extract conversation titles. Capture group 1 is used as title. |
| `chatTitlePattern` | string (regex) | No | Regex matching CLI status footer or title announcement. First non-empty group is used. |
| `conversationHistory` | object | No | Where to read past conversations for titles and resume targets. `format` is `"transcript-jsonl"` (a directory of JSONL transcripts; `{projectKey}` in `path` is the project path with non-alphanumerics replaced by `-`) or `"sqlite"` (a database plus a read-only `query` that receives `$projectPath`, and an optional `activity` JSONL log). See the `codex` and `agy` defaults for complete examples. |

### Worked Example: Adding Aider

To add [Aider](https://aider.chat) to your workspace:

1. Open `~/.hangar/agents.json` in your editor.
2. Add an `"aider"` entry next to the existing ones:

```json
"aider": {
  "label": "Aider",
  "command": "aider",
  "color": "#7c3aed"
}
```

3. Save the file and restart CliHanger. Aider now appears in the new-session menu.

Status detection works without any extra fields. Add the `resume*` and `chat*` fields only
if the CLI supports them.

---

## 2. App State (`~/.hangar/state.json`)

`state.json` is maintained automatically by CliHanger. It stores:

- **Configured projects:** project folder paths, display names, and default agents.
- **Session metadata:** user-authored notes, conversation associations, and parked session recovery references.
- **Last active session:** the session currently focused in the window.

### Disposable Cache Design

`state.json` is strictly an auxiliary cache. **tmux is the source of truth** for what is running.
- If CliHanger crashes or `state.json` is removed, running tmux sessions on the `hangar` socket are not lost. On the next launch, CliHanger scans tmux and restores them into an "Unassigned" project group.
- Deleting `state.json` resets only your project list and custom session titles/notes.

---

## 3. tmux Configuration (`~/.hangar/tmux.conf`)

CliHanger manages sessions on an isolated tmux socket named `hangar` (`tmux -L hangar`). It does not read your personal `~/.tmux.conf`, preventing conflicts with personal keybindings or plugins.

Instead, it reads `~/.hangar/tmux.conf`. By default, this file configures:
- `status off` — hides the tmux status bar so your agent fills the entire window.
- `mouse on` — enables trackpad and mouse scrolling.
- `default-terminal "xterm-256color"` and truecolor overrides (`Tc`).
- `escape-time 0` — eliminates delay after the Escape key in agent TUIs.

### Reloading tmux Settings

`tmux.conf` is read when the private tmux server starts. If you modify `~/.hangar/tmux.conf`, restart the server to apply changes:

```bash
tmux -L hangar kill-server
```
*(Note: this terminates any active CLI sessions on the socket).*
