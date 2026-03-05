import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
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
import { useAgentStore } from "../../stores/agentStore";
import { useTranslationStore } from "../../stores/translationStore";
import type { InstalledPlugin, AvailablePlugin, MarketplaceSource } from "../../types/plugins";
import type { SkillEntry } from "../../types/skills";

// ── Sub-tab selector ──

type SubTab = "installed" | "available" | "sources";

const SUB_TABS: { id: SubTab; label: string }[] = [
  { id: "installed", label: "Installed" },
  { id: "available", label: "Available" },
  { id: "sources", label: "Sources" },
];

// ── Installed: plugin card ──

const PluginCard = memo(function PluginCard({
  plugin,
  onUninstall,
  isUninstalling,
}: {
  plugin: InstalledPlugin;
  onUninstall: (name: string, marketplace: string) => void;
  isUninstalling: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const translatedDesc = useTranslationStore(
    (s) => s.cache.entries[`installed-plugin:${plugin.id}`],
  );

  return (
    <div className="plugin-card">
      <div className="plugin-card-header" onClick={() => setExpanded((p) => !p)}>
        <ChevronRight
          size={14}
          className={`plugin-card-chevron ${expanded ? "plugin-card-chevron--open" : ""}`}
        />
        <span className="plugin-card-name">{plugin.name}</span>
        {plugin.version && (
          <span className="plugin-badge plugin-badge--version">{plugin.version}</span>
        )}
        <span className="plugin-badge plugin-badge--enabled">enabled</span>
        <span className="plugin-badge plugin-badge--scope">{plugin.scope}</span>
        {plugin.skillCount > 0 && (
          <span className="plugin-badge plugin-badge--skills">
            {plugin.skillCount} skill{plugin.skillCount !== 1 ? "s" : ""}
          </span>
        )}
      </div>
      {expanded && (
        <div className="plugin-card-body">
          {plugin.description && (
            <p className="plugin-card-desc">{translatedDesc || plugin.description}</p>
          )}
          <div className="plugin-card-meta">
            <span>Source: {plugin.marketplace}</span>
          </div>
          <button
            className="plugin-card-uninstall"
            onClick={() => onUninstall(plugin.name, plugin.marketplace)}
            disabled={isUninstalling}
          >
            <Trash2 size={14} />
            <span>{isUninstalling ? "Removing..." : "Uninstall"}</span>
          </button>
        </div>
      )}
    </div>
  );
});

// ── Installed: user skill row ──

const UserSkillRow = memo(function UserSkillRow({
  skill,
}: {
  skill: SkillEntry;
}) {
  return (
    <div className="plugin-skill-row">
      <span className="plugin-skill-row__name">{skill.name}</span>
      <span className="plugin-skill-row__command">{skill.command}</span>
    </div>
  );
});

// ── Installed tab ──

function InstalledTab() {
  const installed = usePluginStore((s) => s.installed);
  const uninstalling = usePluginStore((s) => s.uninstalling);
  const uninstall = usePluginStore((s) => s.uninstall);

  const globalSkills = useSkillStore((s) => s.global);
  const projectSkills = useSkillStore((s) => s.project);

  const handleUninstall = useCallback(
    (name: string, marketplace: string) => {
      uninstall(name, marketplace).catch(console.error);
    },
    [uninstall],
  );

  return (
    <div className="skills-section-tab">
      {/* User skills */}
      {(globalSkills.length > 0 || projectSkills.length > 0) && (
        <div className="skills-section-block">
          {globalSkills.length > 0 && (
            <>
              <h4 className="skills-section-subtitle">Global Skills</h4>
              <div className="skills-section-list">
                {globalSkills.map((s) => (
                  <UserSkillRow key={s.id} skill={s} />
                ))}
              </div>
            </>
          )}
          {projectSkills.length > 0 && (
            <>
              <h4 className="skills-section-subtitle">Project Skills</h4>
              <div className="skills-section-list">
                {projectSkills.map((s) => (
                  <UserSkillRow key={s.id} skill={s} />
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* Plugins */}
      <div className="skills-section-block">
        <h4 className="skills-section-subtitle">
          <Package size={14} />
          Plugins ({installed.length})
        </h4>
        {installed.length === 0 ? (
          <div className="skills-section-empty">No plugins installed</div>
        ) : (
          <div className="skills-section-list">
            {installed.map((p) => (
              <PluginCard
                key={p.id}
                plugin={p}
                onUninstall={handleUninstall}
                isUninstalling={uninstalling.has(p.id)}
              />
            ))}
          </div>
        )}
      </div>
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
          <div key={marketplace} className="skills-section-block">
            <h4 className="skills-section-subtitle">
              <Globe size={14} />
              {marketplace} ({plugins.length})
            </h4>
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
          </div>
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
      <button
        className="source-row-remove"
        onClick={() => onRemove(source.name)}
        title="Remove source"
      >
        <X size={14} />
      </button>
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
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [newType, setNewType] = useState<"github" | "git">("github");
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
    const trimName = newName.trim();
    const trimUrl = newUrl.trim();
    if (!trimName || !trimUrl) {
      setAddError("Name and URL are required");
      return;
    }
    setAddError("");
    try {
      await addSource(trimName, newType, trimUrl);
      setAdding(false);
      setNewName("");
      setNewUrl("");
    } catch (e) {
      setAddError(String(e));
    }
  }, [newName, newUrl, newType, addSource]);

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
            <select
              className="source-add-form__select"
              value={newType}
              onChange={(e) => setNewType(e.target.value as "github" | "git")}
            >
              <option value="github">GitHub</option>
              <option value="git">Git URL</option>
            </select>
            <input
              className="source-add-form__input"
              placeholder="Name (e.g. my-skills)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={handleAddKey}
              spellCheck={false}
              autoFocus
            />
          </div>
          <div className="source-add-form__row">
            <input
              className="source-add-form__input source-add-form__input--wide"
              placeholder={
                newType === "github"
                  ? "owner/repo (e.g. anthropics/claude-plugins-official)"
                  : "https://github.com/user/repo.git"
              }
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              onKeyDown={handleAddKey}
              spellCheck={false}
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

  const loadPlugins = usePluginStore((s) => s.load);
  const pluginsLoaded = usePluginStore((s) => s.loaded);

  const loadSkills = useSkillStore((s) => s.load);
  const skillsLoaded = useSkillStore((s) => s.loaded);
  const getActiveAgent = useAgentStore((s) => s.getActiveAgent);

  // Load data on mount
  useEffect(() => {
    if (!pluginsLoaded) {
      loadPlugins().catch(console.error);
    }
    if (!skillsLoaded) {
      const agent = getActiveAgent();
      if (agent?.projectPath) {
        loadSkills(agent.projectPath).catch(console.error);
      }
    }
  }, [pluginsLoaded, skillsLoaded, loadPlugins, loadSkills, getActiveAgent]);

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
