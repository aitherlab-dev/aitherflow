import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2, X, RotateCcw, Star } from "lucide-react";
import { invoke } from "../../lib/transport";
import type { AgentRole, RoleEntry } from "../../types/team";
import { Tooltip } from "../shared/Tooltip";
import { useConductorStore } from "../../stores/conductorStore";

const ALL_TOOLS = ["Edit", "Write", "Bash", "Glob", "Grep", "Read"];

export function RolesSection() {
  const [roles, setRoles] = useState<RoleEntry[]>([]);
  const [editing, setEditing] = useState<AgentRole | null>(null);
  const [editIsDefault, setEditIsDefault] = useState(false);
  const [isNew, setIsNew] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<{ name: string; isDefault: boolean } | null>(null);
  const [defaultRoleName, setDefaultRoleName] = useState("");

  const loadRoles = useCallback(() => {
    invoke<RoleEntry[]>("roles_list").then(setRoles).catch(console.error);
  }, []);

  const loadDefaultName = useCallback(() => {
    invoke<string>("roles_get_default").then(setDefaultRoleName).catch(console.error);
  }, []);

  useEffect(() => {
    loadRoles();
    loadDefaultName();
  }, [loadRoles, loadDefaultName]);

  const handleNew = useCallback(() => {
    setEditing({
      name: "",
      system_prompt: "",
      allowed_tools: ["Read"],
      can_manage: false,
    });
    setEditIsDefault(false);
    setIsNew(true);
  }, []);

  const handleEdit = useCallback((role: RoleEntry) => {
    setEditing({ ...role });
    setEditIsDefault(role.is_default);
    setIsNew(false);
  }, []);

  const handleSave = useCallback(async (role: AgentRole) => {
    try {
      await invoke("roles_save", { role });
      setEditing(null);
      loadRoles();
    } catch (e) {
      console.error("[RolesSection] save:", e);
    }
  }, [loadRoles]);

  const handleDeleteConfirmed = useCallback(async (name: string) => {
    try {
      await invoke("roles_delete", { name });
      setEditing(null);
      setConfirmDelete(null);
      loadRoles();
    } catch (e) {
      console.error("[RolesSection] delete:", e);
    }
  }, [loadRoles]);

  const handleSetDefault = useCallback(async (name: string) => {
    const newDefault = name === defaultRoleName ? "" : name;
    try {
      await invoke("roles_set_default", { name: newDefault });
      setDefaultRoleName(newDefault);
      useConductorStore.getState().loadDefaultRole().catch(console.error);
    } catch (e) {
      console.error("[RolesSection] set default:", e);
    }
  }, [defaultRoleName]);

  return (
    <div className="roles-section">
      <div className="roles-header">
        <p className="settings-toggle-desc">
          Manage agent roles for team collaboration.
        </p>
        <Tooltip text="New role">
          <button className="roles-add-btn" onClick={handleNew}>
            <Plus size={14} />
            <span>New Role</span>
          </button>
        </Tooltip>
      </div>

      <div className="roles-list">
        {roles.map((role) => (
          <div
            key={role.name}
            className="roles-card roles-card--clickable"
            onClick={() => handleEdit(role)}
          >
            <div className="roles-card__header">
              <span className="roles-card__name">{role.name}</span>
              <Tooltip text={role.name === defaultRoleName ? "Remove default" : "Set as default"}>
                <button
                  className={`roles-card__default-btn ${role.name === defaultRoleName ? "roles-card__default-btn--active" : ""}`}
                  onClick={(e) => { e.stopPropagation(); handleSetDefault(role.name); }}
                >
                  <Star size={12} fill={role.name === defaultRoleName ? "currentColor" : "none"} />
                </button>
              </Tooltip>
            </div>
            <div className="roles-card__prompt">
              {role.system_prompt.slice(0, 80)}
              {role.system_prompt.length > 80 ? "..." : ""}
            </div>
            <div className="roles-card__tools">
              {role.allowed_tools.map((tool) => (
                <span key={tool} className="roles-tool-badge">{tool}</span>
              ))}
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <RoleEditor
          key={editing.name}
          role={editing}
          isNew={isNew}
          isDefault={editIsDefault}
          onSave={handleSave}
          onRequestDelete={(name, isDefault) => {
            setConfirmDelete({ name, isDefault });
          }}
          onCancel={() => setEditing(null)}
        />
      )}

      {confirmDelete && (
        <div className="roles-editor-overlay" onClick={() => setConfirmDelete(null)}>
          <div className="roles-confirm" onClick={(e) => e.stopPropagation()}>
            <p className="roles-confirm__text">
              {confirmDelete.isDefault
                ? `Reset '${confirmDelete.name}' to default settings?`
                : `Delete role '${confirmDelete.name}'? This cannot be undone.`}
            </p>
            <div className="roles-confirm__actions">
              <button className="team-btn" onClick={() => setConfirmDelete(null)}>
                Cancel
              </button>
              <button
                className="team-btn team-btn--danger"
                onClick={() => handleDeleteConfirmed(confirmDelete.name).catch(console.error)}
              >
                {confirmDelete.isDefault ? "Reset" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RoleEditor({
  role,
  isNew,
  isDefault,
  onSave,
  onRequestDelete,
  onCancel,
}: {
  role: AgentRole;
  isNew: boolean;
  isDefault: boolean;
  onSave: (role: AgentRole) => void;
  onRequestDelete: (name: string, isDefault: boolean) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(role.name);
  const [prompt, setPrompt] = useState(role.system_prompt);
  const [tools, setTools] = useState<string[]>(role.allowed_tools);
  const toggleTool = useCallback((tool: string) => {
    if (tool === "Read") return;
    setTools((prev) =>
      prev.includes(tool) ? prev.filter((t) => t !== tool) : [...prev, tool],
    );
  }, []);

  const handleSave = useCallback(() => {
    if (!name.trim()) return;
    const finalTools = tools.includes("Read") ? tools : ["Read", ...tools];
    onSave({
      name: name.trim(),
      system_prompt: prompt,
      allowed_tools: finalTools,
      can_manage: role.can_manage,
    });
  }, [name, prompt, tools, role.can_manage, onSave]);

  return (
    <div className="roles-editor-overlay" onClick={onCancel}>
      <div className="roles-editor" onClick={(e) => e.stopPropagation()}>
        <div className="roles-editor__header">
          <h3 className="roles-editor__title">{isNew ? "New Role" : `Edit: ${role.name}`}</h3>
          <Tooltip text="Cancel">
            <button className="settings-close" onClick={onCancel}>
              <X size={16} />
            </button>
          </Tooltip>
        </div>

        <div className="roles-editor__body">
          <div className="roles-field">
            <label className="roles-field__label">Name</label>
            <input
              className="settings-input roles-input--full"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Role name"
              disabled={!isNew}
              autoFocus={isNew}
            />
          </div>

          <div className="roles-field">
            <label className="roles-field__label">System Prompt</label>
            <textarea
              className="roles-textarea"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Instructions for this role..."
              rows={5}
            />
          </div>

          <div className="roles-field">
            <label className="roles-field__label">Allowed Tools</label>
            <div className="roles-tools-grid">
              {ALL_TOOLS.map((tool) => (
                <label key={tool} className="roles-tool-check">
                  <input
                    type="checkbox"
                    checked={tools.includes(tool)}
                    onChange={() => toggleTool(tool)}
                    disabled={tool === "Read"}
                  />
                  <span>{tool}</span>
                </label>
              ))}
            </div>
          </div>

        </div>

        <div className="roles-editor__actions">
          <button className="team-btn team-btn--primary" onClick={handleSave}>
            Save
          </button>
          <button className="team-btn" onClick={onCancel}>
            Cancel
          </button>
          {!isNew && (
            <button
              className="team-btn team-btn--danger"
              onClick={() => onRequestDelete(role.name, isDefault)}
            >
              {isDefault ? (
                <><RotateCcw size={13} /> Reset to default</>
              ) : (
                <><Trash2 size={13} /> Delete</>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
