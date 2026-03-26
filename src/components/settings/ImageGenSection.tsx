import { memo } from "react";
import { FolderOpen, Download, Loader2, Check, FileSearch, Trash2, Plus, ChevronUp, X } from "lucide-react";
import { Tooltip } from "../shared/Tooltip";
import {
  useImageGenSettings,
  RESOLUTION_PRESETS,
  DEFAULT_MODEL_ID,
  formatSize,
} from "../../hooks/useImageGenSettings";

export const ImageGenSection = memo(function ImageGenSection() {
  const {
    settings,
    models,
    downloadingModel,
    downloadError,
    customUrl,
    downloadingUrl,
    loraPath,
    loraStrength,
    loraFiles,
    showAddForm,
    addName,
    addType,
    addDiffusionUrl,
    addLlmUrl,
    addError,
    isCustom,
    selected,
    actions,
  } = useImageGenSettings();

  if (!settings) return null;

  const CUSTOM = "__custom__";
  const selectValue = isCustom ? CUSTOM : settings.selectedModel;

  return (
    <div className="settings-section-general">
      {/* Models path */}
      <div className="settings-toggle-row">
        <div className="settings-toggle-info">
          <span className="settings-toggle-label">Models directory</span>
          <span className="settings-toggle-desc">
            Where image generation models are stored
          </span>
        </div>
        <div className="settings-input-row">
          <input
            type="text"
            className="settings-input"
            value={settings.modelsPath}
            onChange={(e) => {
              actions.save({ ...settings, modelsPath: e.target.value });
              actions.debouncedRefreshModels(e.target.value);
            }}
            spellCheck={false}
          />
          <Tooltip text="Browse">
            <button className="settings-input-toggle" onClick={() => actions.pickDir("modelsPath")}>
              <FolderOpen size={14} />
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Images path */}
      <div className="settings-toggle-row">
        <div className="settings-toggle-info">
          <span className="settings-toggle-label">Output directory</span>
          <span className="settings-toggle-desc">
            Where generated images are saved
          </span>
        </div>
        <div className="settings-input-row">
          <input
            type="text"
            className="settings-input"
            value={settings.imagesPath}
            onChange={(e) => actions.save({ ...settings, imagesPath: e.target.value })}
            spellCheck={false}
          />
          <Tooltip text="Browse">
            <button className="settings-input-toggle" onClick={() => actions.pickDir("imagesPath")}>
              <FolderOpen size={14} />
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Model selection */}
      <div className="settings-toggle-row">
        <div className="settings-toggle-info">
          <span className="settings-toggle-label">Model</span>
          <span className="settings-toggle-desc">
            Select which model to use for generation
          </span>
        </div>
        <div className="settings-input-row">
          <select
            className="settings-select"
            value={selectValue}
            onChange={(e) => {
              const v = e.target.value;
              actions.save({ ...settings, selectedModel: v === CUSTOM ? "" : v });
              actions.setDownloadError(null);
            }}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({formatSize(m.sizeMb)})
              </option>
            ))}
            <option value={CUSTOM}>Custom model</option>
          </select>
          {!isCustom && selected && (
            selected.downloaded ? (
              <span className="imggen-ready">
                <Check size={14} />
                <span>Ready</span>
              </span>
            ) : (
              <button
                className={`imggen-model-btn ${downloadingModel ? "imggen-model-btn--disabled" : ""}`}
                disabled={downloadingModel !== null}
                onClick={() => actions.handleDownload(selected)}
              >
                {downloadingModel === selected.id ? (
                  <Loader2 size={14} className="imggen-spinner" />
                ) : (
                  <Download size={14} />
                )}
                <span>{downloadingModel === selected.id ? "Downloading..." : "Download"}</span>
              </button>
            )
          )}
          {!isCustom && selected && selected.id !== DEFAULT_MODEL_ID && (
            <Tooltip text="Remove model">
              <button
                className="imggen-model-btn imggen-model-btn--danger"
                onClick={() => actions.handleRemoveModel(selected.id)}
              >
                <Trash2 size={14} />
              </button>
            </Tooltip>
          )}
        </div>
      </div>

      {/* Custom model file path */}
      {isCustom && (
        <div className="settings-toggle-row">
          <div className="settings-toggle-info">
            <span className="settings-toggle-label">Model file</span>
            <span className="settings-toggle-desc">
              Path to .safetensors or .gguf file
            </span>
          </div>
          <div className="settings-input-row">
            <input
              type="text"
              className="settings-input"
              value={settings.selectedModel}
              onChange={(e) => actions.save({ ...settings, selectedModel: e.target.value })}
              placeholder="/path/to/model.gguf"
              spellCheck={false}
            />
            <Tooltip text="Browse">
              <button
                className="settings-input-toggle"
                onClick={actions.pickModelFile}
              >
                <FileSearch size={14} />
              </button>
            </Tooltip>
          </div>
        </div>
      )}

      {/* LoRA section — only for known models */}
      {!isCustom && selected && (
        <>
          {/* LoRA directory */}
          <div className="settings-toggle-row">
            <div className="settings-toggle-info">
              <span className="settings-toggle-label">LoRA directory</span>
              <span className="settings-toggle-desc">
                Folder with .safetensors LoRA files
              </span>
            </div>
            <div className="settings-input-row">
              <input
                type="text"
                className="settings-input"
                value={settings.loraDirectory}
                placeholder="Not set"
                spellCheck={false}
                readOnly
              />
              <Tooltip text="Browse">
                <button className="settings-input-toggle" onClick={actions.handleLoraDirBrowse}>
                  <FolderOpen size={14} />
                </button>
              </Tooltip>
            </div>
          </div>

          {/* LoRA select */}
          <div className="settings-toggle-row">
            <div className="settings-toggle-info">
              <span className="settings-toggle-label">
                LoRA adapter
                {loraPath && <span className="imggen-lora-badge">Active</span>}
              </span>
              <span className="settings-toggle-desc">
                {loraFiles.length > 0
                  ? `${loraFiles.length} file${loraFiles.length > 1 ? "s" : ""} found`
                  : settings.loraDirectory
                    ? "No .safetensors files found"
                    : "Set LoRA directory first"}
              </span>
            </div>
            <div className="settings-input-row">
              <select
                className="settings-input"
                value={loraPath ? loraPath.split("/").pop() ?? "" : ""}
                onChange={(e) => actions.handleLoraSelect(e.target.value)}
                disabled={loraFiles.length === 0}
              >
                <option value="">None</option>
                {loraFiles.map((f) => (
                  <option key={f} value={f}>{f.replace(".safetensors", "")}</option>
                ))}
              </select>
              {loraPath && (
                <Tooltip text="Clear LoRA">
                  <button className="settings-input-toggle" onClick={actions.handleLoraClear}>
                    <X size={14} />
                  </button>
                </Tooltip>
              )}
            </div>
          </div>
          {loraPath && (
            <div className="settings-toggle-row">
              <div className="settings-toggle-info">
                <span className="settings-toggle-label">LoRA strength</span>
              </div>
              <div className="imggen-steps-row">
                <input
                  type="range"
                  className="imggen-slider"
                  min={0}
                  max={2}
                  step={0.1}
                  value={loraStrength}
                  onChange={(e) => actions.handleLoraStrengthChange(Number(e.target.value))}
                />
                <span className="imggen-steps-value">{loraStrength.toFixed(1)}</span>
              </div>
            </div>
          )}
        </>
      )}

      {downloadError && (
        <div className="settings-toggle-row">
          <div className="imggen-error">{downloadError}</div>
        </div>
      )}

      {/* Download custom model by URL */}
      <div className="settings-toggle-row">
        <div className="settings-toggle-info">
          <span className="settings-toggle-label">Download custom model</span>
          <span className="settings-toggle-desc">
            Paste a HuggingFace model URL to download
          </span>
        </div>
        <div className="settings-input-row">
          <input
            type="text"
            className="settings-input"
            value={customUrl}
            onChange={(e) => actions.setCustomUrl(e.target.value)}
            placeholder="HuggingFace model URL"
            spellCheck={false}
            disabled={downloadingUrl}
          />
          <button
            className={`imggen-model-btn ${downloadingUrl || !customUrl.trim() ? "imggen-model-btn--disabled" : ""}`}
            disabled={downloadingUrl || !customUrl.trim()}
            onClick={actions.handleUrlDownload}
          >
            {downloadingUrl ? (
              <Loader2 size={14} className="imggen-spinner" />
            ) : (
              <Download size={14} />
            )}
            <span>{downloadingUrl ? "Downloading..." : "Download"}</span>
          </button>
        </div>
      </div>

      {/* Add model */}
      <div className="settings-toggle-row">
        <button
          className="imggen-model-btn"
          onClick={() => actions.setShowAddForm(!showAddForm)}
        >
          {showAddForm ? <ChevronUp size={14} /> : <Plus size={14} />}
          <span>{showAddForm ? "Cancel" : "Add model"}</span>
        </button>
      </div>

      {showAddForm && (
        <div className="imggen-add-form">
          <div className="settings-toggle-row">
            <div className="settings-toggle-info">
              <span className="settings-toggle-label">Name</span>
            </div>
            <input
              type="text"
              className="settings-input"
              value={addName}
              onChange={(e) => actions.setAddName(e.target.value)}
              placeholder="My Custom Model"
              spellCheck={false}
            />
          </div>
          <div className="settings-toggle-row">
            <div className="settings-toggle-info">
              <span className="settings-toggle-label">Type</span>
            </div>
            <select
              className="settings-select"
              value={addType}
              onChange={(e) => actions.setAddType(e.target.value as "flux2" | "flux1" | "sdxl" | "zimage")}
            >
              <option value="flux2">FLUX.2</option>
              <option value="flux1">FLUX.1</option>
              <option value="sdxl">SDXL</option>
              <option value="zimage">Z-Image</option>
            </select>
          </div>
          <div className="settings-toggle-row">
            <div className="settings-toggle-info">
              <span className="settings-toggle-label">Diffusion model URL</span>
              <span className="settings-toggle-desc">HuggingFace URL to the model file</span>
            </div>
            <input
              type="text"
              className="settings-input"
              value={addDiffusionUrl}
              onChange={(e) => actions.setAddDiffusionUrl(e.target.value)}
              placeholder="https://huggingface.co/org/repo/resolve/main/model.gguf"
              spellCheck={false}
            />
          </div>
          {addType === "flux2" && (
            <div className="settings-toggle-row">
              <div className="settings-toggle-info">
                <span className="settings-toggle-label">LLM encoder URL</span>
                <span className="settings-toggle-desc">HuggingFace URL to the LLM text encoder</span>
              </div>
              <input
                type="text"
                className="settings-input"
                value={addLlmUrl}
                onChange={(e) => actions.setAddLlmUrl(e.target.value)}
                placeholder="https://huggingface.co/org/repo/resolve/main/encoder.gguf"
                spellCheck={false}
              />
            </div>
          )}
          {addError && (
            <div className="settings-toggle-row">
              <div className="imggen-error">{addError}</div>
            </div>
          )}
          <div className="settings-toggle-row">
            <button
              className={`imggen-model-btn imggen-model-btn--active ${!addName.trim() || !addDiffusionUrl.trim() ? "imggen-model-btn--disabled" : ""}`}
              disabled={!addName.trim() || !addDiffusionUrl.trim()}
              onClick={actions.handleAddModel}
            >
              <Plus size={14} />
              <span>Add</span>
            </button>
          </div>
        </div>
      )}

      {/* Resolution */}
      <div className="settings-toggle-row">
        <div className="settings-toggle-info">
          <span className="settings-toggle-label">Default resolution</span>
          <span className="settings-toggle-desc">
            Image dimensions for generation
          </span>
        </div>
        <select
          className="settings-select"
          value={settings.resolutionPreset}
          onChange={(e) => actions.handleResolutionChange(e.target.value)}
        >
          {Object.entries(RESOLUTION_PRESETS).map(([key, { label }]) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>
      </div>

      {/* Custom resolution fields */}
      {settings.resolutionPreset === "custom" && (
        <div className="settings-toggle-row">
          <div className="settings-toggle-info">
            <span className="settings-toggle-label">Custom size</span>
          </div>
          <div className="settings-input-row">
            <input
              type="number"
              className="settings-input imggen-size-input"
              value={settings.width}
              min={64}
              max={2048}
              step={64}
              onChange={(e) => actions.save({ ...settings, width: Number(e.target.value) || 512 })}
            />
            <span className="imggen-size-x">×</span>
            <input
              type="number"
              className="settings-input imggen-size-input"
              value={settings.height}
              min={64}
              max={2048}
              step={64}
              onChange={(e) => actions.save({ ...settings, height: Number(e.target.value) || 512 })}
            />
          </div>
        </div>
      )}

      {/* Steps */}
      <div className="settings-toggle-row">
        <div className="settings-toggle-info">
          <span className="settings-toggle-label">Inference steps</span>
          <span className="settings-toggle-desc">
            More steps = better quality, slower generation
          </span>
        </div>
        <div className="imggen-steps-row">
          <input
            type="range"
            className="imggen-slider"
            min={10}
            max={50}
            value={settings.steps}
            onChange={(e) => actions.save({ ...settings, steps: Number(e.target.value) })}
          />
          <span className="imggen-steps-value">{settings.steps}</span>
        </div>
      </div>
    </div>
  );
});
