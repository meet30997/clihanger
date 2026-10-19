# Troubleshooting

This guide covers common issues when building or running CliHanger on macOS.

---

## 1. Native Build and Dependency Issues

### "The module was compiled against a different Node.js version"

This occurs when `node-pty` was built against system Node instead of Electron's embedded Node headers.

Run:
```bash
npm run rebuild
```

If the error persists after updating Node or Electron:
```bash
rm -rf node_modules package-lock.json
npm install
npm run rebuild
```

### "gyp ERR! find Xcode" or missing C++ compiler

`node-pty` requires Apple Clang to compile its native pseudo-terminal bindings:

```bash
xcode-select --install
sudo xcode-select --reset
```

Verify that clang is functional:
```bash
clang --version
```

---

## 2. tmux and Environment Issues

### "tmux: command not found" or session creation fails

CliHanger requires `tmux` ≥ 3.2 installed on your system.

```bash
brew install tmux
tmux -V
```

If tmux is installed via Homebrew (`/opt/homebrew/bin/tmux` on Apple Silicon or `/usr/local/bin/tmux` on Intel), ensure it is reachable on your system PATH. CliHanger automatically resolves Homebrew PATHs even when launched directly from Finder.

### "no server running on .../hangar"

The private tmux server starts automatically when you create your first session. Seeing this message before creating any sessions is normal.

### Changes to `~/.hangar/tmux.conf` are not taking effect

tmux only reads its configuration when the server process starts. Restart the private server:

```bash
tmux -L hangar kill-server
```
*Note: This will close any currently running agent sessions.*

---

## 3. Terminal and Display Issues

### Escape key feels laggy in interactive TUIs

Ensure `escape-time` is disabled in `~/.hangar/tmux.conf`:
```tmux
set -sg escape-time 0
```
Then restart the tmux server (`tmux -L hangar kill-server`).

### Box-drawing characters or borders look corrupted

Ensure your terminal font supports UTF-8 box-drawing characters. The bundled styles prioritize JetBrains Mono and standard macOS system monospace fonts.

### Terminal colors look muted or wrong

Truecolor support requires two settings in `~/.hangar/tmux.conf`:
```tmux
set -g default-terminal "xterm-256color"
set -ag terminal-overrides ",xterm-256color:Tc"
```

---

## 4. Ports Panel Issues

### Ports panel is empty when services are running

CliHanger uses `lsof` to list listening TCP sockets. Test the command directly:
```bash
lsof -nP -iTCP -sTCP:LISTEN -F pcn
```
If this produces output in your terminal but not in CliHanger, check if background permissions or security profiles restrict `lsof`.

### Listening port shows as "Unowned"

CliHanger determines session ownership by walking the process parent hierarchy (`ps`) up to a known tmux pane PID.

If a server daemonizes, detaches from its parent, or is reparented to `launchd` (PID 1), the parent chain breaks. The port remains visible in the panel, but its owning session cannot be identified. You can still terminate the process by clicking **Kill**.

---

## 5. macOS Gatekeeper and Security

### macOS says the app cannot be opened or is damaged

Unsigned or ad-hoc signed builds downloaded or moved to `/Applications` may be quarantined by macOS Gatekeeper:

```bash
xattr -cr /Applications/CliHanger.app
```
Alternatively, right-click `CliHanger.app` in Finder, choose **Open**, and click **Open** in the confirmation dialog.

---

## 6. The Escape Hatch: Direct tmux Access

CliHanger never traps your agent processes inside the UI. If the application crashes, freezes, or fails to render, your sessions continue running safely in tmux:

```bash
# List all active sessions
tmux -L hangar list-sessions

# Attach directly to a running session
tmux -L hangar attach -t <session_name>
# (Press Ctrl-B followed by d to detach without stopping the session)

# Capture the recent scrollback buffer
tmux -L hangar capture-pane -p -t <session_name> -S -50
```

---

## 7. Complete Reset Sequence

If state becomes corrupted or out of sync:

1. **Stop all sessions:**
   ```bash
   tmux -L hangar kill-server
   ```
2. **Clear app state (retaining agents configuration):**
   ```bash
   rm ~/.hangar/state.json
   ```
3. **Rebuild native dependencies:**
   ```bash
   npm run rebuild
   ```
4. **Relaunch:**
   ```bash
   npm start
   ```
