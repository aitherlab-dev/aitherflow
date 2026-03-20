import { memo } from "react";
import { KnowledgePage } from "../knowledge/KnowledgePage";

export const KnowledgeSection = memo(function KnowledgeSection() {
  return (
    <div className="kb-settings-wrapper">
      <KnowledgePage />
    </div>
  );
});
