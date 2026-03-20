import { memo, useState } from "react";
import { Database, Settings } from "lucide-react";
import { BaseList } from "./BaseList";
import { BaseDetail } from "./BaseDetail";
import { RagSettingsPanel } from "./RagSettingsPanel";

export const KnowledgePage = memo(function KnowledgePage() {
  const [showSettings, setShowSettings] = useState(false);

  return (
    <div className="kb-page">
      <div className="kb-page__sidebar">
        <div className="kb-page__sidebar-header">
          <button
            className={`kb-page__tab${!showSettings ? " kb-page__tab--active" : ""}`}
            onClick={() => setShowSettings(false)}
          >
            <Database size={14} />
            <span>Bases</span>
          </button>
          <button
            className={`kb-page__tab${showSettings ? " kb-page__tab--active" : ""}`}
            onClick={() => setShowSettings(true)}
          >
            <Settings size={14} />
            <span>Settings</span>
          </button>
        </div>
        {showSettings ? <RagSettingsPanel /> : <BaseList />}
      </div>
      {!showSettings && <BaseDetail />}
    </div>
  );
});
