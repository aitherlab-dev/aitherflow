import { memo, useCallback, useMemo, useState } from "react";
import { ChevronRight, Settings, Sparkles, Star } from "lucide-react";
import { useSkillStore } from "../../../stores/skillStore";
import { useAgentStore } from "../../../stores/agentStore";
import { sendMessage } from "../../../stores/chatService";
import { useLayoutStore } from "../../../stores/layoutStore";
import { useTranslationStore } from "../../../stores/translationStore";
import { DashboardCard } from "../DashboardCard";
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
    <div
      className={`skills-row ${disabled ? "skills-row--disabled" : ""}`}
      onClick={() => { if (!disabled) onInvoke(skill.command); }}
      data-tooltip={disabled ? "" : desc}
      onMouseEnter={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        e.currentTarget.style.setProperty("--tt-top", `${r.top + r.height / 2}px`);
        e.currentTarget.style.setProperty("--tt-left", `${r.right + 8}px`);
      }}
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
  const global = useSkillStore((s) => s.global);
  const project = useSkillStore((s) => s.project);
  const plugins = useSkillStore((s) => s.plugins);
  const favoriteIds = useSkillStore((s) => s.favoriteIds);
  const getFavorites = useSkillStore((s) => s.getFavorites);
  const toggleFavorite = useSkillStore((s) => s.toggleFavorite);

  const activeAgentId = useAgentStore((s) => s.activeAgentId);
  const openSettings = useLayoutStore((s) => s.openSettings);

  const hasActiveAgent = Boolean(activeAgentId);
  const pluginSkills = useMemo(
    () => plugins.flatMap((pg: PluginSkillGroup) => pg.skills),
    [plugins],
  );
  const total = global.length + project.length + pluginSkills.length;

  const favorites = useMemo(() => getFavorites(), [getFavorites, favoriteIds, global, project, plugins]);

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
      openSettings("skills");
    },
    [openSettings],
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
        expanded ? (
          <button
            className="dash-card__settings-btn"
            onClick={handleSettingsClick}
            title="Skills settings"
          >
            <Settings size={12} />
          </button>
        ) : undefined
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

        <SkillSection label="Project" count={project.length}>
          {project.map((s) => (
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

        <SkillSection label="Plugins" count={pluginSkills.length}>
          {pluginSkills.map((s) => (
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

        {total === 0 && (
          <div className="skills-panel--empty">No skills found</div>
        )}
      </div>
    </DashboardCard>
  );
});
