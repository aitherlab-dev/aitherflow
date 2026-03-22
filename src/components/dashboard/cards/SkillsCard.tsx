import { memo, useCallback, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ChevronRight, Settings, Sparkles, Star } from "lucide-react";
import { useSkillStore } from "../../../stores/skillStore";
import { useAgentStore } from "../../../stores/agentStore";
import { sendMessage } from "../../../stores/chatService";
import { useLayoutStore } from "../../../stores/layoutStore";
import { useTranslationStore } from "../../../stores/translationStore";
import { DashboardCard } from "../DashboardCard";
import { Tooltip } from "../../shared/Tooltip";
import type { SkillEntry, PluginSkillGroup } from "../../../types/skills";

// ── Skill row (compact for dashboard) ──

const SkillRowMini = memo(function SkillRowMini({
  skill,
  isFavorite,
  disabled,
  onToggleFav,
  onInvoke,
}: {
  skill: SkillEntry;
  isFavorite: boolean;
  disabled: boolean;
  onToggleFav: (id: string) => void;
  onInvoke: (command: string) => void;
}) {
  const translated = useTranslationStore(
    (s) => s.cache.entries[`skill:${skill.id}`],
  );
  const desc = translated || skill.description || skill.name;

  return (
    <Tooltip text={disabled ? "" : desc}>
      <div
        className={`skills-row ${disabled ? "skills-row--disabled" : ""}`}
        onClick={() => { if (!disabled) onInvoke(skill.command); }}
      >
        <span className="skills-row__name">{skill.name}</span>
        <span className="skills-row__command">{skill.command}</span>
        <Tooltip text={isFavorite ? "Remove from favorites" : "Add to favorites"}>
          <button
            className={`skills-row__star ${isFavorite ? "skills-row__star--active" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggleFav(skill.id);
            }}
          >
            <Star size={14} />
          </button>
        </Tooltip>
      </div>
    </Tooltip>
  );
});

// ── Collapsible section ──

const SkillSection = memo(function SkillSection({
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

  if (count === 0) return null;

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

// ── Main card ──

export const SkillsCard = memo(function SkillsCard({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  const global = useSkillStore(useShallow((s) => s.global));
  const projectGroups = useSkillStore(useShallow((s) => s.projects));
  const plugins = useSkillStore(useShallow((s) => s.plugins));
  const favoriteIds = useSkillStore(useShallow((s) => s.favoriteIds));
  const getFavorites = useSkillStore((s) => s.getFavorites);
  const toggleFavorite = useSkillStore((s) => s.toggleFavorite);

  const activeAgentId = useAgentStore((s) => s.activeAgentId);
  const activeProjectPath = useAgentStore(
    (s) => s.agents.find((a) => a.id === s.activeAgentId)?.projectPath,
  );

  const hasActiveAgent = Boolean(activeAgentId);
  const pluginSkillCount = useMemo(
    () => plugins.reduce((sum: number, pg: PluginSkillGroup) => sum + pg.skills.length, 0),
    [plugins],
  );
  const activeProjectSkills = useMemo(
    () => projectGroups.filter((pg) => pg.projectPath === activeProjectPath).flatMap((pg) => pg.skills),
    [projectGroups, activeProjectPath],
  );
  const total = global.length + activeProjectSkills.length + pluginSkillCount;

  const favorites = useMemo(() => getFavorites(), [getFavorites, favoriteIds, global, projectGroups, plugins]);

  const handleToggleFav = useCallback(
    (id: string) => { toggleFavorite(id).catch(console.error); },
    [toggleFavorite],
  );

  const handleInvoke = useCallback(
    (command: string) => {
      if (!hasActiveAgent) return;
      sendMessage(command).catch(console.error);
    },
    [hasActiveAgent],
  );

  const handleSettingsClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      useLayoutStore.getState().openSettings("skills");
    },
    [],
  );

  return (
    <DashboardCard
      id="skills"
      icon={Sparkles}
      title="Skills"
      statusText={String(total)}
      statusColor={total > 0 ? "green" : "gray"}
      expanded={expanded}
      onToggle={onToggle}
      headerExtra={
        <Tooltip text="Skills settings">
          <button
            className="dash-card__settings-btn"
            onClick={handleSettingsClick}
          >
            <Settings size={12} />
          </button>
        </Tooltip>
      }
    >
      <div className="dash-card__skills-sections">
        <SkillSection label="Favorites" count={favorites.length} defaultOpen>
          {favorites.map((s) => (
            <SkillRowMini
              key={s.id}
              skill={s}
              isFavorite
              disabled={!hasActiveAgent}
              onToggleFav={handleToggleFav}
              onInvoke={handleInvoke}
            />
          ))}
        </SkillSection>

        <SkillSection label="Global" count={global.length}>
          {global.map((s) => (
            <SkillRowMini
              key={s.id}
              skill={s}
              isFavorite={favoriteIds.includes(s.id)}
              disabled={!hasActiveAgent}
              onToggleFav={handleToggleFav}
              onInvoke={handleInvoke}
            />
          ))}
        </SkillSection>

        <SkillSection label="Project" count={activeProjectSkills.length}>
          {activeProjectSkills.map((s: SkillEntry) => (
            <SkillRowMini
              key={s.id}
              skill={s}
              isFavorite={favoriteIds.includes(s.id)}
              disabled={!hasActiveAgent}
              onToggleFav={handleToggleFav}
              onInvoke={handleInvoke}
            />
          ))}
        </SkillSection>

        <SkillSection label="Plugins" count={pluginSkillCount}>
          {plugins.map((pg: PluginSkillGroup) => (
            <SkillSection key={pg.pluginName} label={pg.pluginName} count={pg.skills.length}>
              {pg.skills.map((s) => (
                <SkillRowMini
                  key={s.id}
                  skill={s}
                  isFavorite={favoriteIds.includes(s.id)}
                  disabled={!hasActiveAgent}
                  onToggleFav={handleToggleFav}
                  onInvoke={handleInvoke}
                />
              ))}
            </SkillSection>
          ))}
        </SkillSection>

        {total === 0 && (
          <div className="skills-panel--empty">No skills found</div>
        )}
      </div>
    </DashboardCard>
  );
});
