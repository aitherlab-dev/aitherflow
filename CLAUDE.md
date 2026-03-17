# CLAUDE.md

## Проект

aitherflow — десктопная GUI-обёртка для Claude Code CLI. CLI — единственный движок; GUI управляет процессами и показывает результаты.

## Стек

- **Бэкенд:** Rust / Tauri 2
- **Фронтенд:** React 19 + TypeScript + Vite + Tailwind CSS v4
- **Тема:** тёплая палитра (dark: кофейные тона, light: aitherlab.org), CSS-переменные
- **Данные:** JSON (чаты, настройки)
- **Платформы:** Linux + macOS (два билда в CI и Release)

## Структура

- `src/components/` — React: `chat/`, `layout/`, `settings/`, `fileviewer/`, `dashboard/`, `teamwork/`
- `src/hooks/` — React-хуки, `src/stores/` — Zustand-сторы, `src/types/` — TypeScript-типы
- `src/lib/` — транспорт, `src/services/` — Telegram-сервис, `src/data/` — описания команд
- `src-tauri/src/` — Tauri-команды + модули: `conductor/` (ядро), `plugins/`, `telegram/`, `teamwork/`, `voice/`, `worktree.rs`
  Отдельные модули: `agents.rs`, `chats.rs`, `claude_md.rs`, `config.rs`, `devtools.rs`, `file_ops.rs`, `files.rs`, `file_watcher.rs`, `hooks.rs`, `mcp.rs`, `projects.rs`, `secrets.rs`, `settings.rs`, `skills.rs`, `attachments.rs`, `translations.rs`

## Команды

```bash
pnpm tauri dev          # dev-режим
pnpm tauri build        # production
pnpm typecheck          # tsc --noEmit
pnpm lint               # eslint
cargo clippy            # lint Rust (из src-tauri/)
cargo test              # тесты Rust (из src-tauri/)
```

CI (Linux + macOS): `tsc --noEmit` + `eslint` + `cargo clippy -D warnings`
Release: Linux (deb, rpm, AppImage) + macOS (dmg) — собирается на тег `v*`

## Как работает

**CLI-интеграция:** `claude -p --output-format stream-json --input-format stream-json --verbose --include-partial-messages`

Поток: `system (init)` → `stream_event (content_block_delta)` × N → `assistant` → `result`

**Мультиагенты:** каждый агент — отдельный CLI-процесс. `SessionManager` хранит `HashMap<agent_id, AgentSession>`. На фронте `agentStates: Map<agentId, AgentChatState>`.

**Пути (XDG):** конфиги `~/.config/aither-flow/`, данные `~/.local/share/aither-flow/`, чаты `~/.config/aither-flow/chats/`. Использовать `dirs` crate.

## Подводные камни

**Rust:**
- `spawn_blocking` для ВСЕХ `#[tauri::command]` с `std::fs::*`, `Path::exists()`, `Command::new()`
- `atomic_write()` для записи файлов, `validate_path_safe()` для пользовательских путей
- `entry.file_type()` вместо `entry.path().is_dir()` — избегать блокирующий `stat()`
- Не проглатывать ошибки: НЕ `let _ =`, логировать через `.map_err()`
- **Кроссплатформенность (Linux + macOS):**
  - Предпочитать `#[cfg(unix)]` вместо `#[cfg(target_os = "linux")]` — покрывает оба
  - Если нужен linux-only код — обязательно обработать macOS (хотя бы no-op)
  - Пути: только `PathBuf` / `dirs` crate, никаких захардкоженных `/`
  - Не добавлять linux-only зависимости без `#[cfg]` guard в Cargo.toml

**TypeScript/React:**
- Иконки: **только Lucide React**. Никаких CSS-иконок, никакого инлайн-SVG
- Все цвета через CSS-переменные, никаких захардкоженных hex
- Не проглатывать ошибки: `.catch(console.error)`, НЕ `.catch(() => {})`
- `useShallow` обязателен для `.filter()` / `.map()` в Zustand-селекторах
- Стриминг: plain text во время стриминга, markdown только после завершения
- Горячие клавиши через `e.code`. Только Alt+* и Ctrl+*, НЕ Super
- React хуки ДО любого раннего `return null`

**Zustand:**
- Каждый модуль = свой стор. Модули не знают друг о друге
- Cross-store: `storeB.getState().action()`, НИКОГДА React-хуки из двух сторов

## Дизайн-система

CSS-переменные: `:root` (тёмная) и `[data-theme="light"]`. Фон: `--bg` → `--bg-soft`/`--bg-hard` → `--bg-card` → `--bg-hover` → `--input-bg`. Табы: `--tab-bg` → `--tab-bg-hover` → `--tab-bg-active` → `--tab-bg-active-hover`. Карточки: `--card-bg`. Акцент: `--accent`, `--accent-soft`, `--accent-stroke`, `--accent-icon`. НЕ хардкодить цвета. Палитра: `memory/palette.md` (auto-memory)

## Работа с пользователем

- **Пользователь работает через GUI (aitherflow), НЕ через терминал.** Рабочая директория занята запущенным приложением
- **ЗАПРЕЩЕНО создавать ветки и делать checkout.** Только `git worktree add` — НИКОГДА `git checkout`/`git switch`/`git branch`. Вся работа вне main — только через worktree
- **Сначала обсудить — потом писать код.** Не строить фичи без одобрения
- **Баги и мелочи** — ответственность агента, не дёргать пользователя
- **Одно изменение за раз.** Сделал → проверил → следующее
- `pnpm tauri dev` запускает **пользователь**. Интерфейс на английском, общение на русском

## Брендинг

**aitherflow** — Oswald, aither Bold 700, flow Extra Light 200. GitHub: github.com/aitherlab-dev/aitherflow

## Свои MCP-серверы

- **mcp-telegram-files** — отправка файлов в Telegram. Rust, stdio. Репо: github.com/aitherlab-dev/mcp-telegram-files
