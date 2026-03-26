import { memo, useCallback, useEffect, useState } from "react";
import { Image, Settings } from "lucide-react";
import { invoke } from "../../../lib/transport";
import { useLayoutStore } from "../../../stores/layoutStore";
import { DashboardCard } from "../DashboardCard";
import { Tooltip } from "../../shared/Tooltip";

interface ImageGenSettings {
  modelsPath: string;
  selectedModel: string;
}

interface ImageModel {
  id: string;
  name: string;
  downloaded: boolean;
  lora: string | null;
  loraStrength: number;
}

export const ImageGenCard = memo(function ImageGenCard({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  const [settings, setSettings] = useState<ImageGenSettings | null>(null);
  const [models, setModels] = useState<ImageModel[]>([]);

  useEffect(() => {
    if (!expanded) return;
    invoke<ImageGenSettings>("load_image_gen_settings")
      .then((s) => {
        setSettings(s);
        invoke<ImageModel[]>("list_image_gen_models", { modelsPath: s.modelsPath })
          .then(setModels)
          .catch(console.error);
      })
      .catch(console.error);
  }, [expanded]);

  const selected = models.find((m) => m.id === settings?.selectedModel);
  const isReady = selected?.downloaded ?? false;
  const loraFile = selected?.lora
    ? selected.lora.split("/").pop() ?? selected.lora
    : null;

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
      statusText={isReady ? "Ready" : selected ? "Not downloaded" : ""}
      statusColor={isReady ? "green" : selected ? "gray" : "dim"}
      expanded={expanded}
      onToggle={onToggle}
      headerExtra={settingsBtn}
    >
      <div className="dash-card__details">
        <div className="dash-card__row">
          <span className="dash-card__label">Model</span>
          <span>{selected?.name ?? settings?.selectedModel ?? "—"}</span>
        </div>
        <div className="dash-card__row">
          <span className="dash-card__label">LoRA</span>
          {loraFile ? (
            <span>
              {loraFile} ({selected!.loraStrength.toFixed(1)})
            </span>
          ) : (
            <span className="dash-card__dim">No LoRA</span>
          )}
        </div>
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
