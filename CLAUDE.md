# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Aither Flow — a desktop GUI wrapper for Claude Code CLI. Not a replacement for CLI, but a visual interface on top of it. CLI is the sole engine; the GUI only manages processes and displays results.

Full architecture: `ARCHITECTURE.md`. Roadmap: `ROADMAP.md`.

## Stack

- **Backend:** Rust / Tauri 2 (Cargo workspace: main app + `aither-flow-perms`)
- **Frontend:** React 19 + TypeScript + Vite + Tailwind CSS v4
- **Theme:** Custom warm palette (dark: coffee tone, light: aitherlab.org), CSS custom properties
- **Data:** SQLite + FTS5 (memory), JSON (chats, settings)
- **Scaffold note:** `pnpm create tauri-app` requires an empty directory; create in /tmp then copy
- **Platforms:** Linux (primary), macOS (secondary). Windows is not supported

## Commands

```bash
pnpm tauri dev          # run in dev mode
pnpm tauri build        # production build
pnpm tsc --noEmit       # typecheck (run from project root, NOT from src-tauri/)
cargo clippy            # lint Rust (run from src-tauri/)
pnpm test               # run tests (vitest)
pnpm test -- -t "name"  # run a single test
```

## Architecture: conductor and orchestra

The core (conductor) communicates with CLI via stream-json and dispatches events to modules through an event bus. Modules (orchestra sections) are unaware of each other — they communicate only through events or the core. Removing one module does not affect the rest.

### Sections
- **Strings** (data): chats, memory (SQLite), projects
- **Winds** (CLI extensions): skills, MCP servers, agents, hooks
- **Percussion** (infrastructure): file viewer, web preview, Telegram, cron

### UI modules
Chat, sidebar, settings, web preview, file viewer, modals (single Modal component), status bar (with expandable panels), header — each is isolated with its own state.

## Critical architectural decisions

### Agent isolation — foundation
Each agent = independent container: own messages, session, project, CLI process. Switching a tab = showing a different container, NOT reconfiguring shared state. No shared `activeAgentId` in business logic.

### Interactive permissions
Separate binary `aither-flow-perms` (~200 lines of Rust, no Tauri). CLI calls it via `--permission-prompt-tool`; it communicates with the GUI over a unix socket. MCP protocol: 3 methods (`initialize`, `tools/list`, `tools/call`).

### CLI compatibility
The GUI reads/writes the same files as the CLI. Skills, agents, MCP, hooks, permissions, CLAUDE.md — single format. No parallel storage.

## CLI integration

```
claude -p --output-format stream-json --input-format stream-json --verbose --include-partial-messages
```

Stream flow: `system (init)` → `stream_event (content_block_delta)` × N → `assistant` → `result`

Key flags: `--resume`, `--model`, `--agent`, `--worktree`, `--permission-mode`, `--add-dir`, `--max-turns`, `--max-budget-usd`, `--mcp-config`

## Environment setup

- Node.js 22+, pnpm 9+
- Rust stable (rustup)
- Linux: `webkit2gtk-4.1`, `libayatana-appindicator3-dev` (for tray icon)
- `pnpm install` then `pnpm tauri dev`

## Paths (XDG from day one)

- Config: `~/.config/aither-flow/`
- Data: `~/.local/share/aither-flow/`
- CLI-compatible: `~/.claude/skills/`, `~/.claude/agents/`, `~/.claude.json`, `~/.claude/settings.json`
- Use the `dirs` crate for platform-specific paths

## Conventions (Rust)

Note: some utilities below are planned but not yet implemented. Create them following these patterns when needed.

- `platform.rs` — cross-platform module with `#[cfg(target_os)]` blocks. All other code is OS-agnostic
- `atomic_write()` for ALL file writes (write to temp + rename)
- `spawn_blocking` for ALL `#[tauri::command]` handlers using `std::fs::*`, `Path::exists()`, `Command::new()`
- `validate_path_safe()` for user-supplied paths (on BOTH arguments for copy/rename)
- `sanitize_id()` for IDs used in file paths (allows `@` and `.`)
- Shared utilities in `config.rs`: `get_home_dir()`, `get_claude_home()`, `read_json_file<T>()`, `write_json_file<T>()`
- Never swallow errors: use `.map_err(|e| eprintln!(...)).ok()?`, not `let _ =` or bare `.ok()?`
- rusqlite Connection is not Send — open it inside `spawn_blocking`
- \>7 function arguments → use an input struct with `#[derive(Deserialize)]`

## Conventions (TypeScript/React)

- Named exports for components
- `memo()` on heavy components (chat, message list, cards)
- All colors via CSS custom properties (see Design System), no hardcoded values
- Single Modal component for all overlays
- Keyboard shortcuts via `e.code` (layout-independent). Only Alt+* and Ctrl+*, NOT Super — Hyprland intercepts it
- Never swallow errors: use `.catch(console.error)`, not `.catch(() => {})`
- React hooks BEFORE any early `return null`
- TypeScript target does not include ES2023+ — use `[...arr].reverse().find()` instead of `Array.findLast()`
- Streaming messages: render plain text during streaming, markdown only after completion (react-markdown is heavy, partial markdown looks broken)
- rehypeHighlight turns code block children into React elements (spans). Never use `String(children)` — use recursive `extractText()` to get raw text

## Design System

CSS custom properties on `:root` (dark by default) and `[data-theme="light"]`.
Layer hierarchy (deep → surface): `--bg` (floor, gaps between panels) → `--bg-soft`/`--bg-hard` (panels) → `--bg-card` (floating elements) → `--bg-hover` (interactive) → `--input-bg` (fields).
Accent: `--accent` (#d65d0e orange, same in both themes).
Full palette reference: `memory/palette.md` (agent auto-memory).
Syntax highlighting: override `.hljs-*` classes with CSS variables instead of importing hljs themes — auto-switches with dark/light theme.

## Development rules (from ROADMAP.md)

1. One stage at a time — do not jump ahead
2. One change at a time — verify → next
3. Commit after each logical block with a meaningful message
4. Modules must not know about each other — event bus, no direct imports
5. ESLint + Prettier + `cargo clippy` after each block of changes
6. Do not reinvent — where CLI has a format, use it
7. Application UI is in English. Communication with the user is in Russian
8. All public-facing content (README, CLAUDE.md, commit messages, PR descriptions) must be in English
9. Internal docs (ARCHITECTURE.md, ROADMAP.md, devlog/) are in Russian and excluded from git

## Working with the user

- **Discuss first — code second.** Do not build new features without user approval
- **Bugs and minor fixes** — agent's responsibility, do not bother the user
- The user is NOT a programmer. Explain in plain language, no code listings
- V1 code (GUI-Claude) is reference only — do not copy anything from it
- Everything is written from scratch

## Branding

- **Umbrella:** aitherlab (aither = Bold 700 #2a2a2a, lab = Extra Light 200 #d65d0e)
- **Application:** aitherflow (aither = Bold 700, flow = Extra Light 200 orange)
- **Logo font:** Oswald (Google Fonts), letter-spacing: 0.05em
- **Avatar background:** #d6cdbf
- **GitHub:** github.com/aitherlab-dev/aitherflow

## State management

Zustand — each module has its own store. Modules are unaware of each other.
Multiple stores can listen to the same Tauri event independently (e.g., chatStore and conductorStore both listen to `cli-event`).
Tauri event listeners (`listen()`) must be registered at module level, NOT inside React useEffect. Async `listen()` + React StrictMode = duplicate listeners and double event processing.