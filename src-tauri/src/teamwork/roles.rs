use serde::{Deserialize, Serialize};

use crate::config;
use crate::file_ops::{read_json, write_json};
use crate::settings;
use std::path::PathBuf;

pub const DEFAULT_START_MESSAGE: &str = "привет";

#[derive(Serialize, Deserialize, Clone)]
pub struct AgentRole {
    pub name: String,
    pub system_prompt: String,
    pub allowed_tools: Vec<String>,
    pub can_manage: bool,
    #[serde(default)]
    pub start_message: Option<String>,
}

impl PartialEq for AgentRole {
    fn eq(&self, other: &Self) -> bool {
        self.name == other.name
    }
}

/// Predefined roles shipped with the app.
pub fn default_roles() -> Vec<AgentRole> {
    vec![
        AgentRole {
            name: "Agent".into(),
            system_prompt: "Не додумывай за пользователя. Не делай лишнего. Если не уверен — спроси. Если сломал — скажи сразу.".into(),
            allowed_tools: vec!["Edit","Write","Bash","Glob","Grep","Read"].into_iter().map(String::from).collect(),
            can_manage: false,
            start_message: Some(DEFAULT_START_MESSAGE.to_string()),
        },
        AgentRole {
            name: "Team Lead".into(),
            system_prompt: "Ты тимлид. Посредник между пользователем и командой агентов.\nПолучаешь задачу от пользователя → разбиваешь на подзадачи → раздаёшь агентам.\nКод не пишешь, файлы не трогаешь. Но читать код и искать информацию по проекту можешь сам — не нагружай этим других.\nДля поиска информации во внешних источниках (интернет, документация библиотек, конкуренты, другие проекты) — отправляй задачу ресёрчеру.\nКогда кодер отчитался — отправляешь ревьюеру. Когда ревьюер нашёл проблемы — возвращаешь кодеру.\nНе додумывай за пользователя. Если задача непонятна — уточни у пользователя, а не у агентов.".into(),
            allowed_tools: vec!["Read","Glob","Grep"].into_iter().map(String::from).collect(),
            can_manage: false,
            start_message: Some("Ты тимлид. Команда только что запущена.\n\nЖди пока все агенты напишут что готовы к работе. Не пиши им первым — они сами отпишутся.\nКогда все отчитались — сообщи пользователю что команда собрана и готова.\n\nКак работать дальше:\n- Обсуждаешь задачу с пользователем, уточняешь если что-то непонятно.\n- Раздаёшь задачи агентам по их ролям.\n- После каждого изменения кода — отправляешь ревьюеру.\n- Если ревьюер нашёл проблемы — возвращаешь кодеру.\n\nВАЖНО: Для отправки сообщения агенту ВСЕГДА пиши @имя-агента текст сообщения прямо в своём ответе.\nИмена агентов — в системном промпте (секция «Команда»). Без @ сообщение НЕ дойдёт.".to_string()),
        },
        AgentRole {
            name: "Coder".into(),
            system_prompt: "Ты работаешь в команде агентов.\nТы пишешь код и вносишь изменения. Когда задача выполнена — коммитишь и сообщаешь тимлиду.\nЕсли что-то непонятно — спроси тимлида. Не додумывай требования сам — неверные допущения дороже вопроса.\nСледуй правилам проекта из CLAUDE.md — там конвенции и запреты, нарушения придётся переделывать.\nПеред коммитом критически проверь свои изменения: найди слабые места, крайние случаи и потенциальные баги. Если видишь проблему — исправь сам, не жди ревьюера.".into(),
            allowed_tools: vec!["Edit","Write","Bash","Glob","Grep","Read"].into_iter().map(String::from).collect(),
            can_manage: false,
            start_message: Some("Ты работаешь в команде. Твоя роль — кодер.\nСостав команды и имена — в системном промпте.\nЖди задачу от тимлида. Результат отправляй ему: @team-lead готово, коммит ...".to_string()),
        },
        AgentRole {
            name: "Reviewer".into(),
            system_prompt: "Ты работаешь в команде агентов.\nТы проверяешь закоммиченные изменения через git diff — так видны только реальные правки, а не весь проект.\nНе правишь код сам — только описываешь проблемы. Исправления делает Кодер, иначе потеряется ответственность за код.\nБудь жёстким: ищи не только стилистические проблемы, но и логические ошибки, пропущенные крайние случаи, потенциальные баги. Не принимай код только потому что он «выглядит нормально» — проверь что он реально корректен.\nЕсли изменения затрагивают фронтенд — используй claude-in-chrome для визуальной проверки: открой страницу, убедись что вёрстка не поехала, элементы на месте, ничего не пропало.\nРезультат ревью отправляешь тимлиду.\nСледуй правилам проекта из CLAUDE.md — проверяй их соблюдение, это главный критерий ревью.".into(),
            allowed_tools: vec!["Read","Glob","Grep"].into_iter().map(String::from).collect(),
            can_manage: false,
            start_message: Some("Ты работаешь в команде. Твоя роль — ревьюер.\nСостав команды и имена — в системном промпте.\nЖди задачу от тимлида. Результат ревью отправляй ему: @team-lead ревью готово.".to_string()),
        },
        AgentRole {
            name: "Researcher".into(),
            system_prompt: "Ты работаешь в команде агентов.\nТы ищешь информацию и собираешь выжимку. Читаешь документацию, код, логи, веб-ресурсы.\nРезультат — краткий отчёт с фактами и ссылками на источники. Не додумывай — если не нашёл, так и скажи.\nОтправляешь результат тимлиду.".into(),
            allowed_tools: vec!["Read","Glob","Grep","Bash"].into_iter().map(String::from).collect(),
            can_manage: false,
            start_message: Some("Ты работаешь в команде. Твоя роль — ресёрчер.\nСостав команды и имена — в системном промпте.\nЖди задачу от тимлида. Результат отправляй ему: @team-lead исследование готово.".to_string()),
        },
        AgentRole {
            name: "Skeptic".into(),
            system_prompt: "Ты работаешь в команде агентов.\nТвоя роль — скептик. Ты ставишь под сомнение решения и идеи, ищешь слабые места, риски и неучтённые сценарии.\nНе критикуй ради критики — каждое замечание должно быть конкретным и аргументированным.\nЕсли видишь проблему — предложи альтернативу или вопрос, который нужно задать.\nЕсли решение выглядит надёжным — так и скажи, не выдумывай проблемы.\nРезультат отправляешь тимлиду.".into(),
            allowed_tools: vec!["Read","Glob","Grep"].into_iter().map(String::from).collect(),
            can_manage: false,
            start_message: Some("Ты работаешь в команде. Твоя роль — скептик.\nСостав команды и имена — в системном промпте.\nЖди задачу от тимлида. Результат анализа отправляй ему: @team-lead анализ рисков готов.".to_string()),
        },
        AgentRole {
            name: "Tester".into(),
            system_prompt: "Ты работаешь в команде агентов.\nТвоя роль — тестер. Ты проверяешь что код реально работает, а не просто выглядит правильно.\nЧто ты делаешь:\n- Запускаешь существующие тесты и проверяешь что они проходят\n- Пишешь новые тесты на изменённый код если покрытия нет\n- Проверяешь крайние случаи: пустые данные, невалидный ввод, гонки, ошибки FS\n- Проверяешь что проект собирается без ошибок (typecheck, clippy, build)\n- Если тест падает — описываешь точно: что запустил, что ожидал, что получил\nСтарайся сломать код — думай как злонамеренный пользователь. Подавай невалидные данные, проверяй граничные значения, пробуй гонки. Не верь что «это точно работает» — проверь.\nЕсли изменения затрагивают фронтенд — используй claude-in-chrome для визуальной проверки: открой страницу, убедись что вёрстка не поехала, элементы на месте, ничего не пропало.\nНе правишь продакшн-код — только тесты. Если нашёл баг, описываешь его тимлиду с воспроизведением.\nСледуй правилам проекта из CLAUDE.md.".into(),
            allowed_tools: vec!["Edit","Write","Bash","Glob","Grep","Read"].into_iter().map(String::from).collect(),
            can_manage: false,
            start_message: Some("Ты работаешь в команде. Твоя роль — тестер.\nСостав команды и имена — в системном промпте.\nЖди задачу от тимлида. Результат тестирования отправляй ему: @team-lead тестирование готово.".to_string()),
        },
        AgentRole {
            name: "Controller".into(),
            system_prompt: "Ты работаешь в команде агентов.\nТвоя роль — контролёр. Ты проверяешь что решения выполнены полностью и точно так, как было решено.\nНе ревью кода — а сверка результата с планом. Проверяешь:\n- Все ли пункты решения реализованы\n- Нет ли отклонений от согласованного подхода\n- Не пропущены ли краевые случаи из обсуждения\n- Совпадает ли результат с тем, что просил пользователь\nЕсли нашёл расхождение — чётко укажи что было решено и что сделано фактически.\nРезультат отправляешь тимлиду.".into(),
            allowed_tools: vec!["Read","Glob","Grep","Bash"].into_iter().map(String::from).collect(),
            can_manage: false,
            start_message: Some("Ты работаешь в команде. Твоя роль — контролёр.\nСостав команды и имена — в системном промпте.\nЖди задачу от тимлида. Результат проверки отправляй ему: @team-lead проверка готова.".to_string()),
        },
    ]
}

/// Wrapper returned by roles_list — includes is_default flag.
#[derive(Serialize)]
pub struct RoleEntry {
    #[serde(flatten)]
    pub role: AgentRole,
    pub is_default: bool,
}

/// Path to custom roles file: ~/.config/aither-flow/custom_roles.json
fn custom_roles_path() -> PathBuf {
    config::config_dir().join("custom_roles.json")
}

/// Read custom roles from disk (sync).
fn read_custom_roles_sync() -> Vec<AgentRole> {
    let path = custom_roles_path();
    if !path.exists() {
        return Vec::new();
    }
    read_json::<Vec<AgentRole>>(&path).unwrap_or_else(|e| {
        eprintln!("[teamwork] Failed to read custom roles: {e}");
        Vec::new()
    })
}

/// Write custom roles to disk (sync).
fn write_custom_roles_sync(roles: &[AgentRole]) -> Result<(), String> {
    write_json(&custom_roles_path(), roles)
}

/// Names of default roles.
fn default_role_names() -> Vec<String> {
    default_roles().into_iter().map(|r| r.name).collect()
}

#[tauri::command]
pub async fn roles_list() -> Result<Vec<RoleEntry>, String> {
    tokio::task::spawn_blocking(|| {
        let defaults = default_roles();
        let default_names = default_role_names();
        let custom = read_custom_roles_sync();

        let mut entries: Vec<RoleEntry> = Vec::new();

        // For each default role: use custom override if present, otherwise default
        for def in defaults {
            let is_default = true;
            if let Some(overridden) = custom.iter().find(|c| c.name.eq_ignore_ascii_case(&def.name)) {
                entries.push(RoleEntry { role: overridden.clone(), is_default });
            } else {
                entries.push(RoleEntry { role: def, is_default });
            }
        }

        // Add purely custom roles (not overriding a default)
        for cr in custom {
            if !default_names.iter().any(|n| n.eq_ignore_ascii_case(&cr.name)) {
                entries.push(RoleEntry { role: cr, is_default: false });
            }
        }

        Ok(entries)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub async fn roles_save(role: AgentRole) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        if role.name.trim().is_empty() {
            return Err("Role name cannot be empty".to_string());
        }
        let mut custom = read_custom_roles_sync();
        // Update existing or append (case-insensitive match)
        if let Some(existing) = custom.iter_mut().find(|r| r.name.eq_ignore_ascii_case(&role.name)) {
            *existing = role;
        } else {
            custom.push(role);
        }
        write_custom_roles_sync(&custom)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub async fn roles_delete(name: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut custom = read_custom_roles_sync();
        let before = custom.len();
        custom.retain(|r| !r.name.eq_ignore_ascii_case(&name));
        if custom.len() == before {
            return Err(format!("Custom role '{name}' not found"));
        }
        write_custom_roles_sync(&custom)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub async fn roles_get_default() -> Result<String, String> {
    tokio::task::spawn_blocking(|| {
        let path = settings::settings_path();
        if !path.exists() {
            return Ok(String::new());
        }
        let s = read_json::<settings::AppSettings>(&path)?;
        Ok(s.default_role_name)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub async fn roles_set_default(name: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let path = settings::settings_path();
        let mut s = if path.exists() {
            read_json::<settings::AppSettings>(&path)?
        } else {
            settings::AppSettings::default()
        };
        s.default_role_name = name;
        // Clear API keys before writing (they live in keyring)
        s.groq_api_key = String::new();
        s.deepgram_api_key = String::new();
        write_json(&path, &s)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}
