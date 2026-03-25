import { useCallback, useEffect } from "react";
import { Tooltip } from "../shared/Tooltip";
import {
  X,
  User,
  Users,
  Webhook,
  FileText,
  FolderOpen,
  Sparkles,
  Languages,
  Mic,
  Send,
  Cable,
  BarChart3,
  Keyboard,
  Blocks,
  BookOpen,
  Image,
} from "lucide-react";
import { useLayoutStore } from "../../stores/layoutStore";
import { ProjectsSection } from "./ProjectsSection";
import { GeneralSection } from "./GeneralSection";
import { SkillsSection } from "./SkillsSection";
import { LanguageSection } from "./LanguageSection";
import { VoiceSection } from "./VoiceSection";
import { TelegramSection } from "./TelegramSection";
import { HooksSection } from "./hooks";
import { McpSection } from "./mcp-section";
import { CliStatsSection } from "./CliStatsSection";
import { HotkeysSection } from "./HotkeysSection";
import { ClaudeMdSection } from "./ClaudeMdSection";
import { RolesSection } from "./RolesSection";
import { ExternalModelsSection } from "./ExternalModelsSection";
import { KnowledgeSection } from "./KnowledgeSection";
import { ImageGenSection } from "./ImageGenSection";

const NAV_ITEMS = [
  { id: "general", label: "General", icon: User },
  { id: "roles", label: "Roles", icon: Users },
  { id: "hotkeys", label: "Hotkeys", icon: Keyboard },
  { id: "hooks", label: "Hooks", icon: Webhook },
  { id: "mcp", label: "MCP Servers", icon: Cable },
  { id: "skills", label: "Skills", icon: Sparkles },
  { id: "knowledge", label: "Knowledge", icon: BookOpen },
  { id: "image-gen", label: "Image Generation", icon: Image },
  { id: "projects", label: "Projects", icon: FolderOpen },
  { id: "language", label: "Language", icon: Languages },
  { id: "voice", label: "Voice", icon: Mic },
  { id: "external-models", label: "External Models", icon: Blocks },
  { id: "telegram", label: "Telegram", icon: Send },
  { id: "claude-md", label: "CLAUDE.MD", icon: FileText },
  { id: "cli-stats", label: "CLI Stats", icon: BarChart3 },
] as const;

export function SettingsView() {
  const section = useLayoutStore((s) => s.settingsSection);
  const setSection = useLayoutStore((s) => s.setSettingsSection);
  const close = useLayoutStore((s) => s.closeSettings);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.code === "Escape") {
        e.preventDefault();
        close();
      }
    },
    [close],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return (
    <div className="settings-view">
      {/* Navigation */}
      <nav className="settings-nav">
        <div className="settings-nav-header">Settings</div>
        {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={`settings-nav-item ${section === id ? "settings-nav-item--active" : ""}`}
            onClick={() => setSection(id)}
          >
            <Icon size={16} />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      {/* Content */}
      <div className="settings-content">
        <div className="settings-content-header">
          <h2 className="settings-content-title">
            {NAV_ITEMS.find((n) => n.id === section)?.label ?? "Settings"}
          </h2>
          <Tooltip text="Close (Esc)">
            <button className="settings-close" onClick={close}>
              <X size={18} />
            </button>
          </Tooltip>
        </div>
        <div className="settings-content-body">
          <SectionContent section={section} />
        </div>
      </div>
    </div>
  );
}

function SectionContent({ section }: { section: string }) {
  if (section === "general") {
    return <GeneralSection />;
  }
  if (section === "roles") {
    return <RolesSection />;
  }
  if (section === "skills") {
    return <SkillsSection />;
  }
  if (section === "knowledge") {
    return <KnowledgeSection />;
  }
  if (section === "image-gen") {
    return <ImageGenSection />;
  }
  if (section === "projects") {
    return <ProjectsSection />;
  }
  if (section === "language") {
    return <LanguageSection />;
  }
  if (section === "voice") {
    return <VoiceSection />;
  }
  if (section === "external-models") {
    return <ExternalModelsSection />;
  }
  if (section === "telegram") {
    return <TelegramSection />;
  }
  if (section === "hotkeys") {
    return <HotkeysSection />;
  }
  if (section === "hooks") {
    return <HooksSection />;
  }
  if (section === "mcp") {
    return <McpSection />;
  }
  if (section === "claude-md") {
    return <ClaudeMdSection />;
  }
  if (section === "cli-stats") {
    return <CliStatsSection />;
  }
  return (
    <div className="settings-placeholder">
      <p>Coming soon</p>
    </div>
  );
}
