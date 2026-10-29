# Changelog

All notable changes to CliHanger will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.4.1] — 2026-10-29

### Fixed
- **Notifications:** A session sends one notification per wait, not one each time its screen repaints. A new session sitting at its empty prompt no longer notifies or counts as waiting until you send it something. Relaunching the app no longer notifies about every session that is already at a prompt.

### Changed
- **Notifications:** Clicking a notification opens its session. Titles say whether the agent needs approval or is waiting for your reply. Opening, answering, snoozing or closing a session removes its notification.

### Security
- **Electron 43.8.3:** Updated Electron and build tooling to clear all open dependency security alerts.

## [0.4.0] — 2026-10-26

### Added
- **Drag to reorder:** Drag projects and sessions in the sidebar to change their order.
- **Keyboard session menu:** Shift-F10 or the Menu key opens a session's menu. Arrow keys, Home/End, Return and Escape work inside it.

### Changed
- **"Waiting for you" stays accurate:** A finished reply you have opened stays out of the list until the agent runs another turn. Screen changes caused by your own typing, resizing or switching are no longer read as agent work. Permission prompts stay listed until you answer them.
- **Prompt detection:** The agent's own chat prompt is checked first, so Codex's idle placeholder counts as a finished reply, and trust and update menus count as prompts that need an answer.
- **Dark mode:** Retuned dark palette.
- **Menu-bar list:** Waiting sessions are listed oldest first, the same order as the sidebar. The collapsed sidebar shows the waiting count on its expand button.
- **Ports:** The ports view starts with the selected session. The stop dialog says the whole process stops, lists its other ports and says whether a session owns it.
- **Dialogs:** Dialogs that delete or stop something open with Cancel focused, so Return cancels. Tab stays inside the open dialog, and focus goes back to where you were when it closes.

### Fixed
- **Stale status:** When a session's screen can't be read, its status is marked as not current instead of being shown as live.
- **Notifications:** A session going from working to idle no longer claims the agent finished.
- **Ports scan failure:** A failed scan keeps the last-known session ports, with Stop turned off.

## [0.3.0] — 2026-10-22

### Added
- **Drag files from Finder:** Drop files or folders onto a terminal to insert their shell-escaped paths, separated by spaces, without pressing Enter. A drop is refused as a whole if any path contains control characters.
- **macOS editing chords:** ⌘←/⌘→ move to the start or end of the line, ⌥←/⌥→ move by word and ⌘⌫ deletes to the start of the line. They work in shells and in full-screen programs and agents such as vim, less, Claude Code and Codex.
- **Option-click moves the cursor:** Option-click on the prompt line moves the cursor to the clicked column, the way it does in Terminal.app.
- **VoiceOver support:** The terminal switches to screen-reader mode when macOS accessibility support is on, and switches back when it is turned off.

### Changed
- **Emoji and wide characters:** Grapheme-aware widths (Unicode 15), so emoji, flags and combined characters line up with what tmux draws.
- **Search:** ⌘F searches for the query exactly as typed, including leading and trailing spaces. The match count is correct across wrapped lines, and Previous no longer gets stuck after a change of direction.

### Fixed
- **Menu-bar icon:** The menu-bar item shows the app's icon again instead of only a count.
- **Closing a finished session:** Closing a session whose shell has already exited no longer shows an error.

## [0.2.0] — 2026-10-20

### Added
- **Dark mode:** The app now follows the macOS Light/Dark appearance live. The dark palette keeps all text at 4.5:1 contrast or better, and the terminal gets a dark ANSI palette tuned to the same standard.
- **Stop any port from the list:** Every row in Listening Ports has its own Stop button (or press Delete on a focused row), whether or not the port belongs to a session, and whether or not the inspector is open.

### Changed
- **Handoff has no length limit:** Copy Handoff now includes the session's full terminal scrollback (up to tmux's 50,000-line history) instead of the last 80 lines / 20 KB. You can still review and redact it before copying.
- **Screenshots:** README and social preview images now show dark mode.

## [0.1.1] — 2026-10-20

### Changed
- **Status explanations open on request:** The status card for a session now opens on click, Enter or Space instead of on hover, and closes on a second click.
- **No hover tooltips:** Removed hover tooltips across the sidebar, top bar and inspector. Full session context is still exposed to assistive technology through `aria-label`.
- **Contrast:** Darker secondary text, warning, success and status-dot colours; white text on blue selection fills (launcher, context menu, search matches); terminal text from agent CLIs is raised to WCAG AA contrast (`minimumContrastRatio: 4.5`).
- **Lighter popovers and modals:** Softer shadows with a hairline edge and lighter backdrops, matching macOS.
- **Terminal selection:** Selected text is now black on the light Highlight colour.

## [0.1.0] — 2026-10-19

### Added
- **Multi-Agent Workspace:** Side-by-side terminal sessions for Claude Code, Codex CLI, Antigravity, and regular shells.
- **Attention Routing:** Real-time session status monitoring (`working`, `needs input`, `idle`, `exited`), desktop notifications, and a prioritized attention queue.
- **Ports Panel:** Live TCP listening port monitoring with parent process tree attribution, linked session discovery, and safe process termination (SIGTERM → SIGKILL).
- **Fast Navigation:** Quick Switcher (⌘P), session indexing (⌘1–⌘9), in-pane scrollback search (⌘F), and next-waiting session focus (⇧⌘J).
- **Session Continuity:** Automatic conversation restoration across app restarts, handoff generator, and context breadcrumb notes.
- **Data-Driven Agents:** Extensible agent definitions in `~/.hangar/agents.json`.
- **macOS Native Integration:** Native light appearance, terminal selection that follows the live macOS Highlight color, and aligned window controls.
