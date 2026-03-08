# Аудит: AITHEFLOW (фронтенд) — соответствие правилам CLAUDE.md

**Дата:** 2026-03-08
**Путь:** /home/sasha/WORK/AITHEFLOW/src/
**Стек:** React 19 + TypeScript + Vite + Tailwind CSS v4 + Zustand
**CLAUDE.md:** найден

## Сводка

| Правило | Нарушений |
|---------|-----------|
| Иконки: только Lucide React | 1 → **0** (не применимо) |
| Цвета через CSS-переменные | 30+ → **0** (исправлено) |
| Не проглатывать ошибки | 0 |
| useShallow для filter/map в Zustand | 0 |
| Стриминг: plain text / markdown | 0 |
| Горячие клавиши через e.code | 1 → **0** (исправлено) |
| Хуки ДО раннего return null | 0 |
| Модули не знают друг о друга (сторы) | 0 (*) |
| Cross-store через getState() | 0 |

(*) Сторы импортируют друг друга, но используют ТОЛЬКО `.getState()` — не React-хуки. Это соответствует правилу.

---

## Нарушения

### [RUL-001] ~~Инлайн-SVG в CliStatsSection (график)~~

> **НЕ ПРИМЕНИМО**
>
> Правило «никакого инлайн-SVG» относится к иконкам. Здесь SVG используется для визуализации данных (график расходов) — это единственный адекватный способ рисовать линии и точки по координатам. Lucide React для этого не подходит, а тащить Recharts ради одного графика — overkill. Ложное срабатывание.

---

### [RUL-002..021] Захардкоженные hex/rgba цвета — ~~30+ нарушений~~

> **ИСПРАВЛЕНО 2026-03-08**
>
> Все захардкоженные hex и rgba() заменены на CSS-переменные. Визуально ничего не изменилось — значения цветов остались прежними.
>
> **Что сделано:**
> - В `theme.css` добавлены новые переменные (в обе темы): `--status-green/red/blue/orange`, `--dev-active*`, `--fg-on-accent`, `--fg-on-accent-muted`, `--error`, `--overlay-bg`, `--diff-add/remove-bg/line`, `--test-ok/fail-bg`, `--code-*` (13 переменных для блоков кода в светлой теме)
> - `layout.css` — 10 замен (devtools, dev-pulse, build-confirm, dash-card dots/toggle/error, cli-stats)
> - `chat.css` — `#e74c3c` → `var(--error)`
> - `settings.css` — toggle, language/memory кнопки, mcp test results; убраны лишние fallback'и
> - `code.css` — 20+ hex в light theme code blocks → `var(--code-*)`
> - `fileviewer.css` — badge, diff кнопки, diff строки
> - `cards.css` — 5 мест с `#fff` и `rgba(255,255,255,0.8)` → `var(--fg-on-accent*)`
> - `welcome.css` — overlay → `var(--overlay-bg)`
> - `TokensCard.tsx` — `USAGE_COLORS` и `getUsageColor()` → CSS-переменные
> - `TelegramSection.tsx` — убран fallback у `var(--error)`

---

### [RUL-022] ~~Использование e.key вместо e.code для фильтрации модификаторов~~

> **ИСПРАВЛЕНО 2026-03-08**
>
> `["Control", "Alt", "Shift", "Meta"].includes(e.key)` заменено на `["ControlLeft","ControlRight","AltLeft","AltRight","ShiftLeft","ShiftRight","MetaLeft","MetaRight"].includes(e.code)` в `HotkeysSection.tsx:121`.

---

## Правила без нарушений

1. **Не проглатывать ошибки** — все `.catch()` содержат `console.error`. Пустых catch-блоков не найдено.
2. **useShallow для filter/map в Zustand** — все `useXxxStore(s => s.xxx.map/filter(...))` обёрнуты в `useShallow`. Остальные селекторы возвращают примитивы или функции (стабильные ссылки).
3. **Стриминг: plain text / markdown** — `AssistantMessage.tsx` при `isStreaming` использует `InlineMarkdown` (лёгкий regex-парсер), после завершения — `MarkdownRenderer`. Соответствует правилу.
4. **React хуки ДО раннего return null** — во всех проверенных компонентах (`ThinkingIndicator`, `GeneralSection`, `VoiceSection`, `TelegramSection`, `HooksSection`, `LanguageSection`, `SkillSection`, `InlineMarkdown`) хуки вызываются до `return null`.
5. **Каждый модуль = свой стор** — сторы не используют React-хуки друг из друга. Cross-store взаимодействие идёт через `.getState()` (проверено: `agentStore`, `chatService`, `conductorStore`, `translationStore`, `chatStreamHandler`, `fileViewerStore`, `projectStore`).
6. **Иконки из Lucide React** — все компоненты импортируют иконки из `lucide-react`. Сторонних иконочных библиотек не обнаружено. CSS-иконок через `::before`/`::after` с Unicode-символами нет (единственный `content: "\2022"` — типографский bullet, не иконка).
