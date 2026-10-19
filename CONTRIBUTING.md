# Contributing to CliHanger

Thank you for your interest in contributing to CliHanger!

CliHanger is a focused CLI workspace and attention router for developers running multiple coding-agent CLIs on macOS.

---

## 1. Project Boundaries & Architecture

Before proposing changes, please keep the architectural boundaries in mind:

- **tmux owns the sessions:** Sessions run on a private socket (`tmux -L hangar`). The Electron app is a viewer and launcher.
- **Process isolation:** The renderer never touches the filesystem or spawns processes. All bridge APIs must be declared in `src/main/preload.js` and validated against `src/main/ipc-contract.js`.
- **Agents as data:** No agent CLI names (`claude`, `codex`, `agy`) are hardcoded in application logic. Agents are configured purely as data in `~/.hangar/agents.json`.
- **Lightweight state:** `~/.hangar/state.json` is a disposable cache. If deleted, CliHanger re-adopts active tmux sessions on startup without data loss.

---

## 2. Non-Goals (Scope Boundary)

To keep CliHanger reliable and maintainable, the following features are intentionally out of scope:

- Multi-window layouts, split panes, and browser-style tab bars.
- Themes, skinning, or complex settings panels (settings belong in JSON).
- Remote SSH multiplexing or cloud synchronization.
- Token tracking, billing monitors, or LLM cost dashboards.
- Git GUI tools, diff viewers, and branch managers.

PRs introducing items from this non-goals list will be closed respectfully.

---

## 3. Development Setup

### Prerequisites
- macOS (Apple Silicon or Intel)
- Node.js LTS, v20 or newer (tested on 22 and 24; avoid odd-numbered releases, which lag on native prebuilds)
- Xcode Command Line Tools (`xcode-select --install`)
- tmux ≥ 3.2 (`brew install tmux`)

### Building from Source

```bash
# 1. Clone the repository
git clone https://github.com/meet30997/clihanger.git
cd clihanger

# 2. Install dependencies
npm ci

# 3. Rebuild native modules for Electron
npm run rebuild

# 4. Launch in development mode
npm start
```

### Packaging Locally

To package and install directly to `/Applications/CliHanger.app`:
```bash
npm run install-app
```

---

## 4. Verification and Testing

CliHanger interacts with real pseudo-terminals and tmux sockets on macOS, so verification relies on automated syntax validation and manual functional testing.

Run the syntax gate before opening a PR:
```bash
find src scripts -name '*.js' -exec node --check {} +
```

### Manual Acceptance Checklist
When modifying core features, verify:
- [ ] Terminal view attaches cleanly, resizes without clipping, and allows scrolling.
- [ ] Status dot accurately transitions when an agent needs input.
- [ ] Ports panel detects listening TCP ports and correctly terminates selected processes.
- [ ] Quitting the app terminates all sessions cleanly.
- [ ] The app survives when `~/.hangar/state.json` is cleared.

---

## 5. Commit Guidelines

- Use concise, conventional commit prefixes: `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`.
- Ensure all modified JavaScript files pass `node --check`.
