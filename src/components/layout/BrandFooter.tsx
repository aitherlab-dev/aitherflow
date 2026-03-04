import { memo } from "react";

export const BrandFooter = memo(function BrandFooter() {
  return (
    <div className="brand-footer">
      <div className="brand-name">
        <span className="brand-aither">aither</span>
        <span className="brand-flow">flow</span>
      </div>
    </div>
  );
});
