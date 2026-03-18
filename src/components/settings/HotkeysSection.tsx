import { useState, useEffect, useCallback } from "react";
import { RotateCcw } from "lucide-react";
import { Tooltip } from "../shared/Tooltip";
import {
  useHotkeyStore,
  HOTKEY_LABELS,
  HOTKEY_ACTION_ORDER,
  DEFAULT_BINDINGS,
  bindingToString,
  type HotkeyAction,
  type HotkeyBinding,
} from "../../stores/hotkeyStore";

export function HotkeysSection() {
  const bindings = useHotkeyStore((s) => s.bindings);
  const setBinding = useHotkeyStore((s) => s.setBinding);
  const resetBinding = useHotkeyStore((s) => s.resetBinding);
  const resetAll = useHotkeyStore((s) => s.resetAll);
  const voicePushToTalk = useHotkeyStore((s) => s.voicePushToTalk);
  const setVoicePushToTalk = useHotkeyStore((s) => s.setVoicePushToTalk);

  const [recording, setRecording] = useState<HotkeyAction | null>(null);

  return (
    <div className="settings-section-hotkeys">
      <div className="hotkeys-header-row">
        <p className="settings-toggle-desc">
          Click a shortcut to record a new binding. Press Escape to cancel.
        </p>
        <Tooltip text="Reset all to defaults">
          <button className="hotkeys-reset-all" onClick={resetAll}>
            <RotateCcw size={14} />
            <span>Reset all</span>
          </button>
        </Tooltip>
      </div>

      {/* Voice mode toggle */}
      <div className="settings-toggle-row">
        <div className="settings-toggle-info">
          <span className="settings-toggle-label">Voice hotkey mode</span>
          <span className="settings-toggle-desc">
            {voicePushToTalk
              ? "Push to talk — hold key to record, release to stop"
              : "Toggle — press to start recording, press again to stop"}
          </span>
        </div>
        <select
          className="settings-select"
          value={voicePushToTalk ? "ptt" : "toggle"}
          onChange={(e) => setVoicePushToTalk(e.target.value === "ptt")}
        >
          <option value="ptt">Push to talk</option>
          <option value="toggle">Toggle</option>
        </select>
      </div>

      <div className="hotkeys-table">
        <div className="hotkeys-table-header">
          <span>Action</span>
          <span>Shortcut</span>
          <span />
        </div>
        {HOTKEY_ACTION_ORDER.map((action) => (
          <HotkeyRow
            key={action}
            action={action}
            binding={bindings[action]}
            isDefault={isSameBinding(bindings[action], DEFAULT_BINDINGS[action])}
            isRecording={recording === action}
            onStartRecord={() => setRecording(action)}
            onStopRecord={() => setRecording(null)}
            onSetBinding={(b) => {
              setBinding(action, b);
              setRecording(null);
            }}
            onReset={() => resetBinding(action)}
          />
        ))}
      </div>
    </div>
  );
}

function isSameBinding(a: HotkeyBinding, b: HotkeyBinding): boolean {
  return a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift && a.code === b.code;
}

interface HotkeyRowProps {
  action: HotkeyAction;
  binding: HotkeyBinding;
  isDefault: boolean;
  isRecording: boolean;
  onStartRecord: () => void;
  onStopRecord: () => void;
  onSetBinding: (b: HotkeyBinding) => void;
  onReset: () => void;
}

function HotkeyRow({
  action,
  binding,
  isDefault,
  isRecording,
  onStartRecord,
  onStopRecord,
  onSetBinding,
  onReset,
}: HotkeyRowProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isRecording) return;

      e.preventDefault();
      e.stopPropagation();

      // Escape cancels recording
      if (e.code === "Escape") {
        onStopRecord();
        return;
      }

      // Skip pure modifier presses
      if (["ControlLeft","ControlRight","AltLeft","AltRight","ShiftLeft","ShiftRight","MetaLeft","MetaRight"].includes(e.code)) return;

      // Block Super/Meta combinations — only Alt+* and Ctrl+* allowed
      if (e.metaKey) return;

      // F-keys and Backquote can work without modifiers; everything else needs Alt or Ctrl
      const allowBare = /^F\d{1,2}$/.test(e.code);
      if (!allowBare && !e.ctrlKey && !e.altKey) return;

      onSetBinding({
        ctrl: e.ctrlKey,
        alt: e.altKey,
        shift: e.shiftKey,
        code: e.code,
      });
    },
    [isRecording, onStopRecord, onSetBinding],
  );

  useEffect(() => {
    if (!isRecording) return;
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [isRecording, handleKeyDown]);

  return (
    <div className={`hotkeys-row ${isRecording ? "hotkeys-row--recording" : ""}`}>
      <span className="hotkeys-row-label">{HOTKEY_LABELS[action]}</span>
      <Tooltip text="Click to change">
        <button
          className={`hotkeys-row-binding ${isRecording ? "hotkeys-row-binding--active" : ""}`}
          onClick={onStartRecord}
        >
          {isRecording ? "Press keys…" : bindingToString(binding)}
        </button>
      </Tooltip>
      <Tooltip text="Reset to default">
        <button
          className="hotkeys-row-reset"
          onClick={onReset}
          disabled={isDefault}
        >
          <RotateCcw size={13} />
        </button>
      </Tooltip>
    </div>
  );
}
