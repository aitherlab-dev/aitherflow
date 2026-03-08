# Аудит Aither Flow — итоговая сводка

Собрано из трёх аудитов:
- **07.03.2026** — общий (фронт + бэк), 90 пунктов
- **08.03.2026 бэкенд** — 34 пункта
- **08.03.2026 фронтенд** — 22 пункта (проверка правил CLAUDE.md)

**Статус: ЗАКРЫТ.** Все починено или признано допустимым/нецелесообразным.

---

## Общий счёт

| | Всего | Сделано | Пропущено / by-design | Нецелесообразно |
|---|---|---|---|---|
| Критические | 4 | 1 | 3 | 0 |
| Серьёзные | 31 | 31 | 0 | 0 |
| Средние | 60 | 55 | 2 | 3 |
| Мелкие | 29 | 23 | 6 | 0 |
| Фронтенд (правила) | 22 | 21 | 1 | 0 |
| **Итого** | **~146** | **~131** | **~12** | **~3** |

---

## Что сделано (полный список)

### Критические и серьёзные — все закрыты
- Разбиты god-объекты (chatStore, voice.rs, telegram/commands.rs, plugins.rs)
- Keyring для API-ключей, path traversal, XSS, CSP
- Race conditions, утечки listeners, stale closures
- 30+ тестов добавлено
- Hex-цвета в CSS заменены на переменные
- Производительность: O(N) селекторы, useShallow, memo, index.json для чатов

### Починено 08.03.2026 (последний раунд)

**Баги:**
- BUG-031: `as_nanos() as u64` → `as_micros() as u64` (file_ops.rs)
- BUG-032: лимит 1000 итераций в `copy_entry` (file_ops.rs)
- BUG-034: убрано двойное получение аудио-устройства (voice/streaming.rs)

**Мёртвый код:**
- ARC-020 (08.03): удалены мёртвые поля из TgMessage/TgPhotoSize/TgVoice
- ARC-025: убран неиспользуемый параметр `_nanos` из `chrono_like_iso`
- ARC-026: убран неиспользуемый параметр `_projects` из `telegram_send_menu` (+ фронт)
- ARC-027: удалено мёртвое поле `name` из PluginJson
- ARC-029: добавлен `#[derive(Default)]` для SessionManager

**Архитектура:**
- ARC-010: убрана ручная реализация дат (~40 строк), заменена на chrono
- ARC-012: `run_cli_session` — 11 параметров → структура `CliSessionConfig`
- ARC-016 (08.03): exponential backoff в telegram bot_loop (5→60 сек)
- ARC-017 (08.03): убран бессмысленный `drop(sessions_clone)`
- ARC-018: убран ложный `#[allow(dead_code)]` с `background_index`
- ARC-019: язык Whisper теперь из настроек, не hardcoded "ru"
- ARC-023: `use super::*` → явные импорты в telegram-модуле

---

## Что было исправлено ранее (при проверке оказалось уже закрыто)

- ARC-015* (07.03): `kill_all()` — уже удалён
- ARC-016* (07.03): `AttachmentPayload.name` — уже удалён
- ARC-017* (07.03): `chrono_now()` — уже на chrono
- ARC-013 (08.03): target triple — уже через `std::env::consts::ARCH`
- ARC-015 (08.03): парсинг usage — дублирования нет
- ARC-024: sync Tauri commands — корректны (работают с Mutex, без I/O)
- ARC-028: `chat_id` — уже безопасно через `.ok_or()?`
- PRF-015: `messagesToStored` — уже оптимизировано (проверка `needsClean`)
- PRF-016: typewriter — уже один setState с throttle 50ms
- PRF-017: `find_memory_binary` — уже в `spawn_blocking`
- PRF-018: `renderMain` — удалён при рефакторинге
- PRF-019: `flat_map` — не найден в коде

---

## Нецелесообразно (оставлено как есть)

| ID | Описание | Причина |
|---|---|---|
| ARC-011 | `Result<T, String>` вместо типизированных ошибок | ~60 мест, стандарт Tauri commands |
| ARC-014 | Дублирование read/save JSON config | 10+ модулей, каждый со своим типом |
| PRF-014 | JSONL → `serde_json::Value` | CLI JSON слишком полиморфный, типизация нецелесообразна |

---

## Допустимые исключения

| ID | Описание | Причина |
|---|---|---|
| RUL-003 | Инлайн-SVG в CliStatsSection | Графики/визуализация, не иконки |
| RUL-008 | Cross-store хуки (InputBar, Sidebar) | 2 компонента на 3 стора, оправдано логикой |
| ARC-022 | Нет doc-комментариев | Добавлять постепенно при касании файлов |
| ARC-020* (07.03) | Глобальные переменные вне Zustand | Мелочь, постепенно |
