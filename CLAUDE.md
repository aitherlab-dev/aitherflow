# CLAUDE.md

## Проект

Aither Flow — десктопная GUI-обёртка для Claude Code CLI. Не замена CLI, а визуальный интерфейс поверх него. CLI — единственный движок; GUI только управляет процессами и показывает результаты.

## Стек

- **Бэкенд:** Rust / Tauri 2
- **Фронтенд:** React 19 + TypeScript + Vite + Tailwind CSS v4
- **Тема:** тёплая палитра (dark: кофейные тона, light: aitherlab.org), CSS-переменные
- **Данные:** JSON (чаты, настройки), позже SQLite (память)
- **Платформы:** Linux (основная), macOS (вторичная)

## Команды

```bash
pnpm tauri dev          # запуск в dev-режиме
pnpm tauri build        # production-сборка
npx tsc --noEmit        # проверка типов (из корня проекта, НЕ из src-tauri/)
cargo clippy            # lint Rust (из src-tauri/)
```

## CLI-интеграция

```
claude -p --output-format stream-json --input-format stream-json --verbose --include-partial-messages
```

Поток: `system (init)` → `stream_event (content_block_delta)` × N → `assistant` → `result`

Флаги: `--resume`, `--model`, `--agent`, `--permission-mode`, `--add-dir`, `--max-turns`, `--max-budget-usd`, `--mcp-config`

## Пути (XDG)

- Конфиги: `~/.config/aither-flow/`
- Данные: `~/.local/share/aither-flow/`
- Workspace: `~/.config/aither-flow/Workspace/` (дефолтный проект, создаётся при первом запуске)
- Чаты: `~/.config/aither-flow/chats/` (JSON-файлы, по одному на чат)
- Проекты: `~/.config/aither-flow/projects.json` (закладки проектов с доп. директориями)
- CLI-совместимые: `~/.claude/skills/`, `~/.claude/agents/`, `~/.claude.json`
- Использовать `dirs` crate для путей

## Tauri-плагины

- `tauri-plugin-opener` — открытие URL/файлов
- `tauri-plugin-shell` — запуск CLI-процессов
- `tauri-plugin-dialog` — нативные диалоги (выбор папки/файла)

## Правила Rust

- `spawn_blocking` для ВСЕХ `#[tauri::command]` с `std::fs::*`, `Path::exists()`, `Command::new()`
- `atomic_write()` для записи файлов (temp + rename)
- `validate_path_safe()` для пользовательских путей
- Не проглатывать ошибки: `.map_err(|e| eprintln!(...)).ok()?`, НЕ `let _ =`
- rusqlite Connection не Send — открывать внутри `spawn_blocking`

## Правила TypeScript/React

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

## Дизайн-система

CSS-переменные на `:root` (тёмная по умолчанию) и `[data-theme="light"]`.

Слои (глубокий → поверхность): `--bg` → `--bg-soft`/`--bg-hard` → `--bg-card` → `--bg-hover` → `--input-bg`.

Акцент — три уровня: `--accent` (#a84e1c, заливка), `--accent-stroke` (штриховые иконки), `--accent-icon` (#d97a4b, особые иконки).

НЕ хардкодить цвета (#xxx) в CSS-стилях компонентов — только через переменные.

Светлая тема (aitherlab.org) — независимая палитра, НЕ инверсия тёмной.

Палитра: `memory/palette.md`.

Сайдбар — два класса вкладок:
- `.sidebar-project` — агенты/проекты: толще (padding 16px), яркий цвет (`--fg`)
- `.sidebar-tab` — функциональные (Settings и т.д.): тоньше (padding 14px), приглушённый (`--fg-muted`)
- Общее: рамка, скругление 6px, фон `--tab-bg-hover`, hover scale 1.04

## Настройки (Settings)

- Полноэкранный слой вместо чата, НЕ модалка
- `layoutStore.activeView`: `'chat'` | `'settings'`
- Закрытие: Escape, кнопка ×, клик по чату в сайдбаре
- Навигация разделов — внутри экрана (слева), НЕ в сайдбаре

## Zustand (стейт)

- Каждый модуль = свой стор. Модули не знают друг о друге
- Tauri event listeners (`listen()`) регистрировать на уровне модуля, НЕ в useEffect
- Cross-store: `storeB.getState().action()`, НИКОГДА React-хуки из двух сторов (бесконечный loop)

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
- Пользователь НЕ программист. Объяснять простым языком
- **НЕ ссылаться на код** в объяснениях (file:line, имена переменных, Rust-конструкции). Объяснять только логику
- `pnpm tauri dev` для проверки запускает **пользователь**. Агент запускает только для отладки своего кода
- Интерфейс на английском. Общение с пользователем на русском

## Брендинг

- **aitherflow** (aither = Bold 700 #2a2a2a, flow = Extra Light 200 #d65d0e)
- Шрифт логотипа: Oswald (Google Fonts), letter-spacing: 0.05em
- GitHub: github.com/aitherlab-dev/aitherflow
