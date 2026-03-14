import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2, Shield, X } from "lucide-react";
import { invoke } from "../../lib/transport";
import type { AgentRole, RoleEntry } from "../../types/team";

const ALL_TOOLS = ["Edit", "Write", "Bash", "Glob", "Grep", "Read"];

export function RolesSection() {
  const [roles, setRoles] = useState<RoleEntry[]>([]);
  const [editing, setEditing] = useState<AgentRole | null>(null);
  const [isNew, setIsNew] = useState(false);

  const loadRoles = useCallback(() => {
    invoke<RoleEntry[]>("roles_list").then(setRoles).catch(console.error);
  }, []);

  useEffect(() => {
    loadRoles();
  }, [loadRoles]);

  const handleNew = useCallback(() => {
    setEditing({
      name: "",
      system_prompt: "",
      allowed_tools: ["Read"],
      can_manage: false,
    });
    setIsNew(true);
  }, []);

  const handleEdit = useCallback((role: RoleEntry) => {
    if (role.is_builtin) return;
    setEditing({ ...role });
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

  const handleDelete = useCallback(async (name: string) => {
    try {
      await invoke("roles_delete", { name });
      setEditing(null);
      loadRoles();
    } catch (e) {
      console.error("[RolesSection] delete:", e);
    }
  }, [loadRoles]);

  return (
    <div className="roles-section">
      <div className="roles-header">
        <p className="settings-toggle-desc">
          Manage agent roles for team collaboration. Built-in roles cannot be edited.
        </p>
        <button className="roles-add-btn" onClick={handleNew} title="New role">
          <Plus size={14} />
          <span>New Role</span>
        </button>
      </div>

      <div className="roles-list">
        {roles.map((role) => (
          <div
            key={role.name}
            className={`roles-card ${!role.is_builtin ? "roles-card--clickable" : ""}`}
            onClick={() => handleEdit(role)}
          >
            <div className="roles-card__header">
              <span className="roles-card__name">{role.name}</span>
              {role.is_builtin && (
                <span className="roles-badge roles-badge--builtin">Built-in</span>
              )}
              {role.can_manage && (
                <span className="roles-badge roles-badge--manager">
                  <Shield size={10} />
                  Manager
                </span>
              )}
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
          onSave={handleSave}
          onDelete={handleDelete}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function RoleEditor({
  role,
  isNew,
  onSave,
  onDelete,
  onCancel,
}: {
  role: AgentRole;
  isNew: boolean;
  onSave: (role: AgentRole) => void;
  onDelete: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(role.name);
  const [prompt, setPrompt] = useState(role.system_prompt);
  const [tools, setTools] = useState<string[]>(role.allowed_tools);
  const [canManage, setCanManage] = useState(role.can_manage);

  const toggleTool = useCallback((tool: string) => {
    // Read is always included
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
      can_manage: canManage,
    });
  }, [name, prompt, tools, canManage, onSave]);

  return (
    <div className="roles-editor-overlay" onClick={onCancel}>
      <div className="roles-editor" onClick={(e) => e.stopPropagation()}>
        <div className="roles-editor__header">
          <h3 className="roles-editor__title">{isNew ? "New Role" : `Edit: ${role.name}`}</h3>
          <button className="settings-close" onClick={onCancel} title="Cancel">
            <X size={16} />
          </button>
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

          <label className="roles-tool-check roles-manage-check">
            <input
              type="checkbox"
              checked={canManage}
              onChange={(e) => setCanManage(e.target.checked)}
            />
            <span>Can manage team agents (start/stop/restart)</span>
          </label>
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
              onClick={() => onDelete(role.name)}
            >
              <Trash2 size={13} />
              Delete
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
