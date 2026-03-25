import { memo, useState, useCallback } from "react";
import { ChevronRight } from "lucide-react";
import type { ToolActivity } from "../../types/chat";
import { summarizeToolInput } from "../../stores/chatStore";
import { useFileViewerStore } from "../../stores/fileViewerStore";
import { ImageResult } from "./ImageResult";

/** Tools whose summary is a file path (clickable) */
const FILE_TOOLS = new Set([
  "Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "NotebookRead",
]);

/** Detect if a Bash command is a call to an external AI model API */
function isAiApiCall(toolName: string, toolInput: Record<string, unknown>): boolean {
  if (toolName !== "Bash") return false;
  const cmd = typeof toolInput.command === "string" ? toolInput.command : "";
  return /\/chat\/completions|\/api\/generate|\/api\/chat/.test(cmd);
}

/** Image file extensions for result detection */
const IMAGE_EXTENSIONS = /\.(png|jpg|jpeg|webp)$/i;

/** Tools that can return generated images */
const IMAGE_TOOLS = new Set([
  "generate_image",
  "mcp__aitherflow-models__generate_image",
]);

/** Extract image path from a generate_image tool result (expects JSON with "path" field) */
function extractImagePath(toolName: string, result?: string): string | null {
  if (!result || !IMAGE_TOOLS.has(toolName)) return null;
  try {
    const parsed = JSON.parse(result.trim());
    const path = parsed.path;
    if (typeof path === "string" && IMAGE_EXTENSIONS.test(path)) return path;
  } catch { /* not valid JSON yet — still streaming or malformed */ }
  return null;
}

/** Color class suffix per tool type */
function toolColorClass(name: string): string {
  switch (name) {
    case "Read": return "read";
    case "Edit":
    case "MultiEdit": return "edit";
    case "Write": return "write";
    case "Bash": return "bash";
    case "Grep":
    case "Glob": return "search";
    case "WebSearch":
    case "WebFetch": return "web";
    case "Task":
    case "Agent": return "agent";
    default: return "default";
  }
}

interface ToolCardProps {
  activity: ToolActivity;
  isRunning: boolean;
}

export const ToolCard = memo(function ToolCard({ activity, isRunning }: ToolCardProps) {
  const [expanded, setExpanded] = useState(false);
  const summary = summarizeToolInput(activity.toolName, activity.toolInput);
  const isFile = FILE_TOOLS.has(activity.toolName) && summary.length > 0;
  const colorCls = toolColorClass(activity.toolName);
  const hasError = activity.isError === true;
  const isAiResult = isAiApiCall(activity.toolName, activity.toolInput);
  const imagePath = extractImagePath(activity.toolName, activity.result);

  const toggle = useCallback(() => setExpanded((v) => !v), []);

  const handleFileClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (isFile) {
        useFileViewerStore.getState().openPreview(summary).catch(console.error);
      }
    },
    [isFile, summary],
  );

  return (
    <div className="tool-card">
      <button className="tool-card-row" onClick={toggle} type="button">
        <span
          className={`tool-card-dot ${isRunning ? "tool-card-dot--running" : hasError ? "tool-card-dot--error" : ""}`}
        />
        <span className={`tool-card-name tool-card-name--${colorCls} ${hasError ? "tool-card-name--error" : ""}`}>
          {activity.toolName}
        </span>
        {summary && (
          isFile ? (
            <span className="tool-card-summary tool-card-summary--file" onClick={handleFileClick}>
              {summary}
            </span>
          ) : (
            <span className="tool-card-summary">{summary}</span>
          )
        )}
        <ChevronRight
          size={14}
          className={`tool-card-chevron ${expanded ? "tool-card-chevron--open" : ""}`}
        />
      </button>

      {imagePath && <ImageResult filePath={imagePath} />}

      {expanded && (
        <div className="tool-card-detail">
          <pre className="tool-card-json">
            {JSON.stringify(activity.toolInput, null, 2)}
          </pre>
          {activity.result && (
            <pre className={`tool-card-result ${hasError ? "tool-card-result--error" : isAiResult ? "tool-card-result--ai" : ""}`}>
              {activity.result}
            </pre>
          )}
        </div>
      )}
    </div>
  );
});
