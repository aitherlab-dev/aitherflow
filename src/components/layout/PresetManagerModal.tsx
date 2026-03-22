import { useState, useEffect, useCallback } from "react";
import { X, Trash2 } from "lucide-react";
import { invoke } from "../../lib/transport";
import type { TeamPreset } from "../../types/projects";
import type { RoleEntry } from "../../types/team";

interface PresetManagerModalProps {
  onClose: () => void;
}

export function PresetManagerModal({ onClose }: PresetManagerModalProps) {
  const [presets, setPresets] = useState<TeamPreset[]>([]);
  const [roles, setRoles] = useState<RoleEntry[]>([]);
  const [newName, setNewName] = useState("");
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);

  const loadData = useCallback(async () => {
    try {
      const [p, r] = await Promise.all([
        invoke<TeamPreset[]>("presets_list"),
        invoke<RoleEntry[]>("roles_list"),
      ]);
      setPresets(p);
      setRoles(r);
    } catch (e) {
      console.error("[PresetManagerModal] Failed to load data:", e);
    }
  }, []);

  useEffect(() => {
    loadData().catch(console.error);
  }, [loadData]);

  const handleDelete = useCallback(async (id: string) => {
    try {
      await invoke("presets_delete", { id });
      setPresets((prev) => prev.filter((p) => p.id !== id));
    } catch (e) {
      console.error("[PresetManagerModal] Failed to delete preset:", e);
    }
  }, []);

  const toggleRole = useCallback((roleName: string) => {
    setSelectedRoles((prev) =>
      prev.includes(roleName)
        ? prev.filter((r) => r !== roleName)
        : [...prev, roleName],
    );
  }, []);

  const handleSave = useCallback(async () => {
    const trimmed = newName.trim();
    if (!trimmed || selectedRoles.length === 0) return;

    const preset: Omit<TeamPreset, "id" | "is_builtin"> & { id?: string } = {
      name: trimmed,
      roles: selectedRoles,
    };

    try {
      await invoke("presets_save", { preset });
      setNewName("");
      setSelectedRoles([]);
      await loadData();
    } catch (e) {
      console.error("[PresetManagerModal] Failed to save preset:", e);
    }
  }, [newName, selectedRoles, loadData]);

  const canSave = newName.trim().length > 0 && selectedRoles.length > 0;

  return (
    <div className="preset-modal-overlay" onClick={onClose}>
      <div className="preset-modal" onClick={(e) => e.stopPropagation()}>
        <div className="preset-modal-header">
          <span className="preset-modal-title">Team Presets</span>
          <button className="preset-modal-close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {presets.length > 0 && (
          <div className="preset-modal-list">
            {presets.map((p) => (
              <div key={p.id} className="preset-modal-item">
                <div className="preset-modal-item-info">
                  <span className="preset-modal-item-name">{p.name}</span>
                  <span className="preset-modal-item-roles">
                    {p.roles.join(", ")}
                  </span>
                </div>
                {!p.is_builtin && (
                  <button
                    className="preset-modal-item-delete"
                    onClick={() => handleDelete(p.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="preset-modal-form">
          <span className="preset-modal-form-title">New Preset</span>
          <input
            className="preset-modal-input"
            placeholder="Preset name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.code === "Enter" && canSave) handleSave();
            }}
          />
          <div className="preset-modal-roles">
            {roles.map((r) => (
              <button
                key={r.name}
                className={`preset-modal-role-chip${selectedRoles.includes(r.name) ? " preset-modal-role-chip--selected" : ""}`}
                onClick={() => toggleRole(r.name)}
              >
                {r.name}
              </button>
            ))}
          </div>
          <button
            className="preset-modal-save"
            disabled={!canSave}
            onClick={handleSave}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
