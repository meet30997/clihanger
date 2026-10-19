# CliHanger

One window for all your coding-agent CLIs. See which agent needs you, and which forgotten session owns port 3000.

[![CI](https://github.com/meet30997/clihanger/actions/workflows/ci.yml/badge.svg)](https://github.com/meet30997/clihanger/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## Why CliHanger?

When you run several agentic CLIs (Claude Code, Codex, Antigravity) across different repositories, your terminal quickly becomes an undifferentiated pile of tabs. Two problems dominate:

1. **Attention.** You can't tell at a glance which agent is currently working, which is blocked waiting for a confirmation prompt, and which finished ten minutes ago. You find yourself manually cycling through tabs to check on them.
2. **Residue.** Agents spawn background servers and test processes that outlive their sessions. Local ports leak, `EADDRINUSE` appears, and nothing tells you which forgotten session owns the process listening on port 3000.

CliHanger solves both: it gives you a focused multi-agent sidebar with live status monitoring and an integrated ports panel with one-click attribution and termination.

---

## Features

- **Project & Session Sidebar:** Group terminal sessions by project folder. Launch multiple agents or standard shells side-by-side.
- **Embedded Terminal Views:** Full terminal fidelity with xterm.js, UTF-8 box drawing, native font metrics, and smooth mouse scrolling.
- **Attention Routing:** Real-time status indicators (`working`, `needs input`, `idle`, `exited`), native macOS notifications when an agent prompts for input, and a prioritized attention queue (`⇧⌘J`).
- **Ports Panel:** Lists all listening local TCP sockets, identifies the owning agent session via process hierarchy inspection, and provides safe termination (SIGTERM followed by SIGKILL).
- **Session Continuity:** Sessions survive window reloads and can be parked/resumed across application restarts without losing conversation context.
- **Quick Switcher (⌘P):** Jump instantly to any project or session, with attention-seeking sessions prioritized at the top.
- **Extensible Configuration:** Agents are defined as data in `~/.hangar/agents.json`. Adding a new agent CLI requires no code changes.

---

## Supported Agents

CliHanger comes with pre-configured definitions for:
- [Claude Code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code) (`claude`)
- [Codex CLI](https://github.com/openai/codex) (`codex`)
- [Google Antigravity](https://antigravity.google) (`agy`)
- Standard terminal shells (`zsh`, `bash`, `fish`)

You can customize commands or add any agent CLI (such as Aider) in `~/.hangar/agents.json`. See [docs/configuration.md](docs/configuration.md) for details.

---

## Requirements

- **macOS:** 12 or later. Tested on Apple Silicon; Intel builds are untested.
- **tmux ≥ 3.2:** `brew install tmux`
- **Node.js:** v20 or v22 (`node -v`)
- **Xcode Command Line Tools:** `xcode-select --install`
- At least one coding agent CLI installed and authenticated

---

## Build from Source

```bash
# 1. Clone the repository
git clone https://github.com/meet30997/clihanger.git
cd clihanger

# 2. Install dependencies
npm ci

# 3. Rebuild native modules (node-pty)
npm run rebuild

# 4. Start in development mode
npm start
```

### Install to /Applications

To build the release package and install it to `/Applications/CliHanger.app`:

```bash
npm run install-app
```

---

## How It Works

We do **not** write a custom terminal emulator backend or process manager. `tmux` runs every session detached in the background on an isolated socket (`tmux -L hangar`).

```
CliHanger App ─── PTY (node-pty) ─── tmux client ─── tmux server (-L hangar) ─── agent CLI
```

Because tmux owns the session processes:
- Your sessions are isolated from your personal `~/.tmux.conf`.
- If the Electron window is reloaded or crashes, your sessions remain running.
- **The Escape Hatch:** You can attach directly to any session from Terminal.app at any time:
  ```bash
  tmux -L hangar list-sessions
  tmux -L hangar attach -t <session_name>
  ```
- Quitting CliHanger cleanly terminates the managed sessions on its private socket.

---

## What CliHanger Touches on Your Machine

CliHanger runs locally with standard user privileges. Here is exactly what it touches:

- **`~/.hangar/` Directory:** Stores configuration (`agents.json`, `tmux.conf`), disposable session state (`state.json`), and the local status hook script (`hook.sh` and `hook.token` with mode `0600`). Deleting this folder loses only custom titles and project lists; active tmux sessions are re-adopted on startup.
- **Private tmux Socket (`hangar`):** Runs an isolated tmux server on socket `hangar`. Your personal tmux configuration and default tmux server are never touched.
- **Local Transcripts & Databases:** Reads local history files (e.g. `~/.claude/projects/`, `~/.codex/state_5.sqlite`, and `~/.gemini/antigravity-cli/`) solely to discover conversation titles and resume targets. These files are read-only and never transmitted anywhere.
- **Local Status Receiver (`127.0.0.1:47823`):** Binds strictly to `127.0.0.1` and requires the bearer token stored in `~/.hangar/hook.token`. It only updates session status dots and never executes arbitrary commands.
- **Port Inspection (`lsof`):** Periodically runs `lsof` to list listening TCP sockets. Processes are killed **only** when you explicitly click the **Kill** button in the Ports panel.
- **Git Worktrees:** If you choose to start a session in a worktree, CliHanger creates `.hangar-worktrees/` inside your project and excludes it from Git tracking.
- **Quitting Ends Sessions:** Quitting CliHanger stops every session running on its private socket.
- **Zero Telemetry:** CliHanger contains no analytics, telemetry, or network calls beyond what your agent CLIs execute themselves.

---

## Non-Goals

To keep the application fast and reliable, the following features are explicitly out of scope:

- **Themes & Styling Customization:** Uses a native macOS look and your system Highlight color. The UI is currently light-only.
- **Split Panes & Browser Tabs:** Terminal multiplexing belongs in your CLI or tmux; CliHanger provides single-pane focus.
- **Settings UI:** Configuration is managed directly in `~/.hangar/agents.json`.
- **Remote SSH & Cloud Sync:** CliHanger is designed specifically for local macOS workflows.
- **LLM Cost & Token Dashboards:** Token and cost accounting belong in provider portals.
- **Git GUI Tools & Diff Review:** Dedicated Git clients and editor extensions handle this better.

---

## Troubleshooting

See [docs/troubleshooting.md](docs/troubleshooting.md) for solutions to common issues including `node-pty` native rebuilds, tmux PATH configuration, and macOS Gatekeeper.

---

## Status

**v0.1** — Originally built for personal daily workflows and made public under MIT. Expect rough edges and active refinement.

---

## Contributing

Contributions aligned with the project's goals are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md) before opening a pull request.

---

## License & Trademarks

- Released under the [MIT License](LICENSE).
- Claude, Codex, and Antigravity are trademarks of their respective owners. CliHanger is an independent open-source tool and is not affiliated with or endorsed by Anthropic, OpenAI, or Google.
