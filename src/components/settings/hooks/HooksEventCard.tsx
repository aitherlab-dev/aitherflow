import { useCallback } from "react";
import { ChevronRight, Plus, Trash2 } from "lucide-react";
import type { HookEvent, HookEntry, HookHandler, HookScope } from "../../../types/hooks";
import { HOOK_EVENT_DESCRIPTIONS, MATCHER_EVENTS } from "../../../types/hooks";
import { HookEntryCard } from "./HookEntryCard";
import { Tooltip } from "../../shared/Tooltip";

interface Props {
  event: HookEvent;
  entries: HookEntry[];
  expanded: boolean;
  scope: HookScope;
  onToggle: () => void;
  onUpdate: (entries: HookEntry[]) => void;
  onDelete: () => void;
  projectPath?: string;
}

export function HooksEventCard({
  event, entries, expanded, scope, onToggle, onUpdate, onDelete, projectPath,
}: Props) {
  const handleAddEntry = useCallback(() => {
    const newEntry: HookEntry = {
      hooks: [{ type: "command", command: "" }],
    };
    if (MATCHER_EVENTS.includes(event)) {
      newEntry.matcher = "";
    }
    onUpdate([...entries, newEntry]);
  }, [entries, event, onUpdate]);

  const handleUpdateEntry = useCallback(
    (index: number, entry: HookEntry) => {
      const updated = [...entries];
      updated[index] = entry;
      onUpdate(updated);
    },
    [entries, onUpdate],
  );

  const handleDeleteEntry = useCallback(
    (index: number) => {
      const updated = entries.filter((_, i) => i !== index);
      onUpdate(updated);
    },
    [entries, onUpdate],
  );

  const handleReorderHandlers = useCallback(
    (entryIndex: number, fromIdx: number, toIdx: number) => {
      const updated = [...entries];
      const entry = { ...updated[entryIndex] };
      const handlers = [...entry.hooks];
      const [moved] = handlers.splice(fromIdx, 1);
      handlers.splice(toIdx, 0, moved);
      entry.hooks = handlers;
      updated[entryIndex] = entry;
      onUpdate(updated);
    },
    [entries, onUpdate],
  );

  const handleUpdateHandler = useCallback(
    (entryIndex: number, handlerIndex: number, handler: HookHandler) => {
      const updated = [...entries];
      const entry = { ...updated[entryIndex] };
      const handlers = [...entry.hooks];
      handlers[handlerIndex] = handler;
      entry.hooks = handlers;
      updated[entryIndex] = entry;
      onUpdate(updated);
    },
    [entries, onUpdate],
  );

  const handleDeleteHandler = useCallback(
    (entryIndex: number, handlerIndex: number) => {
      const updated = [...entries];
      const entry = { ...updated[entryIndex] };
      entry.hooks = entry.hooks.filter((_, i) => i !== handlerIndex);
      updated[entryIndex] = entry;
      onUpdate(updated);
    },
    [entries, onUpdate],
  );

  const handleAddHandler = useCallback(
    (entryIndex: number) => {
      const updated = [...entries];
      const entry = { ...updated[entryIndex] };
      entry.hooks = [...entry.hooks, { type: "command", command: "" }];
      updated[entryIndex] = entry;
      onUpdate(updated);
    },
    [entries, onUpdate],
  );

  const totalHandlers = entries.reduce((sum, e) => sum + e.hooks.length, 0);

  return (
    <div className="hooks-event-card">
      <div className="hooks-event-header" onClick={onToggle}>
        <ChevronRight
          size={14}
          className={`hooks-chevron ${expanded ? "hooks-chevron--open" : ""}`}
        />
        <span className="hooks-event-name">{event}</span>
        <span className="hooks-event-desc">{HOOK_EVENT_DESCRIPTIONS[event]}</span>
        {totalHandlers > 0 && (
          <span className="hooks-badge">{totalHandlers}</span>
        )}
        <Tooltip text="Remove event">
          <button
            className="hooks-delete-btn"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
          >
            <Trash2 size={13} />
          </button>
        </Tooltip>
      </div>

      {expanded && (
        <div className="hooks-event-body">
          {entries.map((entry, idx) => (
            <HookEntryCard
              key={idx}
              entry={entry}
              event={event}
              entryIndex={idx}
              scope={scope}
              onUpdateEntry={(e) => handleUpdateEntry(idx, e)}
              onDeleteEntry={() => handleDeleteEntry(idx)}
              onUpdateHandler={(hi, h) => handleUpdateHandler(idx, hi, h)}
              onDeleteHandler={(hi) => handleDeleteHandler(idx, hi)}
              onAddHandler={() => handleAddHandler(idx)}
              onReorderHandlers={(from, to) => handleReorderHandlers(idx, from, to)}
              projectPath={projectPath}
            />
          ))}
          <button className="hooks-add-entry-btn" onClick={handleAddEntry}>
            <Plus size={13} />
            Add entry
          </button>
        </div>
      )}
    </div>
  );
}
