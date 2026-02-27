# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Проект

Aither Flow — desktop GUI-обёртка для Claude Code CLI. Не замена CLI, а визуальный интерфейс поверх него. CLI — единственный движок, GUI только управляет процессами и показывает результаты.

Полная архитектура: `ARCHITECTURE.md`. Дорожная карта: `ROADMAP.md`.

## Стек

- **Бэкенд:** Rust / Tauri 2 (Cargo workspace: основное приложение + `aither-flow-perms`)
- **Фронтенд:** React 19 + TypeScript + Vite + Tailwind CSS v4
- **Тема:** Gruvbox (dark/light), CSS-переменные
- **Данные:** SQLite + FTS5 (память), JSON (чаты, настройки)
- **Платформы:** Linux (основная), macOS (вторичная). Windows не поддерживается

## Команды

```bash
pnpm tauri dev          # запуск в dev-режиме
pnpm tauri build        # production сборка
pnpm tsc --noEmit       # проверка TypeScript (из корня проекта, НЕ из src-tauri/)
cargo clippy            # lint Rust (из src-tauri/)
pnpm test               # запуск тестов (vitest)
pnpm test -- -t "name"  # запуск одного теста
```

## Архитектура: дирижёр и оркестр

Ядро (дирижёр) общается с CLI через stream-json и раздаёт события модулям через шину. Модули (секции оркестра) не знают друг о друге — общение только через события или ядро. Убрать один модуль — остальные работают.

### Секции
- **Струнные** (данные): чаты, память (SQLite), проекты
- **Духовые** (расширения CLI): навыки, MCP-серверы, агенты, хуки
- **Ударные** (инфраструктура): файл-вьюер, веб-превью, Telegram, крон

### Модули интерфейса
Чат, боковая панель, настройки, веб-превью, файл-вьюер, модалки (единый компонент Modal), статус-бар (с раскрывающимися панелями), хедер — каждый изолирован со своим состоянием.

## Критические архитектурные решения

### Изоляция агентов — фундамент
Каждый агент = самостоятельный контейнер: свои сообщения, сессия, проект, CLI-процесс. Переключение вкладки = показ другого контейнера, НЕ перенастройка общего стейта. Нет общего `activeAgentId` в бизнес-логике.

### Интерактивные разрешения
Отдельный бинарник `aither-flow-perms` (~200 строк Rust, без Tauri). CLI вызывает его через `--permission-prompt-tool`, он общается с GUI по unix socket. MCP-протокол: 3 метода (`initialize`, `tools/list`, `tools/call`).

### Совместимость с CLI
GUI читает/пишет те же файлы что CLI. Навыки, агенты, MCP, хуки, разрешения, CLAUDE.md — единый формат. Никаких параллельных хранилищ.

## CLI-интеграция

```
claude -p --output-format stream-json --input-format stream-json --verbose --include-partial-messages
```

Поток: `system (init)` → `stream_event (content_block_delta)` × N → `assistant` → `result`

Ключевые флаги: `--resume`, `--model`, `--agent`, `--worktree`, `--permission-mode`, `--add-dir`, `--max-turns`, `--max-budget-usd`, `--mcp-config`

## Пути (XDG с первого дня)

- Конфиги: `~/.config/aither-flow/`
- Данные: `~/.local/share/aither-flow/`
- CLI-совместимые: `~/.claude/skills/`, `~/.claude/agents/`, `~/.claude.json`, `~/.claude/settings.json`
- Использовать `dirs` crate для платформенных путей

## Conventions (Rust)

- `platform.rs` — кроссплатформенный модуль с `#[cfg(target_os)]` блоками. Остальной код не знает про ОС
- `atomic_write()` для ВСЕХ записей файлов (write to temp + rename)
- `spawn_blocking` для ВСЕХ `#[tauri::command]` с `std::fs::*`, `Path::exists()`, `Command::new()`
- `validate_path_safe()` для путей от пользователя (на ОБОИХ аргументах при copy/rename)
- `sanitize_id()` для ID в путях файлов (допускает `@` и `.`)
- Общие утилиты в `config.rs`: `get_home_dir()`, `get_claude_home()`, `read_json_file<T>()`, `write_json_file<T>()`
- Никогда не проглатывать ошибки: `.map_err(|e| eprintln!(...)).ok()?`, не `let _ =` и не `.ok()?`
- rusqlite Connection не Send — открывать внутри `spawn_blocking`
- >7 аргументов функции → input struct с `#[derive(Deserialize)]`

## Conventions (TypeScript/React)

- Named exports для компонентов
- `memo()` на тяжёлых компонентах (чат, список сообщений, карточки)
- Все цвета через CSS-переменные Gruvbox, не хардкод
- Единый компонент Modal для всех оверлеев
- Горячие клавиши через `e.code` (работают на любой раскладке). Только Alt+* и Ctrl+*, НЕ Super — Hyprland перехватывает
- Не проглатывать ошибки: `.catch(console.error)`, не `.catch(() => {})`
- React hooks ДО любого раннего `return null`

## Gruvbox Design System

CSS-переменные на `:root` (dark по умолчанию) и `[data-theme="light"]`:
- `--bg`, `--bg-hard`, `--bg-card`, `--accent` (orange), `--fg`, `--fg-muted`, `--border`
- Цвета: `--red`, `--green`, `--blue`, `--yellow`, `--purple`, `--aqua`, `--gray`

## Правила разработки (из ROADMAP.md)

1. Один этап за раз — не забегать вперёд
2. Одно изменение за раз — проверил → следующее
3. Коммит после каждого логического блока с осмысленным сообщением
4. Модули не знают друг о друге — шина событий, не прямые импорты
5. ESLint + Prettier + `cargo clippy` после каждого блока изменений
6. Не изобретать — где CLI имеет формат, использовать его
7. Интерфейс приложения — на английском. Общение с пользователем — на русском

## Правила работы с пользователем

- **Сначала обсуждаем — потом код.** Новые фичи не пилить без одобрения пользователя
- **Баги и мелкие исправления** — зона ответственности агента, не дёргать пользователя
- Пользователь НЕ программист. Объяснять простым языком, без листингов кода
- Код V1 (GUI-Claude) — только как справочник, ничего не копировать
- Всё пишем с чистого листа

## Брендинг

- **Зонтик:** aitherlab (aither = Bold 700 #2a2a2a, lab = Extra Light 200 #d65d0e)
- **Приложение:** aitherflow (aither = Bold 700, flow = Extra Light 200 orange)
- **Шрифт логотипа:** Oswald (Google Fonts), letter-spacing: 0.05em
- **Фон аватарки:** #d6cdbf
- **GitHub:** github.com/aitherlab-dev/aitherflow

## Стейт-менеджмент

Zustand — каждый модуль имеет свой store. Модули не знают друг о друге.

## Язык

Всегда отвечать пользователю на русском.
