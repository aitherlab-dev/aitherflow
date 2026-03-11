# CLAUDE.md

## Проект

Aither Flow — десктопная GUI-обёртка для Claude Code CLI. CLI — единственный движок; GUI управляет процессами и показывает результаты.

## Стек

- **Бэкенд:** Rust / Tauri 2
- **Фронтенд:** React 19 + TypeScript + Vite + Tailwind CSS v4
- **Тема:** тёплая палитра (dark: кофейные тона, light: aitherlab.org), CSS-переменные
- **Данные:** JSON (чаты, настройки), SQLite+FTS5 (session memory)
- **Платформы:** Linux (macOS планируется)

## Структура

- `src/components/` — React: `chat/`, `layout/`, `settings/`, `fileviewer/`, `dashboard/`
- `src/hooks/` — React-хуки, `src/stores/` — Zustand-сторы, `src/types/` — TypeScript-типы
- `src-tauri/src/` — Tauri-команды + модули: `conductor/` (ядро), `memory/`, `plugins/`, `telegram/`, `voice/`
- `src-tauri/crates/` — крейты: `memory-mcp`

## Команды

```bash
pnpm tauri dev          # dev-режим
pnpm tauri build        # production
pnpm typecheck          # tsc --noEmit
pnpm lint               # eslint
cargo clippy            # lint Rust (из src-tauri/)
cargo test              # тесты Rust (из src-tauri/)
```

CI: `tsc --noEmit` + `eslint` + `cargo clippy -D warnings`

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

CSS-переменные: `:root` (тёмная) и `[data-theme="light"]`. Слои: `--bg` → `--bg-soft`/`--bg-hard` → `--bg-card` → `--bg-hover` → `--input-bg`. Акцент: `--accent`, `--accent-stroke`, `--accent-icon`. НЕ хардкодить цвета. Палитра: `memory/palette.md` (auto-memory)

## Работа с пользователем

- **Сначала обсудить — потом писать код.** Не строить фичи без одобрения
- **Баги и мелочи** — ответственность агента, не дёргать пользователя
- **Одно изменение за раз.** Сделал → проверил → следующее
- `pnpm tauri dev` запускает **пользователь**. Интерфейс на английском, общение на русском

## Брендинг

**aitherflow** — Oswald, aither Bold 700, flow Extra Light 200. GitHub: github.com/aitherlab-dev/aitherflow
