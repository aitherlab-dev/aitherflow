# MCP Servers — секция в Settings

## Что делаем

Новый раздел «MCP Servers» в Settings. Две вкладки: Global / Project. Управление MCP-серверами — просмотр, добавление, редактирование, удаление, тест подключения. Без импорта из Claude Desktop.

## Макет

Шапка (одна строка):
- Заголовок «MCP Servers»
- Вкладки `Global (N)` / `Project (N)` с счётчиками
- Галка `Strict` (строгий режим)
- Кнопка `+ Add Server`

Под шапкой:
- Инфо-строка: путь к файлу (`~/.claude.json` или `.mcp.json`). Для Project — кнопка «Reset choices»

Список серверов — карточки (как в Hooks):
- Свёрнутая: имя, бейдж типа (stdio/sse/http), команда/URL
- Раскрытая: инлайн-редактирование всех полей + кнопки Test / Delete

Форма добавления:
- `+ Add Server` раскрывает форму над списком
- Поля: имя, тип (stdio/sse/http), команда/URL, аргументы, переменные окружения, заголовки
- Save / Cancel

## Файлы

### 1. Rust бэкенд — `src-tauri/src/mcp.rs` (новый)

Команды:
- `list_mcp_servers(project_path)` — собирает серверы из `~/.claude.json` (global) и `.mcp.json` (project)
- `add_global_mcp_server(name, config)` — через CLI: `claude mcp add-json <name> '<json>'`
- `remove_global_mcp_server(name)` — через CLI: `claude mcp remove <name>`
- `save_project_mcp_servers(project_path, servers)` — atomic_write в `.mcp.json`
- `test_mcp_server(server_type, command_or_url, args, env)` — stdio: запуск процесса на 500мс, sse/http: HTTP-запрос
- `reset_mcp_project_choices(project_path)` — через CLI: `claude mcp reset-project-choices`

Зарегистрировать в `lib.rs` в `invoke_handler`.

### 2. Типы — `src/types/mcp.ts` (новый)

```
McpServerType = "stdio" | "sse" | "http"
McpServer { name, serverType, command?, url?, args?, env?, headers? }
McpScope = "global" | "project"
McpData { global: McpServer[], project: McpServer[] }
```

### 3. Стор — `src/stores/mcpStore.ts` (новый)

```
McpState {
  global: McpServer[]
  project: McpServer[]
  loaded: boolean
  testing: Set<string>       // имена серверов в процессе теста
  testResults: Map<string, {ok, message}>

  load(projectPath)
  addServer(scope, name, config)
  removeServer(scope, name)
  updateServer(scope, name, config)
  testServer(name, config)
  resetChoices(projectPath)
}
```

### 4. Компонент — `src/components/settings/McpSection.tsx` (новый)

Структура:
- `McpSection` — основной, вкладки Global/Project, загрузка данных
- `McpServerCard` — карточка сервера (expand/collapse, инлайн-редактирование)
- `McpAddForm` — форма добавления нового сервера

Паттерн: как HooksSection — expand через Set в state, chevron с ротацией, инлайн-поля, debounced save.

### 5. Регистрация в Settings

`SettingsView.tsx`:
- Добавить в NAV_ITEMS: `{ id: "mcp", label: "MCP Servers", icon: Cable }` (Cable из lucide-react, подходит для MCP/подключений)
- Добавить в SectionContent: `if (section === "mcp") return <McpSection />`

### 6. Стили

`src/styles/settings.css` — добавить стили для MCP. Переиспользовать паттерны из hooks (карточки, chevron, инпуты, бейджи). Специфичные: шапка с вкладками и кнопками в строку, инфо-строка с путём.

## Порядок работы

1. Rust: `mcp.rs` + регистрация в `lib.rs`
2. Типы: `src/types/mcp.ts`
3. Стор: `src/stores/mcpStore.ts`
4. Компонент: `McpSection.tsx`
5. Регистрация в `SettingsView.tsx`
6. Стили в `settings.css`
7. Проверка typecheck + clippy
