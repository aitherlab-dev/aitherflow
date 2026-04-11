# Аудит кода aitherflow — ISO 25010

**Дата:** 2026-04-09
**Версия:** текущий main (3ea1b40)
**Область:** `src-tauri/src/` (Rust), `src/` (TypeScript/React)
**Метод:** 4 параллельных агента, полное сканирование исходников

---

## Сводная оценка

| Измерение ISO 25010 | Оценка | Ключевая сила | Ключевая слабость |
|---|---|---|---|
| Функциональная корректность | **8/10** | spawn_blocking 100%, atomic_write везде, ошибки не проглатываются | Гонка в scheduler (нет файловой блокировки) |
| Надёжность | **8/10** | Восстановление poisoned mutex, SIGTERM/SIGKILL fallback, stderr cap 64KB | Sync tauri-команды в Telegram без spawn_blocking |
| Безопасность | **8/10** | Нет shell injection нигде, validate_path_safe, validate_git_url | Широкий доступ к $HOME через WebView |
| Производительность | **8/10** | useShallow 100%, memo везде, streaming изолирован | Мелкие аллокации при сортировке |
| Поддерживаемость | **7/10** | Чистые модули, zero `any`, 397 useCallback | God-файлы (image_gen 998 строк), тестов мало |
| Удобство использования | **7/10** | aria-label на всех кнопках, hotkeys, CSS-переменные | Нет подтверждения при удалении чатов/задач |
| Переносимость | **6/10** | XDG, dirs crate, cfg-guards | Linux-only, ARM sidecar gap |
| Совместимость | **9/10** | Полный протокол CLI, адаптации под провайдеров | Localhost заблокирован в MCP HTTP тестах |

**Средняя оценка: 7.6 / 10**

---

## CRITICAL

_Критических находок не обнаружено._

---

## MAJOR

### FS-01: Гонка в scheduler — нет блокировки файла
- **Файл:** `src-tauri/src/scheduler/mod.rs:42-63`
- **Измерение:** Функциональная корректность
- **Проблема:** `load_tasks()` / `save_tasks()` не защищены mutex/file lock. Цикл поллинга (30с) делает load-modify-save для обновления `last_run`/`last_status`, пользователь может одновременно сохранять/удалять задачи через UI. TOCTOU-гонка — правки пользователя могут быть молча перезаписаны.
- **Сравнение:** `chats.rs` использует `CHAT_LOCKS`, `INDEX_LOCK` и `lock_file()` — scheduler не имеет аналога.

### U-01: Удаление чата без подтверждения
- **Файл:** `src/components/layout/chat-panel/ChatPanel.tsx:53`
- **Измерение:** Удобство использования
- **Код:** `deleteChat(id).catch(console.error);`
- **Проблема:** Клик по иконке корзины мгновенно удаляет чат с 250мс fade-анимацией. Нет диалога "Вы уверены?". Один случайный клик — потеря истории.
- **Примечание:** Knowledge bases и Skills используют Modal с danger-вариантом. Паттерн непоследователен.

### U-17: Непоследовательность подтверждений удаления
- **Измерение:** Удобство использования
- **Есть подтверждение:** Knowledge, Skills, Worktrees — используют Modal
- **Нет подтверждения:** Чаты, Scheduler задачи, MCP серверы — удаление по клику
- **Проблема:** Непредсказуемый UX — пользователь не знает когда будет спрошен, а когда нет.

### R-2: Sync tauri-команды в Telegram без spawn_blocking
- **Файлы:** `src-tauri/src/telegram/commands.rs:44, 222, 237, 253, 549`
- **Измерение:** Надёжность
- **Проблема:** `get_telegram_status`, `poll_telegram_messages`, `send_to_telegram`, `notify_telegram`, `telegram_stream_reset` — синхронные `pub fn`, не `async fn`. Tauri запускает их на пуле async-рантайма. Mutex access быстрый, но нарушает собственное правило проекта о `spawn_blocking`.

### R-3: Гонка инициализации embedder — потеря ресурсов
- **Файл:** `src-tauri/src/rag/embedder.rs:45`
- **Код:** `let _ = EMBEDDER.set(info);`
- **Измерение:** Надёжность
- **Проблема:** Если два потока одновременно инициализируют embedder, один загрузит ML-модель (сотни МБ) и молча выбросит её. `OnceLock::set` вернёт `Err`, но результат проглатывается.

### M1: God-файл image_gen.rs — 998 строк
- **Файл:** `src-tauri/src/image_gen.rs`
- **Измерение:** Поддерживаемость
- **Проблема:** Типы, загрузка настроек, управление моделями, валидация имён, скачивание, сканирование lora, и полная логика генерации (435 строк одна функция) — всё в одном файле.

### M2: SchedulerSection.tsx — 793 строки
- **Файл:** `src/components/settings/SchedulerSection.tsx`
- **Измерение:** Поддерживаемость
- **Проблема:** Самый большой фронтенд-компонент. Cron builder, список задач, редактор — можно разделить.

### M5: Тестовое покрытие — только unit-тесты
- **Измерение:** Поддерживаемость
- **Статус:** 139 тестов, все проходят. Покрывают сериализацию, парсеры, валидацию путей, mentions.
- **Пробелы:** Нет интеграционных тестов для tauri-команд, scheduler runner, RAG pipeline, external models client, worktree, plugin install, hooks. Фронтенд — без тестов (по дизайну).

---

## MINOR

### FS-02: mask_key использует байтовый срез
- **Файл:** `src-tauri/src/settings.rs:19-20`
- **Код:** `&key[key.len() - 4..]`
- **Проблема:** Теоретическая паника на multi-byte UTF-8 ключах. На практике API-ключи ASCII-only.

### FS-03: rag/ocr.rs — своя реализация вместо atomic_write
- **Файл:** `src-tauri/src/rag/ocr.rs:247-249`
- **Проблема:** Собственный write-then-rename без UUID в имени temp-файла, без `sync_all()`, без 0600.

### FS-04: scheduler_run_now — гонка с циклом scheduler
- **Файл:** `src-tauri/src/scheduler/commands.rs:72-77`
- **Проблема:** Проверка "уже запущена?" и запуск не атомарны. Связано с FS-01.

### FS-06: 200мс sleep как механизм синхронизации
- **Файл:** `src-tauri/src/scheduler/runner.rs:167`
- **Проблема:** Фиксированная задержка для ожидания фронтенда — хрупко.

### S-4: TOCTOU DNS rebinding в MCP HTTP тесте
- **Файл:** `src-tauri/src/mcp.rs:292-303`
- **Проблема:** DNS проверяется при валидации, curl резолвит заново. Теоретический DNS rebinding. Практический риск минимален — тест без credentials.

### S-5: validate_path_safe разрешает весь $HOME
- **Файл:** `src-tauri/src/files.rs:66-73`
- **Проблема:** Десктоп-приложение, пользователь = атакующий. Но при компрометации WebView — доступ ко всему в HOME.

### P-04: macOS пути в PATH без cfg-guard
- **Файл:** `src-tauri/src/conductor/process.rs:277-278`
- **Код:** `"/usr/local/bin"`, `"/opt/homebrew/bin"` добавляются на всех платформах.

### P-06: Sidecar считает x86_64 дефолтом для не-macOS
- **Файл:** `src-tauri/src/conductor/resolve.rs:23`
- **Проблема:** ARM Linux получит неверный sidecar binary.

### U-05/U-06: Общие сообщения об ошибках
- **Файлы:** `TelegramSection.tsx:81`, `McpAddForm.tsx:36`
- **Проблема:** "Failed to start bot. Check console for details." — пользователь не смотрит в консоль.

### U-10/U-11/U-12: Неполная ARIA-разметка
- Контекстные меню без `role="menu"` / `role="menuitem"`
- Modal без `role="dialog"` / `aria-modal="true"`
- Нет `aria-live` для стриминга

---

## INFORMATIONAL

### Положительные находки

| Категория | Статус |
|---|---|
| `spawn_blocking` на всех tauri-командах с blocking I/O | 100% покрытие (80+ команд) |
| `validate_path_safe()` на пользовательских путях | Применяется везде |
| `atomic_write()` для записи файлов | Везде кроме ocr.rs |
| `useShallow` на Zustand-селекторах с .filter()/.map() | 100% покрытие |
| `entry.file_type()` вместо `entry.path().is_dir()` | 100% покрытие |
| `.catch(console.error)` вместо `.catch(() => {})` | Почти везде |
| Все иконки Lucide React | Подтверждено |
| Все цвета через CSS-переменные | Подтверждено |
| React хуки до early return | Подтверждено |
| Нет `any` типов в TypeScript | Zero instances |
| Нет `dangerouslySetInnerHTML` / XSS-векторов | Подтверждено |
| Нет shell injection (Command::new везде, не sh -c) | Подтверждено |
| Token sanitization в Telegram API | `<TOKEN>` замена в ошибках |
| Git URL валидация | HTTPS-only, percent-decode, traversal detection |
| Hook command injection prevention | Полная фильтрация метасимволов |
| Poisoned mutex recovery | `unwrap_or_else(\|e\| e.into_inner())` везде |

---

## Изменения с прошлого аудита (2026-04-01)

| Пункт из прошлого аудита | Статус |
|---|---|
| SEC-002: Git clone без `--` перед URL | Требует проверки — не подтверждено в этом аудите |
| REL-001: `let _ =` без логирования | Частично актуально (embedder, router, image_gen) |
| REL-003: Таймауты Telegram API | Не проверялось детально |
| PERF-001: std::sync::Mutex в voice | Подтверждено допустимым (cpal callback) |

---

## Рекомендации по приоритету

### Скоро (надёжность, UX)
1. **FS-01:** Добавить mutex или file lock в scheduler load_tasks/save_tasks
2. **U-01/U-17:** Добавить Modal-подтверждение для удаления чатов, scheduler задач, MCP серверов
3. **R-2:** Обернуть sync telegram-команды в spawn_blocking
4. **U-05/U-06:** Показывать реальную ошибку вместо "check console"

### При случае (поддерживаемость)
5. **M1:** Разбить image_gen.rs на подмодули
6. **M2:** Разбить SchedulerSection.tsx на подкомпоненты
7. **FS-03:** Заменить самописный write-rename на atomic_write() в ocr.rs
8. **R-3:** Добавить `OnceLock::get_or_init` вместо гонки set в embedder

### Долгосрочно (качество)
9. **M5:** Интеграционные тесты для tauri-команд
10. **U-10/U-11:** ARIA-разметка на меню и модалы
