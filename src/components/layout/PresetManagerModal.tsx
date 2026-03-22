import { useState, useEffect, useCallback } from "react";
import { X, Minus, Plus } from "lucide-react";
import { invoke } from "../../lib/transport";
import type { TeamPreset } from "../../types/projects";
import type { RoleEntry } from "../../types/team";
import { useLayoutStore } from "../../stores/layoutStore";
import { launchTeam } from "../../stores/agentStore";

interface PresetManagerModalProps {
  projectPath: string;
  /** If set, pre-fill role counters from this preset */
  editPreset?: TeamPreset;
  onClose: () => void;
}

/** Count occurrences of each role name in a flat roles array */
function countRoles(roles: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of roles) {
    counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  return counts;
}

/** Expand role counts back to flat array: {Coder: 3, Reviewer: 1} → ["Coder","Coder","Coder","Reviewer"] */
function expandRoles(counts: Map<string, number>): string[] {
  const result: string[] = [];
  for (const [name, count] of counts) {
    for (let i = 0; i < count; i++) result.push(name);
  }
  return result;
}

export function PresetManagerModal({ projectPath, editPreset, onClose }: PresetManagerModalProps) {
  const [roles, setRoles] = useState<RoleEntry[]>([]);
  const [roleCounts, setRoleCounts] = useState<Map<string, number>>(new Map());
  const [presetName, setPresetName] = useState("");

  const loadRoles = useCallback(async () => {
    try {
      const r = await invoke<RoleEntry[]>("roles_list");
      setRoles(r);
    } catch (e) {
      console.error("[PresetManagerModal] Failed to load roles:", e);
    }
  }, []);

  useEffect(() => {
    loadRoles().catch(console.error);
  }, [loadRoles]);

  // Pre-fill from editPreset
  useEffect(() => {
    if (editPreset) {
      setRoleCounts(countRoles(editPreset.roles));
      setPresetName(editPreset.name);
    }
  }, [editPreset]);

  const adjustCount = useCallback((roleName: string, delta: number) => {
    setRoleCounts((prev) => {
      const next = new Map(prev);
      const current = next.get(roleName) ?? 0;
      const newVal = Math.max(0, current + delta);
      if (newVal === 0) {
        next.delete(roleName);
      } else {
        next.set(roleName, newVal);
      }
      return next;
    });
  }, []);

  const totalAgents = Array.from(roleCounts.values()).reduce((a, b) => a + b, 0);
  const canLaunch = totalAgents > 0;
  const canSave = presetName.trim().length > 0 && totalAgents > 0;

  const handleLaunch = useCallback(async () => {
    if (!canLaunch) return;
    const rolesArray = expandRoles(roleCounts);
    try {
      await launchTeam(projectPath, rolesArray);
      onClose();
      useLayoutStore.getState().closeWelcome();
    } catch (e) {
      console.error("[PresetManagerModal] Failed to launch team:", e);
    }
  }, [canLaunch, roleCounts, projectPath, onClose]);

  const handleSave = useCallback(async () => {
    if (!canSave) return;
    const rolesArray = expandRoles(roleCounts);
    const preset: Omit<TeamPreset, "id" | "is_builtin"> & { id?: string } = {
      name: presetName.trim(),
      roles: rolesArray,
    };
    try {
      await invoke("presets_save", { preset });
      setPresetName("");
    } catch (e) {
      console.error("[PresetManagerModal] Failed to save preset:", e);
    }
  }, [canSave, roleCounts, presetName]);

  return (
    <div className="preset-modal-overlay" onClick={onClose}>
      <div className="preset-modal" onClick={(e) => e.stopPropagation()}>
        <div className="preset-modal-header">
          <span className="preset-modal-title">Launch Team</span>
          <button className="preset-modal-close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {/* Role counters */}
        <div className="preset-modal-roles-list">
          {roles.filter((r) => r.name !== "Agent").map((r) => {
            const count = roleCounts.get(r.name) ?? 0;
            return (
              <div key={r.name} className="preset-modal-role-row">
                <span className="preset-modal-role-name">{r.name}</span>
                <div className="preset-modal-role-controls">
                  <button
                    className="preset-modal-role-btn"
                    disabled={count === 0}
                    onClick={() => adjustCount(r.name, -1)}
                  >
                    <Minus size={14} />
                  </button>
                  <span className={`preset-modal-role-count${count > 0 ? " preset-modal-role-count--active" : ""}`}>
                    {count}
                  </span>
                  <button
                    className="preset-modal-role-btn"
                    onClick={() => adjustCount(r.name, 1)}
                  >
                    <Plus size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* Optional preset name */}
        <input
          className="preset-modal-input"
          placeholder="Preset name (optional)"
          value={presetName}
          onChange={(e) => setPresetName(e.target.value)}
        />

        {/* Action buttons */}
        <div className="preset-modal-actions">
          <button
            className="preset-modal-btn-secondary"
            disabled={!canSave}
            onClick={handleSave}
          >
            Save
          </button>
          <button
            className="preset-modal-btn-primary"
            disabled={!canLaunch}
            onClick={handleLaunch}
          >
            Launch ({totalAgents})
          </button>
        </div>
      </div>
    </div>
  );
}
