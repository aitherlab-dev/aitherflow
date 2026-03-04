# CLAUDE.md

## Проект

Aither Flow — десктопная GUI-обёртка для Claude Code CLI. Не замена CLI, а визуальный интерфейс поверх него. CLI — единственный движок; GUI только управляет процессами и показывает результаты.

## Стек

- **Бэкенд:** Rust / Tauri 2
- **Фронтенд:** React 19 + TypeScript + Vite + Tailwind CSS v4
- **Тема:** тёплая палитра (dark: кофейные тона, light: aitherlab.org), CSS-переменные
- **Данные:** JSON (чаты, настройки), SQLite+FTS5 (session memory)
- **Платформы:** Linux (основная), macOS (вторичная)

## Структура

- `src/components/chat/` — чат: сообщения, ввод, рендер markdown
- `src/components/layout/` — каркас: сайдбар, хедер, статусбар, resize
- `src/components/settings/` — экран настроек и проектов
- `src/components/fileviewer/` — просмотр файлов: код, изображения, вкладки
- `src/stores/` — Zustand-сторы (agent, attachment, chat, conductor, fileViewer, layout, plugin, project, skill, translation)
- `src/types/` — TypeScript-типы (agents, chat, conductor, files, fileviewer, plugins, projects, skills)
- `src-tauri/src/conductor/` — ядро: запуск CLI, парсинг потока, управление сессиями
- `src-tauri/src/memory/` — индексер session memory (SQLite+FTS5)
- `src-tauri/src/web_server/` — встроенный Axum-сервер: auth, handlers, WebSocket
- `src-tauri/src/` — Tauri-команды: agents, attachments, chats, config, devtools, files, file_ops, file_watcher, platform, plugins, projects, settings, skills, telegram, translations, voice
- `src-tauri/crates/` — отдельные крейты: `memory-mcp` (MCP-сервер памяти), `aither-flow-perms` (разрешения)

## Команды

```bash
pnpm tauri dev          # запуск в dev-режиме
pnpm tauri build        # production-сборка
pnpm typecheck          # проверка типов (алиас для tsc --noEmit, из корня проекта)
cargo clippy            # lint Rust (из src-tauri/)
pnpm lint               # ESLint
pnpm format             # Prettier
```

CI: GitHub Actions (`ci.yml`) — `tsc --noEmit` + `eslint` + `cargo clippy -D warnings`

## Как работает

**Мультиагенты:** каждый агент — отдельный CLI-процесс. `SessionManager` (Rust) хранит `HashMap<agent_id, AgentSession>`. Переключение агента в UI = переключение контекста (чаты, сообщения), фоновые агенты продолжают работать. `agentStates: Map<agentId, AgentChatState>` на фронте хранит состояние всех агентов, активный синхронизируется с Zustand.

**CLI-интеграция:**

```
claude -p --output-format stream-json --input-format stream-json --verbose --include-partial-messages
```

Поток: `system (init)` → `stream_event (content_block_delta)` × N → `assistant` → `result`

Флаги: `--resume`, `--model`, `--agent`, `--permission-mode`, `--add-dir`, `--max-turns`, `--max-budget-usd`, `--mcp-config`

**Пути (XDG):**

- Конфиги: `~/.config/aither-flow/`
- Данные: `~/.local/share/aither-flow/`
- Workspace: `~/.config/aither-flow/Workspace/` (дефолтный проект, создаётся при первом запуске)
- Чаты: `~/.config/aither-flow/chats/` (JSON-файлы, по одному на чат)
- Проекты: `~/.config/aither-flow/projects.json` (закладки проектов с доп. директориями)
- CLI-совместимые: `~/.claude/skills/`, `~/.claude/agents/`, `~/.claude.json`
- Использовать `dirs` crate для путей

**Tauri-плагины:** `tauri-plugin-opener` (URL/файлы), `tauri-plugin-shell` (CLI-процессы), `tauri-plugin-dialog` (нативные диалоги)

**Settings:** полноэкранный слой вместо чата (НЕ модалка). `layoutStore.activeView`: `'chat'` | `'settings'`. Закрытие: Escape, ×, клик по чату в сайдбаре

**Веб-сервер:** встроенный Axum-сервер, раздаёт React-фронтенд в браузере. Auth: cookie-сессии + bearer token, CSRF-проверка Origin, rate limiting. Конфиг: `~/.config/aither-flow/web-server.json`

**Telegram:** бот для управления агентом из Telegram — отправка сообщений, получение ответов, голосовые (Groq Whisper), стриминг через edit. Конфиг: `~/.config/aither-flow/telegram.json`

## Подводные камни

**Rust:**
- `spawn_blocking` для ВСЕХ `#[tauri::command]` с `std::fs::*`, `Path::exists()`, `Command::new()`
- `atomic_write()` для записи файлов (temp + rename)
- `validate_path_safe()` для пользовательских путей
- `entry.file_type()` вместо `entry.path().is_dir()` для записей каталогов — `is_dir()` вызывает `stat()`, который блокируется на холодных маунтах
- Не проглатывать ошибки: `.map_err(|e| eprintln!(...)).ok()?`, НЕ `let _ =`
- (будущее) rusqlite Connection не Send — открывать внутри `spawn_blocking`

**TypeScript/React:**
- Иконки: **только Lucide React** (`lucide-react`). Никаких CSS-иконок (::before/::after), никакого инлайн-SVG
- Все цвета через CSS-переменные, никаких захардкоженных значений
- `memo()` на тяжёлых компонентах (чат, список сообщений)
- Горячие клавиши через `e.code` (работают на любой раскладке). Только Alt+* и Ctrl+*, НЕ Super
- Не проглатывать ошибки: `.catch(console.error)`, НЕ `.catch(() => {})`
- React хуки ДО любого раннего `return null`
- Стриминг: plain text во время стриминга, markdown только после завершения
- `useShallow` обязателен для `.filter()` / `.map()` в Zustand-селекторах
- CSS transitions отключать на resizable элементах во время drag
- При десериализации JSON: optional массивы могут быть `undefined` — всегда проверять перед `.length`

**Zustand:**
- Каждый модуль = свой стор. Модули не знают друг о друге
- Tauri event listeners (`listen()`) регистрировать на уровне модуля, НЕ в useEffect
- Cross-store: `storeB.getState().action()`, НИКОГДА React-хуки из двух сторов (бесконечный loop)

**Сайдбар:**
- `sidebar-content` — flex с `gap: 4px`. При расчёте визуальных отступов учитывать gap + margin (суммируются)
- Блок агентов (`sidebar-agent-block`) — flex-контейнер с собственным `gap: 6px`, отступы от линий через `padding`

## Дизайн-система

CSS-переменные на `:root` (тёмная по умолчанию) и `[data-theme="light"]`.

Слои (глубокий → поверхность): `--bg` → `--bg-soft`/`--bg-hard` → `--bg-card` → `--bg-hover` → `--input-bg`.

Акцент — три уровня: `--accent` (#a84e1c, заливка), `--accent-stroke` (штриховые иконки), `--accent-icon` (#d97a4b, особые иконки).

НЕ хардкодить цвета (#xxx) в CSS-стилях компонентов — только через переменные.

Светлая тема (aitherlab.org) — независимая палитра, НЕ инверсия тёмной.

Палитра: `~/.claude/projects/-home-sasha-WORK-AITHEFLOW/memory/palette.md`

Сайдбар — два класса вкладок:
- `.sidebar-project` — агенты/проекты: толще (padding 16px), яркий цвет (`--fg`)
- `.sidebar-tab` — функциональные (Settings и т.д.): тоньше (padding 14px), приглушённый (`--fg-muted`)
- Общее: рамка, скругление 6px, фон `--tab-bg-hover`, hover scale 1.04

## ARCHITECTURE.md и ROADMAP.md

- Это **справочные** файлы, НЕ инструкции к исполнению
- НЕ читать их при старте сессии, НЕ использовать как план работ
- Подглядывать в них можно изредка для контекста, но решения принимает пользователь в разговоре
- Что делать дальше — всегда спрашивать у пользователя, а не брать из дорожной карты
- Причина: слепое следование этим документам приводило к многократным откатам — написанное там не отражает реальные ожидания

## Работа с пользователем

- **Сначала обсудить — потом писать код.** Не строить фичи без одобрения
- **Баги и мелочи** — ответственность агента, не дёргать пользователя
- **Одно изменение за раз.** Сделал → `pnpm tauri dev` → проверил → следующее
- `pnpm tauri dev` для проверки запускает **пользователь**. Агент запускает только для отладки своего кода
- Интерфейс на английском. Общение с пользователем на русском

## Брендинг

- **aitherflow** (aither = Bold 700 #2a2a2a, flow = Extra Light 200 #d65d0e)
- Шрифт логотипа: Oswald (Google Fonts), letter-spacing: 0.05em
- GitHub: github.com/aitherlab-dev/aitherflow
