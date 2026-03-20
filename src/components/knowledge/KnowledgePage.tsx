import { memo } from "react";
import { BaseList } from "./BaseList";
import { BaseDetail } from "./BaseDetail";

export const KnowledgePage = memo(function KnowledgePage() {
  return (
    <div className="kb-page">
      <BaseList />
      <BaseDetail />
    </div>
  );
});
