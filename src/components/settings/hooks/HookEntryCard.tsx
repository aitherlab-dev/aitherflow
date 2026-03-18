import { useCallback, useRef, useState } from "react";
import { GripVertical, Plus, Trash2 } from "lucide-react";
import type { HookEvent, HookEntry, HookHandler, HookScope } from "../../../types/hooks";
import { MATCHER_EVENTS } from "../../../types/hooks";
import { HookHandlerForm } from "./HookHandlerForm";
import { Tooltip } from "../../shared/Tooltip";

interface Props {
  entry: HookEntry;
  event: HookEvent;
  entryIndex: number;
  scope: HookScope;
  onUpdateEntry: (entry: HookEntry) => void;
  onDeleteEntry: () => void;
  onUpdateHandler: (handlerIndex: number, handler: HookHandler) => void;
  onDeleteHandler: (handlerIndex: number) => void;
  onAddHandler: () => void;
  onReorderHandlers: (fromIndex: number, toIndex: number) => void;
  projectPath?: string;
}

export function HookEntryCard({
  entry, event, entryIndex, scope,
  onUpdateEntry, onDeleteEntry,
  onUpdateHandler, onDeleteHandler, onAddHandler,
  onReorderHandlers, projectPath,
}: Props) {
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const dragItemRef = useRef<number | null>(null);
  const supportsMatcher = MATCHER_EVENTS.includes(event);

  const handleMatcherChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onUpdateEntry({ ...entry, matcher: e.target.value });
    },
    [entry, onUpdateEntry],
  );

  const validateMatcher = useCallback((value: string): string | null => {
    if (!value) return null;
    try {
      new RegExp(value);
      return null;
    } catch {
      return "Invalid regex pattern";
    }
  }, []);

  // Drag & drop handlers
  const handleDragStart = useCallback((idx: number) => {
    dragItemRef.current = idx;
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, idx: number) => {
    e.preventDefault();
    setDragOverIndex(idx);
  }, []);

  const handleDrop = useCallback(
    (idx: number) => {
      if (dragItemRef.current !== null && dragItemRef.current !== idx) {
        onReorderHandlers(dragItemRef.current, idx);
      }
      dragItemRef.current = null;
      setDragOverIndex(null);
    },
    [onReorderHandlers],
  );

  const handleDragEnd = useCallback(() => {
    dragItemRef.current = null;
    setDragOverIndex(null);
  }, []);

  const matcherError = supportsMatcher && entry.matcher ? validateMatcher(entry.matcher) : null;

  return (
    <div className="hooks-entry-card">
      <div className="hooks-entry-header">
        {supportsMatcher && (
          <div className="hooks-matcher-field">
            <label className="hooks-field-label">Matcher (regex)</label>
            <input
              type="text"
              className={`hooks-input ${matcherError ? "hooks-input--error" : ""}`}
              value={entry.matcher ?? ""}
              onChange={handleMatcherChange}
              placeholder={event === "PreToolUse" ? 'e.g. Bash, Edit|Write' : "optional filter"}
            />
            {matcherError && <span className="hooks-validation-error">{matcherError}</span>}
          </div>
        )}
        <Tooltip text="Remove entry">
          <button
            className="hooks-delete-btn"
            onClick={onDeleteEntry}
          >
            <Trash2 size={13} />
          </button>
        </Tooltip>
      </div>

      <div className="hooks-handler-list">
        {entry.hooks.map((handler, idx) => (
          <div
            key={idx}
            className={`hooks-handler-wrapper ${dragOverIndex === idx ? "hooks-handler-wrapper--drag-over" : ""}`}
            draggable
            onDragStart={() => handleDragStart(idx)}
            onDragOver={(e) => handleDragOver(e, idx)}
            onDrop={() => handleDrop(idx)}
            onDragEnd={handleDragEnd}
          >
            <Tooltip text="Drag to reorder">
              <div className="hooks-drag-handle">
                <GripVertical size={14} />
              </div>
            </Tooltip>
            <HookHandlerForm
              handler={handler}
              onUpdate={(h) => onUpdateHandler(idx, h)}
              onDelete={() => onDeleteHandler(idx)}
              projectPath={projectPath}
              scope={scope}
              event={event}
              entryIndex={entryIndex}
              handlerIndex={idx}
            />
          </div>
        ))}
      </div>

      <button className="hooks-add-handler-btn" onClick={onAddHandler}>
        <Plus size={12} />
        Add handler
      </button>
    </div>
  );
}
