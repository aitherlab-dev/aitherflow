import { memo } from "react";
import { useLayoutStore } from "../../stores/layoutStore";
import { ResizeHandle } from "./ResizeHandle";

export const Sidebar = memo(function Sidebar() {
  const open = useLayoutStore((s) => s.sidebarOpen);
  const width = useLayoutStore((s) => s.sidebarWidth);

  return (
    <aside
      className="app-sidebar"
      style={{ width: open ? width : 0 }}
    >
      {open && (
        <>
          <div className="sidebar-content">
            <div className="sidebar-placeholder">Sidebar</div>
          </div>
          <ResizeHandle />
        </>
      )}
    </aside>
  );
});
