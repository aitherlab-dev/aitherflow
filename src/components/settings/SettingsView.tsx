import { useCallback, useEffect } from "react";
import {
  X,
  User,
  Webhook,
  Globe,
  FolderOpen,
  Sparkles,
  Languages,
  Brain,
  Mic,
} from "lucide-react";
import { useLayoutStore } from "../../stores/layoutStore";
import { ProjectsSection } from "./ProjectsSection";
import { GeneralSection } from "./GeneralSection";
import { SkillsSection } from "./SkillsSection";
import { LanguageSection } from "./LanguageSection";
import { MemorySection } from "./MemorySection";
import { WebServerSection } from "./WebServerSection";
import { VoiceSection } from "./VoiceSection";

const NAV_ITEMS = [
  { id: "general", label: "General", icon: User },
  { id: "hooks", label: "Hooks", icon: Webhook },
  { id: "web-server", label: "Web Server", icon: Globe },
  { id: "skills", label: "Skills", icon: Sparkles },
  { id: "projects", label: "Projects", icon: FolderOpen },
  { id: "language", label: "Language", icon: Languages },
  { id: "memory", label: "Memory", icon: Brain },
  { id: "voice", label: "Voice", icon: Mic },
] as const;

export function SettingsView() {
  const section = useLayoutStore((s) => s.settingsSection);
  const setSection = useLayoutStore((s) => s.setSettingsSection);
  const close = useLayoutStore((s) => s.closeSettings);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
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
          <button className="settings-close" onClick={close} title="Close (Esc)">
            <X size={18} />
          </button>
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
  if (section === "skills") {
    return <SkillsSection />;
  }
  if (section === "projects") {
    return <ProjectsSection />;
  }
  if (section === "language") {
    return <LanguageSection />;
  }
  if (section === "memory") {
    return <MemorySection />;
  }
  if (section === "web-server") {
    return <WebServerSection />;
  }
  if (section === "voice") {
    return <VoiceSection />;
  }
  return (
    <div className="settings-placeholder">
      <p>Coming soon</p>
    </div>
  );
}
