import { useState, useEffect, useCallback, useRef } from "react";
import { Plus, Download, Upload, Zap, Info } from "lucide-react";
import { invoke } from "../../../lib/transport";
import { useAgentStore } from "../../../stores/agentStore";
import type { HookEvent, HookEntry, HooksConfig, HookScope } from "../../../types/hooks";
import { HOOK_EVENT_DESCRIPTIONS } from "../../../types/hooks";
import { HooksEventCard } from "./HooksEventCard";
import { HooksTemplates } from "./HooksTemplates";

const ALL_EVENTS: HookEvent[] = [
  "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop",
  "SessionStart", "SessionEnd", "UserPromptSubmit", "PreCompact",
  "Notification", "SubagentStart", "SubagentStop", "InstructionsLoaded",
  "PermissionRequest", "TeammateIdle", "TaskCompleted", "ConfigChange",
  "WorktreeCreate", "WorktreeRemove",
];

export function HooksSection() {
  const [scope, setScope] = useState<HookScope>("global");
  const [globalHooks, setGlobalHooks] = useState<HooksConfig>({});
  const [projectHooks, setProjectHooks] = useState<HooksConfig>({});
  const [loaded, setLoaded] = useState(false);
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(new Set());
  const [showAddEvent, setShowAddEvent] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeAgent = useAgentStore((s) => s.getActiveAgent());
  const projectPath = activeAgent?.projectPath;

  const hooks = scope === "global" ? globalHooks : projectHooks;
  const setHooks = scope === "global" ? setGlobalHooks : setProjectHooks;

  // Load hooks on mount and scope change
  useEffect(() => {
    const loadBoth = async () => {
      try {
        const [g, p] = await Promise.all([
          invoke<HooksConfig>("load_hooks", { scope: "global" }),
          projectPath
            ? invoke<HooksConfig>("load_hooks", { scope: "project", projectPath })
            : Promise.resolve({} as HooksConfig),
        ]);
        setGlobalHooks(g ?? {});
        setProjectHooks(p ?? {});
        setLoaded(true);
      } catch (e) {
        console.error("Failed to load hooks:", e);
        setLoaded(true);
      }
    };
    loadBoth();
  }, [projectPath]);

  // Debounced save
  const saveHooks = useCallback(
    (updated: HooksConfig) => {
      setHooks(updated);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        invoke("save_hooks", {
          scope,
          projectPath: scope === "project" ? projectPath : undefined,
          hooks: updated,
        }).catch(console.error);
      }, 500);
    },
    [scope, projectPath, setHooks],
  );

  const handleAddEvent = useCallback(
    (event: HookEvent) => {
      const updated = { ...hooks };
      if (!updated[event]) {
        updated[event] = [];
      }
      // Add empty entry
      updated[event]!.push({ hooks: [] });
      saveHooks(updated);
      setExpandedEvents((prev) => new Set([...prev, event]));
      setShowAddEvent(false);
    },
    [hooks, saveHooks],
  );

  const handleUpdateEvent = useCallback(
    (event: HookEvent, entries: HookEntry[]) => {
      const updated = { ...hooks, [event]: entries };
      saveHooks(updated);
    },
    [hooks, saveHooks],
  );

  const handleDeleteEvent = useCallback(
    (event: HookEvent) => {
      const updated = { ...hooks };
      delete updated[event];
      saveHooks(updated);
      setExpandedEvents((prev) => {
        const next = new Set(prev);
        next.delete(event);
        return next;
      });
    },
    [hooks, saveHooks],
  );

  const toggleExpanded = useCallback((event: string) => {
    setExpandedEvents((prev) => {
      const next = new Set(prev);
      if (next.has(event)) next.delete(event);
      else next.add(event);
      return next;
    });
  }, []);

  const handleApplyTemplate = useCallback(
    (template: HooksConfig) => {
      const updated = { ...hooks };
      for (const [event, entries] of Object.entries(template)) {
        const ev = event as HookEvent;
        if (!updated[ev]) updated[ev] = [];
        updated[ev]!.push(...(entries as HookEntry[]));
      }
      saveHooks(updated);
      // Expand newly added events
      setExpandedEvents((prev) => {
        const next = new Set(prev);
        for (const event of Object.keys(template)) next.add(event);
        return next;
      });
      setShowTemplates(false);
    },
    [hooks, saveHooks],
  );

  const handleExport = useCallback(async () => {
    try {
      const json = JSON.stringify({ hooks }, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `hooks-${scope}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error("Export failed:", e);
    }
  }, [hooks, scope]);

  const handleImport = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async () => {
      if (!input.files?.[0]) return;
      try {
        const text = await input.files[0].text();
        const data = JSON.parse(text);
        const imported: HooksConfig = data.hooks ?? data;
        saveHooks({ ...hooks, ...imported });
      } catch (e) {
        console.error("Import failed:", e);
      }
    };
    input.click();
  }, [hooks, saveHooks]);

  // Available events for "Add event" dropdown
  const usedEvents = Object.keys(hooks) as HookEvent[];
  const availableEvents = ALL_EVENTS.filter((e) => !usedEvents.includes(e));

  if (!loaded) return null;

  return (
    <div className="hooks-section">
      {/* Info banner */}
      <div className="hooks-info-banner">
        <Info size={16} className="hooks-info-icon" />
        <p>
          Hooks are automatic actions that run when Claude does something — like checking
          commands before execution, logging sessions, or sending notifications.
          Use <strong>Templates</strong> to get started quickly.
        </p>
      </div>

      {/* Scope toggle */}
      <div className="hooks-scope-toggle">
        <button
          className={`hooks-scope-btn ${scope === "global" ? "hooks-scope-btn--active" : ""}`}
          onClick={() => setScope("global")}
        >
          Global
        </button>
        <button
          className={`hooks-scope-btn ${scope === "project" ? "hooks-scope-btn--active" : ""}`}
          onClick={() => setScope("project")}
          disabled={!projectPath}
          title={!projectPath ? "No active project" : undefined}
        >
          Project
        </button>
      </div>

      <p className="hooks-scope-path">
        {scope === "global"
          ? "~/.claude/settings.json"
          : projectPath
            ? `${projectPath}/.claude/settings.json`
            : "No project selected"}
      </p>

      {/* Toolbar */}
      <div className="hooks-toolbar">
        <div className="hooks-toolbar-left">
          <div className="hooks-template-wrapper">
            <button className="hooks-toolbar-btn" onClick={() => setShowTemplates(!showTemplates)}>
              <Zap size={14} />
              Templates
            </button>
            {showTemplates && (
              <HooksTemplates
                onApply={handleApplyTemplate}
                onClose={() => setShowTemplates(false)}
              />
            )}
          </div>
        </div>
        <div className="hooks-toolbar-right">
          <button className="hooks-toolbar-btn" onClick={handleImport} title="Import hooks from JSON">
            <Upload size={14} />
            Import
          </button>
          <button className="hooks-toolbar-btn" onClick={handleExport} title="Export hooks to JSON">
            <Download size={14} />
            Export
          </button>
        </div>
      </div>

      {/* Event list */}
      <div className="hooks-event-list">
        {usedEvents.map((event) => (
          <HooksEventCard
            key={event}
            event={event}
            entries={hooks[event] ?? []}
            expanded={expandedEvents.has(event)}
            scope={scope}
            onToggle={() => toggleExpanded(event)}
            onUpdate={(entries) => handleUpdateEvent(event, entries)}
            onDelete={() => handleDeleteEvent(event)}
            projectPath={projectPath}
          />
        ))}

        {usedEvents.length === 0 && (
          <div className="hooks-empty">
            No hooks configured. Add an event or use a template to get started.
          </div>
        )}
      </div>

      {/* Add event button */}
      <div className="hooks-add-event-wrapper">
        <button
          className="hooks-add-event-btn"
          onClick={() => setShowAddEvent(!showAddEvent)}
        >
          <Plus size={14} />
          Add event
        </button>
        {showAddEvent && (
          <div className="hooks-add-event-dropdown">
            {availableEvents.map((event) => (
              <button
                key={event}
                className="hooks-add-event-option"
                onClick={() => handleAddEvent(event)}
              >
                <span className="hooks-event-name">{event}</span>
                <span className="hooks-event-desc">{HOOK_EVENT_DESCRIPTIONS[event]}</span>
              </button>
            ))}
            {availableEvents.length === 0 && (
              <div className="hooks-add-event-option hooks-add-event-option--disabled">
                All events are in use
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
