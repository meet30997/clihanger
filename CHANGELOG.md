# Changelog

All notable changes to CliHanger will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.0] — 2026-10-19

### Added
- **Multi-Agent Workspace:** Side-by-side terminal sessions for Claude Code, Codex CLI, Antigravity, and regular shells.
- **Attention Routing:** Real-time session status monitoring (`working`, `needs input`, `idle`, `exited`), desktop notifications, and a prioritized attention queue.
- **Ports Panel:** Live TCP listening port monitoring with parent process tree attribution, linked session discovery, and safe process termination (SIGTERM → SIGKILL).
- **Fast Navigation:** Quick Switcher (⌘P), session indexing (⌘1–⌘9), in-pane scrollback search (⌘F), and next-waiting session focus (⇧⌘J).
- **Session Continuity:** Automatic conversation restoration across app restarts, handoff generator, and context breadcrumb notes.
- **Data-Driven Agents:** Extensible agent definitions in `~/.hangar/agents.json`.
- **macOS Native Integration:** Native light appearance, terminal selection that follows the live macOS Highlight color, and aligned window controls.
