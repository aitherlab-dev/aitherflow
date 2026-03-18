import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  ArrowRightLeft,
  ChevronRight,
  Download,
  ExternalLink,
  Globe,
  Package,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { usePluginStore } from "../../stores/pluginStore";
import { useSkillStore } from "../../stores/skillStore";
import { useProjectStore } from "../../stores/projectStore";
import { useTranslationStore } from "../../stores/translationStore";
import { Modal } from "../Modal";
import { Tooltip } from "../shared/Tooltip";
import type { AvailablePlugin, MarketplaceSource } from "../../types/plugins";
import type { SkillEntry } from "../../types/skills";

// ── Collapsible group with chevron ──

const CollapsibleGroup = memo(function CollapsibleGroup({
  label,
  count,
  icon,
  defaultOpen = false,
  children,
}: {
  label: string;
  count: number;
  icon?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="skills-section-block">
      <h4
        className="skills-section-subtitle skills-section-subtitle--clickable"
        onClick={() => setOpen((p) => !p)}
      >
        <ChevronRight
          size={14}
          className={`skills-section-chevron ${open ? "skills-section-chevron--open" : ""}`}
        />
        {icon}
        {label} ({count})
      </h4>
      {open && children}
    </div>
  );
});

// ── Sub-tab selector ──

type SubTab = "installed" | "available" | "sources";

const SUB_TABS: { id: SubTab; label: string }[] = [
  { id: "installed", label: "Installed" },
  { id: "available", label: "Available" },
  { id: "sources", label: "Sources" },
];

// ── Installed: user skill card ──

const UserSkillCard = memo(function UserSkillCard({
  skill,
  onDelete,
  onMove,
}: {
  skill: SkillEntry;
  onDelete: (skill: SkillEntry) => void;
  onMove: (skill: SkillEntry) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isGlobal = skill.source.type === "global";

  return (
    <div className="plugin-card">
      <div className="plugin-card-header" onClick={() => setExpanded((p) => !p)}>
        <ChevronRight
          size={14}
          className={`plugin-card-chevron ${expanded ? "plugin-card-chevron--open" : ""}`}
        />
        <span className="plugin-card-name">{skill.name}</span>
        <span className="plugin-badge plugin-badge--scope">
          {isGlobal ? "global" : "project"}
        </span>
        <span className="plugin-skill-row__command">{skill.command}</span>
      </div>
      {expanded && (
        <div className="plugin-card-body">
          {skill.description && (
            <p className="plugin-card-desc">{skill.description}</p>
          )}
          <div className="plugin-card-meta">
            <span>{skill.filePath}</span>
          </div>
          <div className="skill-card-actions">
            <button
              className="skill-card-btn skill-card-btn--move"
              onClick={() => onMove(skill)}
            >
              <ArrowRightLeft size={14} />
              <span>{isGlobal ? "Move to Project" : "Move to Global"}</span>
            </button>
            <button
              className="skill-card-btn skill-card-btn--delete"
              onClick={() => onDelete(skill)}
            >
              <Trash2 size={14} />
              <span>Delete</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
});

// ── Installed tab ──

function InstalledTab() {
  const installed = usePluginStore(useShallow((s) => s.installed));
  const uninstalling = usePluginStore(useShallow((s) => s.uninstalling));
  const uninstall = usePluginStore((s) => s.uninstall);

  const globalSkills = useSkillStore(useShallow((s) => s.global));
  const projectGroups = useSkillStore(useShallow((s) => s.projects));
  const pluginGroups = useSkillStore(useShallow((s) => s.plugins));
  const deleteSkill = useSkillStore((s) => s.deleteSkill);
  const moveSkill = useSkillStore((s) => s.moveSkill);

  const projects = useProjectStore(useShallow((s) => s.projects));

  // Total project skill count
  const totalProjectSkills = useMemo(
    () => projectGroups.reduce((sum, pg) => sum + pg.skills.length, 0),
    [projectGroups],
  );

  // Delete modal
  const [deleteTarget, setDeleteTarget] = useState<SkillEntry | null>(null);
  // Move modal
  const [moveTarget, setMoveTarget] = useState<SkillEntry | null>(null);
  const [moveProjectPath, setMoveProjectPath] = useState("");
  const [moveNewName, setMoveNewName] = useState("");
  const [moveError, setMoveError] = useState("");
  const [moveConflict, setMoveConflict] = useState(false);

  const handleUninstall = useCallback(
    (name: string, marketplace: string) => {
      uninstall(name, marketplace).catch(console.error);
    },
    [uninstall],
  );

  const handleConfirmDelete = useCallback(() => {
    if (!deleteTarget) return;
    deleteSkill(deleteTarget).catch(console.error);
    setDeleteTarget(null);
  }, [deleteTarget, deleteSkill]);

  const handleMoveOpen = useCallback(
    (skill: SkillEntry) => {
      setMoveTarget(skill);
      setMoveProjectPath(projects[0]?.path ?? "");
      setMoveNewName("");
      setMoveError("");
      setMoveConflict(false);
    },
    [projects],
  );

  const handleConfirmMove = useCallback(async () => {
    if (!moveTarget) return;

    const isGlobal = moveTarget.source.type === "global";
    const targetType = isGlobal ? "project" : "global";
    const projectPath = isGlobal ? moveProjectPath : null;

    try {
      await moveSkill(
        moveTarget,
        targetType as "global" | "project",
        projectPath,
        moveNewName || undefined,
      );
      setMoveTarget(null);
    } catch (e) {
      console.error("Failed to move skill:", e);
      const msg = String(e);
      if (msg.includes("already exists")) {
        setMoveConflict(true);
        setMoveNewName(moveTarget.id.replace(/^project:[^:]+:/, ""));
        setMoveError("Skill with this name already exists. Choose a new name.");
      } else {
        setMoveError("Failed to move skill. Check console for details.");
      }
    }
  }, [moveTarget, moveProjectPath, moveNewName, moveSkill]);

  return (
    <div className="skills-section-tab">
      {/* Global Skills */}
      {globalSkills.length > 0 && (
        <CollapsibleGroup label="Global Skills" count={globalSkills.length} defaultOpen>
          <div className="skills-section-list">
            {globalSkills.map((s) => (
              <UserSkillCard
                key={s.id}
                skill={s}
                onDelete={setDeleteTarget}
                onMove={handleMoveOpen}
              />
            ))}
          </div>
        </CollapsibleGroup>
      )}

      {/* Project Skills */}
      {projectGroups.length > 0 && (
        <CollapsibleGroup label="Project Skills" count={totalProjectSkills}>
          {projectGroups.map((pg) => (
            <CollapsibleGroup
              key={pg.projectPath}
              label={pg.projectName}
              count={pg.skills.length}
            >
              <div className="skills-section-list">
                {pg.skills.map((s) => (
                  <UserSkillCard
                    key={s.id}
                    skill={s}
                    onDelete={setDeleteTarget}
                    onMove={handleMoveOpen}
                  />
                ))}
              </div>
            </CollapsibleGroup>
          ))}
        </CollapsibleGroup>
      )}

      {/* Plugins */}
      <CollapsibleGroup
        label="Plugins"
        count={installed.length}
        icon={<Package size={14} />}
        defaultOpen
      >
        {installed.length === 0 ? (
          <div className="skills-section-empty">No plugins installed</div>
        ) : (
          installed.map((p) => {
            const pg = pluginGroups.find((g) => g.pluginName === p.name);
            return (
              <CollapsibleGroup
                key={p.id}
                label={p.name}
                count={pg?.skills.length ?? 0}
              >
                {p.description && (
                  <p className="plugin-card-desc" style={{ padding: "0 12px 4px" }}>
                    {p.description}
                  </p>
                )}
                {pg && pg.skills.length > 0 && (
                  <div className="skills-section-list">
                    {pg.skills.map((s) => (
                      <div key={s.id} className="plugin-skill-row-simple">
                        <span className="plugin-card-name">{s.name}</span>
                        <span className="plugin-skill-row__command">{s.command}</span>
                      </div>
                    ))}
                  </div>
                )}
                <button
                  className="plugin-card-uninstall"
                  style={{ margin: "4px 12px 8px" }}
                  onClick={() => handleUninstall(p.name, p.marketplace)}
                  disabled={uninstalling.has(p.id)}
                >
                  <Trash2 size={14} />
                  <span>{uninstalling.has(p.id) ? "Removing..." : "Uninstall"}</span>
                </button>
              </CollapsibleGroup>
            );
          })
        )}
      </CollapsibleGroup>

      {/* Delete confirmation modal */}
      <Modal
        open={deleteTarget !== null}
        title="Delete Skill"
        onClose={() => setDeleteTarget(null)}
        actions={[
          { label: "Cancel", onClick: () => setDeleteTarget(null) },
          { label: "Delete", variant: "danger", onClick: handleConfirmDelete },
        ]}
      >
        <p className="modal-text">
          Delete skill <strong>{deleteTarget?.name}</strong>? This will remove the skill folder from disk.
        </p>
      </Modal>

      {/* Move modal */}
      <Modal
        open={moveTarget !== null}
        title={moveTarget?.source.type === "global" ? "Move to Project" : "Move to Global"}
        onClose={() => setMoveTarget(null)}
        actions={[
          { label: "Cancel", onClick: () => setMoveTarget(null) },
          {
            label: "Move",
            variant: "accent",
            onClick: () => { handleConfirmMove().catch(console.error); },
          },
        ]}
      >
        <p className="modal-text">
          Move <strong>{moveTarget?.name}</strong>{" "}
          {moveTarget?.source.type === "global" ? "to project:" : "to global skills."}
        </p>
        {moveTarget?.source.type === "global" && (
          <select
            className="modal-select"
            value={moveProjectPath}
            onChange={(e) => setMoveProjectPath(e.target.value)}
          >
            {projects.map((p) => (
              <option key={p.path} value={p.path}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        {moveConflict && (
          <input
            className="modal-input"
            placeholder="New skill name"
            value={moveNewName}
            onChange={(e) => setMoveNewName(e.target.value)}
            spellCheck={false}
            style={{ marginTop: 10 }}
          />
        )}
        {moveError && <p className="modal-error">{moveError}</p>}
      </Modal>
    </div>
  );
}

// ── Available: plugin row ──

const AvailableRow = memo(function AvailableRow({
  plugin,
  onInstall,
  isInstalling,
}: {
  plugin: AvailablePlugin;
  onInstall: (name: string, marketplace: string) => void;
  isInstalling: boolean;
}) {
  const translatedDesc = useTranslationStore(
    (s) => s.cache.entries[`available-plugin:${plugin.name}@${plugin.marketplace}`],
  );

  return (
    <div className="available-row">
      <div className="available-row-info">
        <div className="available-row-top">
          <span className="available-row-name">{plugin.name}</span>
          <ExternalLink size={12} className="available-row-link" />
          {plugin.author && (
            <span className="available-row-author">by {plugin.author}</span>
          )}
          {plugin.isInstalled && (
            <span className="plugin-badge plugin-badge--installed">installed</span>
          )}
        </div>
        {plugin.description && (
          <p className="available-row-desc">{translatedDesc || plugin.description}</p>
        )}
      </div>
      {!plugin.isInstalled && (
        <button
          className="available-row-install"
          onClick={() => onInstall(plugin.name, plugin.marketplace)}
          disabled={isInstalling}
        >
          <Download size={14} />
          <span>{isInstalling ? "..." : "Install"}</span>
        </button>
      )}
    </div>
  );
});

// ── Available tab ──

function AvailableTab() {
  const available = usePluginStore((s) => s.available);
  const sources = usePluginStore((s) => s.sources);
  const installing = usePluginStore((s) => s.installing);
  const install = usePluginStore((s) => s.install);

  const [query, setQuery] = useState("");

  const handleInstall = useCallback(
    (name: string, marketplace: string) => {
      install(name, marketplace).catch(console.error);
    },
    [install],
  );

  // Group by marketplace, filter by query
  const grouped = useMemo(() => {
    const q = query.toLowerCase();
    const filtered = q
      ? available.filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            p.description.toLowerCase().includes(q),
        )
      : available;

    const groups: Record<string, AvailablePlugin[]> = {};
    for (const p of filtered) {
      const key = p.marketplace;
      if (!groups[key]) groups[key] = [];
      groups[key].push(p);
    }

    // Sort marketplace names, official first
    return Object.entries(groups).sort(([a], [b]) => {
      if (a.includes("official")) return -1;
      if (b.includes("official")) return 1;
      return a.localeCompare(b);
    });
  }, [available, query]);

  return (
    <div className="skills-section-tab">
      <div className="skills-section-search">
        <Search size={14} className="skills-section-search__icon" />
        <input
          className="skills-section-search__input"
          placeholder="Search plugins..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
      </div>

      {grouped.length === 0 ? (
        <div className="skills-section-empty">
          {query
            ? "No plugins match your search"
            : sources.length === 0
              ? "No marketplace sources configured"
              : "No plugins available"}
        </div>
      ) : (
        grouped.map(([marketplace, plugins]) => (
          <CollapsibleGroup
            key={marketplace}
            label={marketplace}
            count={plugins.length}
            icon={<Globe size={14} />}
          >
            <div className="skills-section-list">
              {plugins.map((p) => {
                const key = `${p.name}@${p.marketplace}`;
                return (
                  <AvailableRow
                    key={key}
                    plugin={p}
                    onInstall={handleInstall}
                    isInstalling={installing.has(key)}
                  />
                );
              })}
            </div>
          </CollapsibleGroup>
        ))
      )}
    </div>
  );
}

// ── Source row ──

const SourceRow = memo(function SourceRow({
  source,
  onRemove,
}: {
  source: MarketplaceSource;
  onRemove: (name: string) => void;
}) {
  return (
    <div className="source-row">
      <div className="source-row-info">
        <span className="source-row-name">{source.name}</span>
        <span className="plugin-badge plugin-badge--scope">{source.sourceType}</span>
        <span className="source-row-url">{source.url}</span>
      </div>
      <Tooltip text="Remove source">
        <button
          className="source-row-remove"
          onClick={() => onRemove(source.name)}
        >
          <X size={14} />
        </button>
      </Tooltip>
    </div>
  );
});

// ── Sources tab ──

function SourcesTab() {
  const sources = usePluginStore((s) => s.sources);
  const updatingSources = usePluginStore((s) => s.updatingSources);
  const addSource = usePluginStore((s) => s.addSource);
  const removeSource = usePluginStore((s) => s.removeSource);
  const updateSources = usePluginStore((s) => s.updateSources);

  const [adding, setAdding] = useState(false);
  const [newUrl, setNewUrl] = useState("");
  const [addError, setAddError] = useState("");

  const handleRemove = useCallback(
    (name: string) => {
      removeSource(name).catch(console.error);
    },
    [removeSource],
  );

  const handleUpdate = useCallback(() => {
    updateSources().catch(console.error);
  }, [updateSources]);

  const handleAdd = useCallback(async () => {
    const trimUrl = newUrl.trim();
    if (!trimUrl) {
      setAddError("Paste a GitHub repo URL");
      return;
    }
    setAddError("");
    try {
      await addSource(trimUrl);
      setAdding(false);
      setNewUrl("");
    } catch (e) {
      console.error("Failed to add skill source:", e);
      setAddError("Failed to add source. Check console for details.");
    }
  }, [newUrl, addSource]);

  const handleAddKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.code === "Enter") handleAdd().catch(console.error);
      if (e.code === "Escape") setAdding(false);
    },
    [handleAdd],
  );

  return (
    <div className="skills-section-tab">
      <p className="skills-section-hint">
        Plugin sources — GitHub repos or git URLs containing plugins
      </p>

      <div className="skills-section-list">
        {sources.map((s) => (
          <SourceRow key={s.name} source={s} onRemove={handleRemove} />
        ))}
      </div>

      {/* Add form */}
      {adding ? (
        <div className="source-add-form">
          <div className="source-add-form__row">
            <input
              className="source-add-form__input source-add-form__input--wide"
              placeholder="https://github.com/owner/repo"
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              onKeyDown={handleAddKey}
              spellCheck={false}
              autoFocus
            />
          </div>
          {addError && <p className="source-add-form__error">{addError}</p>}
          <div className="source-add-form__actions">
            <button className="source-add-form__btn" onClick={() => handleAdd().catch(console.error)}>
              <Plus size={14} />
              <span>Add</span>
            </button>
            <button
              className="source-add-form__btn source-add-form__btn--cancel"
              onClick={() => setAdding(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button className="source-add-btn" onClick={() => setAdding(true)}>
          <Plus size={14} />
          <span>Add Marketplace</span>
        </button>
      )}

      {/* Update all */}
      <button
        className="source-update-btn"
        onClick={handleUpdate}
        disabled={updatingSources}
      >
        <RefreshCw size={14} className={updatingSources ? "spinning" : ""} />
        <span>{updatingSources ? "Updating..." : "Update All Marketplaces"}</span>
      </button>
    </div>
  );
}

// ── Main section ──

export function SkillsSection() {
  const [tab, setTab] = useState<SubTab>("installed");

  // Load data on mount
  useEffect(() => {
    const pluginState = usePluginStore.getState();
    if (!pluginState.loaded) {
      pluginState.load().catch(console.error);
    }
    const skillState = useSkillStore.getState();
    if (!skillState.loaded) {
      const projects = useProjectStore.getState().projects;
      skillState.load(projects.map((p) => ({ path: p.path, name: p.name }))).catch(console.error);
    }
  }, []);

  return (
    <div className="skills-section">
      {/* Sub-tabs */}
      <div className="skills-section-tabs">
        {SUB_TABS.map((t) => (
          <button
            key={t.id}
            className={`skills-section-tabs__btn ${tab === t.id ? "skills-section-tabs__btn--active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      {tab === "installed" && <InstalledTab />}
      {tab === "available" && <AvailableTab />}
      {tab === "sources" && <SourcesTab />}
    </div>
  );
}
