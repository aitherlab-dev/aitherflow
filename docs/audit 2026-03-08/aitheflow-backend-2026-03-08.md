# Аудит архитектуры и качества кода: Aither Flow Backend

**Дата:** 2026-03-08
**Путь:** /home/sasha/WORK/AITHEFLOW/src-tauri/src/
**Стек:** Rust, Tauri 2, tokio, SQLite (rusqlite), reqwest, cpal, WebSocket
**Объём:** ~9250 строк, 34 файла

## Сводка

| Категория | Критических | Серьёзных | Средних | Мелких |
|-----------|-------------|-----------|---------|--------|
| Мёртвый код | 0 | 0 | 3 | 2 |
| Дублирование | 0 | 2 | 3 | 0 |
| Архитектура | 0 | 3 | 4 | 0 |
| Антипаттерны Rust | 0 | 2 | 5 | 3 |
| Тесты | 0 | 2 | 0 | 0 |
| Стиль и документация | 0 | 0 | 2 | 3 |
| **Итого** | **0** | **9** | **17** | **8** |

---

## Серьёзные проблемы

### [ARC-001] ~~God object: telegram/commands.rs — 815 строк, смешение ответственностей~~ ✅ ИСПРАВЛЕНО
- **Исправление:** Разбит на 3 файла: `bot.rs` (бот-цикл + get_bot_connection), `handlers.rs` (обработчики сообщений + утилиты), `commands.rs` (18 Tauri-команд).

### [ARC-002] ~~God object: plugins.rs — 887 строк, 8+ зон ответственности~~ ✅ ИСПРАВЛЕНО
- **Исправление:** Преобразован в модуль `plugins/`: `types.rs` (9 struct + 3 enum), `marketplace.rs` (логика marketplace, git, подсчёты), `commands.rs` (6 Tauri-команд).

### [ARC-003] ~~Глобальное мутабельное состояние через static Mutex без типобезопасной обёртки~~ ✅ ИСПРАВЛЕНО
- **Исправление:** Добавлена документация контракта на `with_state` (только быстрые операции под локом). Все точки `unwrap_or_else(|e| e.into_inner())` во всех модулях (telegram, chats, devtools, stats) теперь логируют предупреждение при отравлении мьютекса вместо молчаливого восстановления.

### [ARC-004] ~~Дублирование кода: `get_bot_connection` vs inline в `telegram_send_history`~~ ✅ ИСПРАВЛЕНО
- **Исправление:** `telegram_send_history` теперь использует общий `get_bot_connection()` из `bot.rs`. Исправлено в рамках рефакторинга ARC-001.

### [ARC-005] ~~Дублирование: audio capture код в recording.rs и streaming.rs~~ ✅ ИСПРАВЛЕНО
- **Исправление:** Вынесена общая функция `build_input_stream()` в новый файл `voice/capture.rs`. Оба файла (`recording.rs`, `streaming.rs`) используют её.

### [ARC-006] ~~Антипаттерн: unwrap() в production-коде~~ ✅ ИСПРАВЛЕНО
- **Исправление:** Заменено `ft.is_err() || !ft.unwrap().is_dir()` на идиоматичное `!ft.is_ok_and(|t| t.is_dir())` в `skills.rs`.

### [ARC-007] ~~Антипаттерн: многократное создание reqwest::Client~~ ✅ ИСПРАВЛЕНО
- **Исправление:** В `voice/groq.rs` добавлен `static HTTP_CLIENT: LazyLock<reqwest::Client>` — один клиент на весь процесс. В Telegram клиент уже сохранялся в BotState.

### [ARC-008] ~~Отсутствие тестов для всех модулей кроме conductor/parser~~ ✅ ИСПРАВЛЕНО
- **Исправление:** Добавлены тесты для: `validate_path_safe` (6 тестов, files.rs), `sanitize_fts_query` (6 тестов, memory/db.rs), `split_message` (6 тестов, telegram/api.rs), `parse_data_uri` (6 тестов, attachments.rs), `days_to_ymd` + `chrono_like_iso` (6 тестов, memory/indexer.rs). Всего 30 новых тестов, итого 39 (было 9).

### [ARC-009] ~~Отсутствие тестов для date/calendar алгоритма~~ ✅ ИСПРАВЛЕНО
- **Исправление:** Добавлены тесты для `days_to_ymd` (epoch, known dates, leap day, end of year) и `chrono_like_iso` (epoch, known timestamp, with time). Исправлено в рамках ARC-008.

---

## Средние проблемы

### [ARC-010] Избыточная chrono-зависимость при наличии ручной реализации
- **Файл:** `src/memory/indexer.rs:66-101` vs `Cargo.toml` (chrono = "0.4")
- **Серьёзность:** СРЕДНЯЯ
- **Описание:** В indexer.rs вручную реализованы `chrono_like_iso` и `days_to_ymd` с комментарием "avoids chrono dependency", но chrono уже в зависимостях (используется в stats.rs и plugins.rs). Дублирование функциональности.
- **Риск:** Потенциальные расхождения между ручной и chrono-имплементацией дат.

### [ARC-011] Строковые ошибки вместо типизированных
- **Файл:** весь проект
- **Серьёзность:** СРЕДНЯЯ
- **Описание:** Все функции возвращают `Result<T, String>`. Ни одного кастомного типа ошибки. Это характерно для Tauri-команд (они требуют Serialize), но внутренние функции (db.rs, indexer.rs, file_ops.rs) тоже используют String. Нет возможности программно различить типы ошибок (IO vs parse vs not found).
- **Риск:** Невозможность granular error handling. Клиентский код вынужден парсить строки ошибок для принятия решений.

### [ARC-012] `run_cli_session` — 11 параметров, подавленный clippy
- **Файл:** `src/conductor/process.rs:37`
- **Серьёзность:** СРЕДНЯЯ
- **Описание:** Функция принимает 11 параметров и помечена `#[allow(clippy::too_many_arguments)]`. `StartSessionOptions` уже существует как struct — но вместо передачи целиком, поля разбираются в `mod.rs` и передаются отдельно.
- **Риск:** Каждый новый параметр требует правки в 3 местах (struct, деструктуризация, сигнатура). Высокая вероятность ошибки.

### [ARC-013] find_memory_binary — Linux-only, hardcoded target triple
- **Файл:** `src/conductor/process.rs:358-361`
- **Серьёзность:** СРЕДНЯЯ
- **Описание:** `format!("{}-unknown-linux-gnu", std::env::consts::ARCH)` — захардкожен Linux GNU target. На musl-системах (Alpine), macOS или Windows бинарь не будет найден.
- **Риск:** Memory MCP server не подключится на не-glibc Linux и других ОС.

### [ARC-014] Дублирование паттерна "read JSON config / save JSON config"
- **Файл:** `src/projects.rs`, `src/agents.rs`, `src/settings.rs`, `src/hooks.rs`, `src/telegram/mod.rs`
- **Серьёзность:** СРЕДНЯЯ
- **Описание:** Во всех 5 модулях повторяется один и тот же паттерн: `fn xxx_path() -> PathBuf`, `read_to_string → from_str → modify → to_string_pretty → atomic_write`. Это ~15-20 строк в каждом модуле. Нет обобщённого хелпера для JSON config persistence.
- **Риск:** Нарушение DRY, сложность при изменении формата хранения.

### [ARC-015] Дублирование логики парсинга usage токенов
- **Файл:** `src/conductor/parser.rs:110-134` vs `src/conductor/mod.rs:210-234`
- **Серьёзность:** СРЕДНЯЯ
- **Описание:** Извлечение `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens` из JSON value дублируется в parser.rs (assistant event) и в mod.rs (get_session_usage). Идентичный код с теми же JSON pointer-ами.
- **Риск:** При изменении формата API — придётся менять в двух местах.

### [ARC-016] Отсутствие rate limiting в telegram bot_loop
- **Файл:** `src/telegram/commands.rs:25-120`
- **Серьёзность:** СРЕДНЯЯ
- **Описание:** `bot_loop` делает `tg_get_updates` в бесконечном цикле. При ошибке — sleep 5 сек и повтор. Но при успешных запросах нет никакой паузы — цикл мгновенно уходит в следующий long-poll (timeout 30s). Это нормально для long-polling, но при серии быстрых ошибок (401, 409) будет спам с 5-секундным интервалом без backoff.
- **Риск:** При невалидном токене — бесконечный цикл ошибок с 5-секундным интервалом, засоряющий stderr.

### [ARC-017] `drop(sessions_clone)` в lib.rs setup — бессмысленный drop
- **Файл:** `src/lib.rs:168`
- **Серьёзность:** СРЕДНЯЯ
- **Описание:** `drop(sessions_clone)` в конце async блока. Переменная и так бы dropped в конце scope. Комментария нет — неясно, зачем это. Если это было для раннего освобождения Arc — оно не раннее, т.к. стоит перед `Ok(())`.
- **Риск:** Мёртвый код, вводит в заблуждение читателя.

### [ARC-018] `background_index` помечен `#[allow(dead_code)]` но используется
- **Файл:** `src/memory/mod.rs:22-23`
- **Серьёзность:** СРЕДНЯЯ
- **Описание:** Функция `background_index` имеет `#[allow(dead_code)]`, но реально вызывается из `conductor/process.rs:101` и `conductor/process.rs:251`. Атрибут либо устарел, либо был добавлен ошибочно.
- **Риск:** Ложный сигнал разработчику, что код не используется.

### [ARC-019] Hardcoded language "ru" в Telegram voice transcription
- **Файл:** `src/telegram/api.rs:335`
- **Серьёзность:** СРЕДНЯЯ
- **Описание:** `groq_transcribe` передаёт `.text("language", "ru")` — язык жёстко задан русским. Но в `voice/groq.rs` язык передаётся параметром. Telegram-модуль не использует настройку `voice_language` из settings.
- **Риск:** Транскрибация голосовых в Telegram всегда на русском, даже если пользователь говорит на другом языке.

### [ARC-020] Мёртвый код: `TgMessage::message_id`
- **Файл:** `src/telegram/mod.rs:78-80`
- **Серьёзность:** СРЕДНЯЯ
- **Описание:** Поле `message_id` в `TgMessage` помечено `#[allow(dead_code)]` — десериализуется, но нигде не читается. Аналогично `width/height` в `TgPhotoSize` и `duration` в `TgVoice`.
- **Риск:** Бесполезная десериализация, загромождение кода.

### [ARC-021] `atomic_write` — truncation при nanos overflow
- **Файл:** `src/file_ops.rs:53-58`
- **Серьёзность:** СРЕДНЯЯ
- **Описание:** `as_nanos() as u64` — `as_nanos()` возвращает `u128`, приведение к `u64` обрежет значение. С 1970 года nanos уже перевалили за `u64::MAX` (это ~584 года, пока безопасно), но для hex-суффикса temp-файла хватило бы `as_millis()` или random.
- **Риск:** Теоретическая коллизия имён temp-файлов (крайне маловероятно на практике).

---

## Мелкие замечания

### [ARC-022] Отсутствие `///` документации для pub API в нескольких модулях
- **Файл:** `src/secrets.rs`, `src/config.rs`, `src/telegram/api.rs`
- **Серьёзность:** МЕЛКАЯ
- **Описание:** Большинство pub-функций имеют doc-комментарии (хорошо), но в secrets.rs, config.rs, telegram/api.rs — отсутствуют для ряда pub-функций. Не критично для private crate, но снижает discoverability.

### [ARC-023] Непоследовательность: `use super::*` в telegram/commands.rs
- **Файл:** `src/telegram/commands.rs:4`
- **Серьёзность:** МЕЛКАЯ
- **Описание:** Единственный файл в проекте, использующий `use super::*`. Все остальные модули импортируют конкретные типы. Glob import скрывает зависимости.

### [ARC-024] Непоследовательность: sync vs async Tauri commands
- **Файл:** `src/telegram/commands.rs:441,552,567,583,809`
- **Серьёзность:** МЕЛКАЯ
- **Описание:** Часть Tauri-команд в telegram/commands.rs — синхронные (`pub fn`), часть — async. Синхронные команды (`get_telegram_status`, `poll_telegram_messages`, `send_to_telegram`, `notify_telegram`, `telegram_stream_reset`) держат std::sync::Mutex lock из tokio runtime thread. Для коротких операций это допустимо, но непоследовательно.

### [ARC-025] Мёртвый параметр `_nanos` в chrono_like_iso
- **Файл:** `src/memory/indexer.rs:66`
- **Серьёзность:** МЕЛКАЯ
- **Описание:** Параметр `_nanos: u64` принимается, но игнорируется (prefixed с `_`). Вызывающий код в строке 57 передаёт nanos — они теряются.

### [ARC-026] Мёртвый параметр `_projects` в telegram_send_menu
- **Файл:** `src/telegram/commands.rs:616`
- **Серьёзность:** МЕЛКАЯ
- **Описание:** Параметр `_projects: Vec<serde_json::Value>` принимается от фронтенда, но не используется. Лишний трафик через IPC.

### [ARC-027] `name` в `PluginJson` помечен `#[allow(dead_code)]`
- **Файл:** `src/plugins.rs:171-172`
- **Серьёзность:** МЕЛКАЯ
- **Описание:** Поле десериализуется, но нигде не используется.

### [ARC-028] Нет проверки `chat_id` в telegram callback handler
- **Файл:** `src/telegram/commands.rs:571-572`
- **Серьёзность:** МЕЛКАЯ
- **Описание:** `send_to_telegram` использует `state.config.chat_id.unwrap_or(0)` и проверяет `!= 0`. Аналогично в `notify_telegram`. Это рабочий подход, но `0` — валидный chat_id в Telegram (хоть и нереальный). Лучше проверять через `Option::Some`.

### [ARC-029] Отсутствие `Default` impl для `SessionManager`
- **Файл:** `src/conductor/session.rs:27`
- **Серьёзность:** МЕЛКАЯ
- **Описание:** `SessionManager::new()` вручную создаёт Arc<Mutex<HashMap>>, но не реализует `Default`. Clippy выдаст warning `new_without_default`.

---

## Общая оценка

Кодовая база в хорошем состоянии для проекта такого масштаба. Основные сильные стороны:

- Консистентное использование `spawn_blocking` для IO-операций
- `atomic_write` для защиты от corruption при записи конфигов
- Секреты мигрируются из JSON в system keyring
- Хорошая обработка ошибок в большинстве мест (нет голых `unwrap()` в production коде, кроме одного случая)
- Тесты для парсера CLI — самого сложного компонента

Основные области для улучшения:

1. **Разбить god objects** (telegram/commands.rs, plugins.rs) на подмодули
2. **Устранить дублирование** (audio capture, bot connection, usage parsing, JSON config CRUD)
3. **Добавить тесты** для security-critical функций (validate_path_safe, sanitize_fts_query) и calendar math
4. **Переиспользовать reqwest::Client** вместо создания нового на каждый вызов
5. **Передавать StartSessionOptions целиком** в run_cli_session вместо 11 отдельных параметров
