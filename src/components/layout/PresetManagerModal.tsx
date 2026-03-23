import { useState, useEffect, useCallback } from "react";
import { X, Minus, Plus } from "lucide-react";
import { invoke } from "../../lib/transport";
import type { TeamPreset } from "../../types/projects";
import type { RoleEntry } from "../../types/team";
import { useLayoutStore } from "../../stores/layoutStore";
import { launchTeam } from "../../stores/agentStore";

const MODEL_OPTIONS = [
  { id: "", label: "Default" },
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
];

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

/** Expand role counts + models to parallel arrays */
function expandRolesAndModels(
  counts: Map<string, number>,
  models: Map<string, string>,
): { roles: string[]; models: string[] } {
  const rolesArr: string[] = [];
  const modelsArr: string[] = [];
  for (const [name, count] of counts) {
    const model = models.get(name) ?? "";
    for (let i = 0; i < count; i++) {
      rolesArr.push(name);
      modelsArr.push(model);
    }
  }
  return { roles: rolesArr, models: modelsArr };
}

export function PresetManagerModal({ projectPath, editPreset, onClose }: PresetManagerModalProps) {
  const [roles, setRoles] = useState<RoleEntry[]>([]);
  const [roleCounts, setRoleCounts] = useState<Map<string, number>>(new Map());
  const [roleModels, setRoleModels] = useState<Map<string, string>>(new Map());
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

  const setRoleModel = useCallback((roleName: string, model: string) => {
    setRoleModels((prev) => {
      const next = new Map(prev);
      if (model) {
        next.set(roleName, model);
      } else {
        next.delete(roleName);
      }
      return next;
    });
  }, []);

  const totalAgents = Array.from(roleCounts.values()).reduce((a, b) => a + b, 0);
  const canLaunch = totalAgents > 0;
  const canSave = presetName.trim().length > 0 && totalAgents > 0;

  const handleLaunch = useCallback(async () => {
    if (!canLaunch) return;
    const { roles: rolesArray, models: modelsArray } = expandRolesAndModels(roleCounts, roleModels);
    const hasModels = modelsArray.some((m) => m !== "");
    try {
      await launchTeam(projectPath, rolesArray, hasModels ? modelsArray : undefined);
      onClose();
      useLayoutStore.getState().closeWelcome();
    } catch (e) {
      console.error("[PresetManagerModal] Failed to launch team:", e);
    }
  }, [canLaunch, roleCounts, roleModels, projectPath, onClose]);

  const handleSave = useCallback(async () => {
    if (!canSave) return;
    const { roles: rolesArray } = expandRolesAndModels(roleCounts, roleModels);
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
  }, [canSave, roleCounts, roleModels, presetName]);

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
                  {count > 0 && (
                    <select
                      className="preset-modal-role-model"
                      value={roleModels.get(r.name) ?? ""}
                      onChange={(e) => setRoleModel(r.name, e.target.value)}
                    >
                      {MODEL_OPTIONS.map((m) => (
                        <option key={m.id} value={m.id}>{m.label}</option>
                      ))}
                    </select>
                  )}
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
