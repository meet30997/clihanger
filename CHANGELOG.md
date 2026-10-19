# Changelog

All notable changes to CliHanger will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

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
