# CLAUDE.md

## Проект

aitherflow — десктопная GUI-обёртка для Claude Code CLI. CLI — единственный движок; GUI управляет процессами и показывает результаты.

## Стек

- **Бэкенд:** Rust / Tauri 2
- **Фронтенд:** React 19 + TypeScript + Vite + Tailwind CSS v4
- **Тема:** тёплая палитра (dark: кофейные тона, light: aitherlab.org), CSS-переменные
- **Данные:** JSON (чаты, настройки)
- **Платформы:** Linux

## Структура

- `src/components/` — React-компоненты по доменам
- `src/hooks/`, `src/stores/` (Zustand), `src/types/`, `src/lib/`, `src/services/`
- `src/stores/chatStreamHandler.ts` — обработка CLI-событий, стриминг, inline quotes
- `src-tauri/src/` — Tauri-команды, ядро в `conductor/`, модули по доменам
- `src-tauri/src/scheduler/` — cron-планировщик задач
- `src-tauri/src/teamwork/` — мультиагентная работа (mailbox, MCP)
- `src-tauri/src/voice/` — голосовой ввод (Whisper)
- `src-tauri/src/external_models/` — OpenRouter и другие провайдеры

## Команды

```bash
pnpm tauri dev          # dev-режим
pnpm tauri build        # production
pnpm typecheck          # tsc --noEmit
pnpm lint               # eslint
cargo clippy            # lint Rust (из src-tauri/)
cargo test              # тесты Rust (из src-tauri/)
```

CI: `tsc --noEmit` + `eslint` + `cargo clippy -D warnings`. Release на тег `v*`

## Как работает

**CLI-интеграция:** `claude -p --output-format stream-json --input-format stream-json --verbose --include-partial-messages`

Поток: `system (init)` → `stream_event (content_block_delta)` × N → `assistant` → `result`

**Мультиагенты:** каждый агент — отдельный CLI-процесс. `SessionManager` хранит `HashMap<agent_id, AgentSession>`. На фронте `agentStates: Map<agentId, AgentChatState>`.

**Пути:** XDG через `dirs` crate. Конфиги `~/.config/aither-flow/`, данные `~/.local/share/aither-flow/`

**RAG:** `src-tauri/src/rag/`, MCP-сервер `aitherflow-knowledge` (search, list, get_docs, reindex)

**Image Gen:** MCP sidecar `mcp-image-gen` (diffusion-rs). Модели в JSON-конфиге, CUDA через feature flag

**Teamwork:** мультиагенты общаются через mailbox (файловая система). `write_if_idle()` для инъекции сообщений только когда агент свободен. MCP-сервер `teamwork` для координации

**Scheduler:** cron-задачи через `src-tauri/src/scheduler/`. Визуальный конструктор расписаний, локальный timezone, Telegram-уведомления

**Inline Quotes:** пользователь может отправить сообщение во время стриминга — оно вставляется как blockquote в текущий ответ ассистента (`> **User:** текст`). CLI ставит в очередь, обрабатывает на следующем ходу

**Subscription Usage:** OAuth-токен из `~/.claude/.credentials.json`, эндпоинт `GET api.anthropic.com/api/oauth/usage`. Кэш 60с, retry при 429

## Подводные камни

**Rust:**
- `spawn_blocking` для ВСЕХ `#[tauri::command]` с `std::fs::*`, `Path::exists()`, `Command::new()`
- `atomic_write()` для записи файлов, `validate_path_safe()` для пользовательских путей
- `entry.file_type()` вместо `entry.path().is_dir()` — избегать блокирующий `stat()`
- Не проглатывать ошибки: НЕ `let _ =`, логировать через `.map_err()`
- Пути: только `PathBuf` / `dirs` crate, никаких захардкоженных `/`

**TypeScript/React:**
- **НЕ добавлять Virtuoso / виртуализацию в MessageList.** Убран осознанно: конфликтует с автоскроллом при стриминге, дёргает layout, ломает UX. Простой div + ResizeObserver + memo работает нормально даже на 500+ сообщениях
- Иконки: **только Lucide React**. Никаких CSS-иконок, никакого инлайн-SVG
- Все цвета через CSS-переменные, никаких захардкоженных hex
- Не проглатывать ошибки: `.catch(console.error)`, НЕ `.catch(() => {})`
- `useShallow` обязателен для `.filter()` / `.map()` в Zustand-селекторах
- Стриминг: plain text во время стриминга, markdown только после завершения
- Горячие клавиши через `e.code`. Только Alt+* и Ctrl+*, НЕ Super
- React хуки ДО любого раннего `return null`

**Стриминг и inline quotes:**
- При `messageComplete` CLI присылает свой текст, который заменяет `streamingMessage.text`. Если были inline-цитаты — они извлекаются regex и добавляются к финальному тексту
- `turnComplete` берёт `sm` как есть — цитаты не теряются

**Zustand:**
- Каждый модуль = свой стор. Модули не знают друг о друге
- Cross-store: `storeB.getState().action()`, НИКОГДА React-хуки из двух сторов

## Дизайн-система

CSS-переменные: `:root` (тёмная) и `[data-theme="light"]`. НЕ хардкодить цвета. Палитра: `memory/palette.md`

## Документация

При написании и правке кода — **сверяться с актуальной документацией** через MCP Context7 (`resolve-library-id` → `query-docs`). Особенно для: Tauri 2, React 19, Tailwind CSS v4, Zustand, Vite.

## Работа с пользователем

- **Пользователь работает через GUI (aitherflow), НЕ через терминал.** Рабочая директория занята запущенным приложением
- **ЗАПРЕЩЕНО создавать ветки и делать checkout.** Только `git worktree add` — НИКОГДА `git checkout`/`git switch`/`git branch`. Вся работа вне main — только через worktree
- **Сначала обсудить — потом писать код.** Не строить фичи без одобрения
- **Баги и мелочи** — ответственность агента, не дёргать пользователя
- **Одно изменение за раз.** Сделал → проверил → следующее
- `pnpm tauri dev` запускает **пользователь**. Интерфейс на английском, общение на русском

## Правила работы

- **Аудит кода:** при верификации исправлений — реально проверять diff или текущее состояние кода. Никогда не отмечать как «исправлено» без показа фрагмента кода из файла
- **Скиллы и контент:** следовать файлам скиллов точно. Когда скилл задаёт голос, стиль или формат — точно ему соответствовать. Не скатываться в типовое техническое письмо
- **Контекст:** не писать в память или CLAUDE.md без явной просьбы. Не тратить токены на обширное исследование кодовой базы — сначала спросить, где искать
- **Отладка:** когда пользователь сообщает о баге или краше — задать ОДИН уточняющий вопрос о том, что именно сломалось, прежде чем исследовать. Не предполагать, какой компонент сломан

## Тесты

Rust: `cargo test` из `src-tauri/`. Один тест: `cargo test test_name`.
Фронт: тестов нет (визуальная проверка через GUI).

## Брендинг

**aitherflow** — Oswald, aither Bold 700, flow Extra Light 200. GitHub: github.com/aitherlab-dev/aitherflow

## Свои MCP-серверы

- **mcp-telegram-files** — отправка файлов в Telegram (Rust, stdio)
- **aitherflow-knowledge** — RAG-поиск (SSE, автозапуск, `~/.claude.json`)
- **mcp-image-gen** — генерация картинок (Rust sidecar, stdio, CUDA)
