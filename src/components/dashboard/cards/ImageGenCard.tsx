import { memo, useCallback, useEffect, useState } from "react";
import { Image, Settings } from "lucide-react";
import { invoke } from "../../../lib/transport";
import { useLayoutStore } from "../../../stores/layoutStore";
import { DashboardCard } from "../DashboardCard";
import { Tooltip } from "../../shared/Tooltip";
import type { ImageGenSettings, ImageModel } from "../../../hooks/useImageGenSettings";

export const ImageGenCard = memo(function ImageGenCard({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  const [settings, setSettings] = useState<ImageGenSettings | null>(null);
  const [models, setModels] = useState<ImageModel[]>([]);
  const [loraFiles, setLoraFiles] = useState<string[]>([]);

  const loadData = useCallback(() => {
    invoke<ImageGenSettings>("load_image_gen_settings")
      .then((s) => {
        setSettings(s);
        invoke<ImageModel[]>("list_image_gen_models", { modelsPath: s.modelsPath })
          .then(setModels)
          .catch(console.error);
        if (s.loraDirectory) {
          invoke<string[]>("list_lora_files", { directory: s.loraDirectory })
            .then(setLoraFiles)
            .catch(console.error);
        } else {
          setLoraFiles([]);
        }
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    if (expanded) loadData();
  }, [expanded, loadData]);

  useEffect(() => {
    const handler = () => loadData();
    window.addEventListener("imagegen-updated", handler);
    return () => window.removeEventListener("imagegen-updated", handler);
  }, [loadData]);

  const selected = models.find((m) => m.id === settings?.selectedModel);
  const isReady = selected?.downloaded ?? false;
  const hasLora = !!selected?.lora;
  const loraFile = selected?.lora
    ? selected.lora.split("/").pop() ?? selected.lora
    : null;

  // Header status: model name + LoRA status
  const statusParts: string[] = [];
  if (selected) statusParts.push(selected.name);
  if (hasLora) statusParts.push(selected!.loraEnabled ? "LoRA: on" : "LoRA: off");
  const statusText = statusParts.join(" · ") || "";

  const handleModelChange = useCallback(
    async (modelId: string) => {
      if (!settings) return;
      const updated = { ...settings, selectedModel: modelId };
      setSettings(updated);
      try {
        await invoke("save_image_gen_settings", { settings: updated });
      } catch (e) {
        console.error("Failed to save settings:", e);
      }
    },
    [settings],
  );

  const handleLoraChange = useCallback(async (filename: string) => {
    if (!settings || !selected) return;
    const fullPath = filename ? `${settings.loraDirectory}/${filename}` : null;
    try {
      await invoke("update_image_gen_model_lora", {
        modelId: selected.id,
        loraPath: fullPath,
        loraStrength: selected.loraStrength,
        enabled: selected.loraEnabled,
      });
      loadData();
    } catch (e) {
      console.error("Failed to change LoRA:", e);
    }
  }, [settings, selected, loadData]);

  const handleLoraToggle = useCallback(async () => {
    if (!settings || !selected) return;
    const newEnabled = !selected.loraEnabled;
    try {
      await invoke("update_image_gen_model_lora", {
        modelId: selected.id,
        loraPath: selected.lora,
        loraStrength: selected.loraStrength,
        enabled: newEnabled,
      });
      loadData();
    } catch (e) {
      console.error("Failed to toggle LoRA:", e);
    }
  }, [settings, selected, loadData]);

  const handleOpenSettings = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    useLayoutStore.getState().openSettings("image-gen");
  }, []);

  const settingsBtn = (
    <Tooltip text="Image generation settings">
      <button className="dash-card__action" onClick={handleOpenSettings}>
        <Settings size={12} />
      </button>
    </Tooltip>
  );

  return (
    <DashboardCard
      id="imagegen"
      icon={Image}
      title="Image Gen"
      statusText={statusText}
      statusColor={isReady ? "green" : selected ? "gray" : "dim"}
      expanded={expanded}
      onToggle={onToggle}
      headerExtra={settingsBtn}
    >
      <div className="dash-card__details">
        {/* Model selector */}
        <div className="dash-card__row">
          <span className="dash-card__label">Model</span>
          <select
            className="dash-card__select"
            value={settings?.selectedModel ?? ""}
            onChange={(e) => handleModelChange(e.target.value)}
            onClick={(e) => e.stopPropagation()}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} {m.downloaded ? "✓" : ""}
              </option>
            ))}
          </select>
        </div>

        {/* LoRA selector + toggle */}
        <div className="dash-card__row">
          <span className="dash-card__label">LoRA</span>
          {loraFiles.length > 0 ? (
            <>
              <select
                className="dash-card__select"
                value={loraFile ?? ""}
                onChange={(e) => { e.stopPropagation(); handleLoraChange(e.target.value); }}
                onClick={(e) => e.stopPropagation()}
              >
                <option value="">None</option>
                {loraFiles.map((f) => (
                  <option key={f} value={f}>{f.replace(".safetensors", "")}</option>
                ))}
              </select>
              {hasLora && (
                <button
                  className={`dash-card__toggle ${selected!.loraEnabled ? "dash-card__toggle--on" : ""}`}
                  onClick={(e) => { e.stopPropagation(); handleLoraToggle(); }}
                >
                  <span className="dash-card__toggle-knob" />
                </button>
              )}
            </>
          ) : (
            <span className="dash-card__dim">No directory set</span>
          )}
        </div>

        {/* Models dir */}
        {settings && (
          <div className="dash-card__row">
            <span className="dash-card__label">Models dir</span>
            <span className="dash-card__dim">{settings.modelsPath}</span>
          </div>
        )}
      </div>
    </DashboardCard>
  );
});
