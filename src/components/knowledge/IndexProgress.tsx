import { memo } from "react";
import { Loader2, CheckCircle2, AlertCircle } from "lucide-react";

interface IndexProgressProps {
  status: "ready" | "indexing" | "error" | "indexed";
  compact?: boolean;
}

export const IndexProgress = memo(function IndexProgress({ status, compact }: IndexProgressProps) {
  if (status === "indexing") {
    return (
      <span className={`kb-status kb-status--indexing${compact ? " kb-status--compact" : ""}`}>
        <Loader2 size={compact ? 12 : 14} className="kb-status__spinner" />
        {!compact && <span>Indexing…</span>}
      </span>
    );
  }

  if (status === "error") {
    return (
      <span className={`kb-status kb-status--error${compact ? " kb-status--compact" : ""}`}>
        <AlertCircle size={compact ? 12 : 14} />
        {!compact && <span>Error</span>}
      </span>
    );
  }

  if (status === "ready" || status === "indexed") {
    return (
      <span className={`kb-status kb-status--ready${compact ? " kb-status--compact" : ""}`}>
        <CheckCircle2 size={compact ? 12 : 14} />
        {!compact && <span>Ready</span>}
      </span>
    );
  }

  return null;
});
