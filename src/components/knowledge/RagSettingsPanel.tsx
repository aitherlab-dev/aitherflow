import { memo, useCallback, useEffect, useState } from "react";
import { Save, AlertTriangle } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useKnowledgeStore } from "../../stores/knowledgeStore";
import type { RagSettings } from "../../types/knowledge";

const MODELS = [
  { value: "all-MiniLM-L6-v2", label: "all-MiniLM-L6-v2 — Fast, English, 23MB" },
  { value: "multilingual-e5-small", label: "multilingual-e5-small — Multilingual, 118MB" },
  { value: "multilingual-e5-large", label: "multilingual-e5-large — Multilingual, best quality, 560MB" },
  { value: "nomic-embed-text-v1.5", label: "nomic-embed-text-v1.5 — English, 137MB" },
];

const CHUNK_SIZES = [256, 512, 1024, 2048];
const OVERLAPS = [32, 64, 128, 256];
const SEARCH_LIMITS = [5, 10, 20, 50];

export const RagSettingsPanel = memo(function RagSettingsPanel() {
  const { ragSettings, loadRagSettings, saveRagSettings } = useKnowledgeStore(
    useShallow((s) => ({
      ragSettings: s.ragSettings,
      loadRagSettings: s.loadRagSettings,
      saveRagSettings: s.saveRagSettings,
    })),
  );

  const [draft, setDraft] = useState<RagSettings | null>(null);
  const [modelChanged, setModelChanged] = useState(false);

  useEffect(() => {
    loadRagSettings().catch(console.error);
  }, [loadRagSettings]);

  useEffect(() => {
    if (ragSettings && !draft) {
      setDraft(ragSettings);
    }
  }, [ragSettings, draft]);

  const handleChange = useCallback(
    (field: keyof RagSettings, value: string | number | boolean) => {
      setDraft((prev) => {
        if (!prev) return prev;
        const next = { ...prev, [field]: value };
        if (field === "embeddingModel" && ragSettings) {
          setModelChanged(value !== ragSettings.embeddingModel);
        }
        return next;
      });
    },
    [ragSettings],
  );

  const handleSave = useCallback(() => {
    if (draft) {
      saveRagSettings(draft).catch(console.error);
      setModelChanged(false);
    }
  }, [draft, saveRagSettings]);

  if (!draft) return null;

  return (
    <div className="kb-settings">
      <div className="kb-settings__row">
        <label className="kb-settings__label">
          Embedding Model
          <select
            className="kb-settings__select"
            value={draft.embeddingModel}
            onChange={(e) => handleChange("embeddingModel", e.target.value)}
          >
            {MODELS.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </label>
        {modelChanged && (
          <div className="kb-settings__warning">
            <AlertTriangle size={14} />
            <span>Changing model requires reindexing all bases (app restart needed)</span>
          </div>
        )}
      </div>

      <div className="kb-settings__row">
        <label className="kb-settings__label">
          Chunk Size
          <select
            className="kb-settings__select"
            value={draft.chunkSize}
            onChange={(e) => handleChange("chunkSize", Number(e.target.value))}
          >
            {CHUNK_SIZES.map((s) => (
              <option key={s} value={s}>{s} tokens</option>
            ))}
          </select>
        </label>
      </div>

      <div className="kb-settings__row">
        <label className="kb-settings__label">
          Chunk Overlap
          <select
            className="kb-settings__select"
            value={draft.chunkOverlap}
            onChange={(e) => handleChange("chunkOverlap", Number(e.target.value))}
          >
            {OVERLAPS.map((o) => (
              <option key={o} value={o}>{o} tokens</option>
            ))}
          </select>
        </label>
      </div>

      <div className="kb-settings__row">
        <label className="kb-settings__label">
          Search Results Limit
          <select
            className="kb-settings__select"
            value={draft.searchResultsLimit}
            onChange={(e) => handleChange("searchResultsLimit", Number(e.target.value))}
          >
            {SEARCH_LIMITS.map((l) => (
              <option key={l} value={l}>{l} results</option>
            ))}
          </select>
        </label>
      </div>

      <div className="kb-settings__row">
        <label className="kb-settings__toggle-label">
          <span>Knowledge MCP Server</span>
          <input
            type="checkbox"
            className="kb-settings__checkbox"
            checked={draft.knowledgeMcpEnabled}
            onChange={(e) => handleChange("knowledgeMcpEnabled", e.target.checked)}
          />
        </label>
      </div>

      <button className="kb-btn kb-btn--accent" onClick={handleSave}>
        <Save size={14} />
        <span>Save Settings</span>
      </button>
    </div>
  );
});
