import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronRight,
  Search,
  Star,
  Settings as SettingsIcon,
} from "lucide-react";
import { useSkillStore } from "../../stores/skillStore";
import { useAgentStore } from "../../stores/agentStore";
import { useLayoutStore } from "../../stores/layoutStore";
import { useChatStore } from "../../stores/chatStore";
import { useTranslationStore } from "../../stores/translationStore";
import type { SkillEntry, PluginSkillGroup } from "../../types/skills";

// ── Single skill row ──

const SkillRow = memo(function SkillRow({
  skill,
  isFavorite,
  onToggleFav,
  onInvoke,
}: {
  skill: SkillEntry;
  isFavorite: boolean;
  onToggleFav: (id: string) => void;
  onInvoke: (command: string) => void;
}) {
  const translated = useTranslationStore(
    (s) => s.cache.entries[`skill:${skill.id}`],
  );
  const desc = translated || skill.description || skill.name;

  return (
    <div
      className="skills-row"
      onClick={() => onInvoke(skill.command)}
      title={desc}
    >
      <span className="skills-row__name">{skill.name}</span>
      <span className="skills-row__command">{skill.command}</span>
      <button
        className={`skills-row__star ${isFavorite ? "skills-row__star--active" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          onToggleFav(skill.id);
        }}
        title={isFavorite ? "Remove from favorites" : "Add to favorites"}
      >
        <Star size={14} />
      </button>
    </div>
  );
});

// ── Collapsible group ──

const SkillGroup = memo(function SkillGroup({
  label,
  count,
  defaultOpen,
  children,
}: {
  label: string;
  count: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);

  return (
    <div className="skills-group">
      <button
        className="skills-group__header"
        onClick={() => setOpen((p) => !p)}
      >
        <ChevronRight
          size={14}
          className={`skills-group__chevron ${open ? "skills-group__chevron--open" : ""}`}
        />
        <span className="skills-group__label">{label}</span>
        <span className="skills-group__count">{count}</span>
      </button>
      {open && <div className="skills-group__body">{children}</div>}
    </div>
  );
});

// ── Main panel ──

export const SkillsPanel = memo(function SkillsPanel() {
  const getActiveAgent = useAgentStore((s) => s.getActiveAgent);
  const activeAgentId = useAgentStore((s) => s.activeAgentId);
  const agent = getActiveAgent();
  const projectPath = agent?.projectPath ?? "";

  const load = useSkillStore((s) => s.load);
  const loaded = useSkillStore((s) => s.loaded);
  const global = useSkillStore((s) => s.global);
  const project = useSkillStore((s) => s.project);
  const plugins = useSkillStore((s) => s.plugins);
  const favoriteIds = useSkillStore((s) => s.favoriteIds);
  const toggleFavorite = useSkillStore((s) => s.toggleFavorite);
  const getFavorites = useSkillStore((s) => s.getFavorites);

  const openSettings = useLayoutStore((s) => s.openSettings);
  const closeSettings = useLayoutStore((s) => s.closeSettings);
  const activeView = useLayoutStore((s) => s.activeView);

  const [query, setQuery] = useState("");

  // Load skills when project changes
  useEffect(() => {
    if (projectPath) {
      load(projectPath).catch(console.error);
    }
  }, [projectPath, activeAgentId, load]);

  const handleToggleFav = useCallback(
    (id: string) => {
      toggleFavorite(id).catch(console.error);
    },
    [toggleFavorite],
  );

  const handleInvokeSkill = useCallback(
    (command: string) => {
      if (activeView === "settings") closeSettings();
      useChatStore.getState().sendMessage(command).catch(console.error);
    },
    [activeView, closeSettings],
  );

  const handleManageClick = useCallback(() => {
    openSettings("skills");
  }, [openSettings]);

  // Filter by search query
  const filterSkills = useCallback(
    (skills: SkillEntry[]) => {
      if (!query) return skills;
      const q = query.toLowerCase();
      return skills.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.command.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q),
      );
    },
    [query],
  );

  const favorites = useMemo(() => {
    const favs = getFavorites();
    return filterSkills(favs);
  }, [getFavorites, filterSkills, favoriteIds, global, project, plugins]);

  const filteredGlobal = useMemo(
    () => filterSkills(global),
    [filterSkills, global],
  );

  const filteredProject = useMemo(
    () => filterSkills(project),
    [filterSkills, project],
  );

  const filteredPlugins = useMemo(
    () =>
      plugins
        .map((pg: PluginSkillGroup) => ({
          ...pg,
          skills: filterSkills(pg.skills),
        }))
        .filter((pg: PluginSkillGroup) => pg.skills.length > 0),
    [filterSkills, plugins],
  );

  if (!loaded) {
    return (
      <div className="skills-panel skills-panel--empty">Loading skills...</div>
    );
  }

  return (
    <div className="skills-panel">
      {/* Search */}
      <div className="skills-search">
        <Search size={14} className="skills-search__icon" />
        <input
          className="skills-search__input"
          placeholder="Search skills..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
      </div>

      {/* Content */}
      <div className="skills-panel-content">
        {/* Favorites */}
        {favorites.length > 0 && (
          <SkillGroup
            label="Favorites"
            count={favorites.length}
            defaultOpen
          >
            {favorites.map((s) => (
              <SkillRow
                key={s.id}
                skill={s}
                isFavorite
                onToggleFav={handleToggleFav}
                onInvoke={handleInvokeSkill}
              />
            ))}
          </SkillGroup>
        )}

        {/* My Skills (global) */}
        {filteredGlobal.length > 0 && (
          <SkillGroup label="My Skills" count={filteredGlobal.length}>
            {filteredGlobal.map((s) => (
              <SkillRow
                key={s.id}
                skill={s}
                isFavorite={favoriteIds.includes(s.id)}
                onToggleFav={handleToggleFav}
                onInvoke={handleInvokeSkill}
              />
            ))}
          </SkillGroup>
        )}

        {/* Project Skills */}
        {filteredProject.length > 0 && (
          <SkillGroup
            label="Project Skills"
            count={filteredProject.length}
          >
            {filteredProject.map((s) => (
              <SkillRow
                key={s.id}
                skill={s}
                isFavorite={favoriteIds.includes(s.id)}
                onToggleFav={handleToggleFav}
                onInvoke={handleInvokeSkill}
              />
            ))}
          </SkillGroup>
        )}

        {/* Plugin skills */}
        {filteredPlugins.map((pg: PluginSkillGroup) => (
          <SkillGroup
            key={pg.pluginName}
            label={pg.pluginName}
            count={pg.skills.length}
          >
            {pg.skills.map((s) => (
              <SkillRow
                key={s.id}
                skill={s}
                isFavorite={favoriteIds.includes(s.id)}
                onToggleFav={handleToggleFav}
                onInvoke={handleInvokeSkill}
              />
            ))}
          </SkillGroup>
        ))}

        {/* Empty state */}
        {filteredGlobal.length === 0 &&
          filteredProject.length === 0 &&
          filteredPlugins.length === 0 &&
          favorites.length === 0 && (
            <div className="skills-panel--empty">
              {query ? "No skills match your search" : "No skills found"}
            </div>
          )}
      </div>

      {/* Bottom: manage button */}
      <button className="skills-manage-btn" onClick={handleManageClick}>
        <SettingsIcon size={14} />
        <span>Manage Skills</span>
      </button>
    </div>
  );
});
