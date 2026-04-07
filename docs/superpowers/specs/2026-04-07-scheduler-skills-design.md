# Scheduler: Skill Picker for Cron Tasks

## Problem

Scheduler tasks accept only a freeform prompt. Users cannot select a skill (slash command) to run on schedule. Manually copying skill prompts is fragile — skills evolve, but the copied text stays stale.

## Solution

Add a skill dropdown to the scheduler task editor. Selecting a skill inserts its `/command` at the beginning of the prompt field. The prompt remains fully editable — users can append arguments or context after the command.

## Design

### UI Changes (SchedulerSection.tsx only)

A `<select>` labeled "Skill" appears above the prompt textarea. Default value: "None".

**Skill list contents (filtered by task's selected project):**
- Global skills — always shown
- Plugin skills — always shown
- Project skills — only from the project selected in the task's "Project" field

**Grouping via `<optgroup>`:**
- Global
- Plugins (grouped by plugin name)
- Project (only if the selected project has skills)

### Behavior

1. **Select skill** — `/command` inserted at the start of prompt (with a space separator). If prompt was empty, just `/command`.
2. **Change skill** — old `/command` at the start replaced with new one.
3. **Select "None"** — `/command` prefix removed from prompt.
4. **Change project** — if current skill is a project skill from a different project, reset skill to "None" and remove the command prefix.
5. **Edit prompt manually** — no interference. The dropdown is a convenience, not a constraint. If the user manually deletes the `/command` from the prompt text, the dropdown state becomes stale but this is harmless — on next save it's just a prompt string.

### State Management

- Skills loaded from `useSkillStore` (already available app-wide via `skillStore.ts`).
- Local component state: `selectedSkillId: string | null` — tracks which skill is selected in the dropdown.
- On edit of existing task: detect if prompt starts with a known `/command` and pre-select that skill in the dropdown.

### What Does NOT Change

- **Backend (Rust):** Zero changes. `ScheduledTask.prompt` stays a `String`. The `/command` is just text in the prompt — CLI handles it natively.
- **Types:** `ScheduledTask` and `TaskSchedule` unchanged.
- **Runner logic:** `run_cli_session` receives the prompt as-is.
- **Persistence:** `scheduled_tasks.json` format unchanged.

## Files to Modify

| File | Change |
|------|--------|
| `src/components/settings/SchedulerSection.tsx` | Add skill dropdown, filtering logic, prompt prefix management |

## Edge Cases

- **No skills loaded yet:** Dropdown hidden or disabled until `skillStore.loaded` is true.
- **Skill deleted after task created:** Prompt still contains `/command` text — CLI will handle gracefully (skill not found = treated as plain text). Dropdown shows "None" since skill ID is gone.
- **Multiple `/commands` in prompt:** Only the first one is managed by the dropdown. Rest is user's responsibility.
