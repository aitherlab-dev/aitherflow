import { memo } from "react";

export const StatusBar = memo(function StatusBar() {
  return (
    <footer className="app-statusbar">
      <span className="statusbar-text">Ready</span>
    </footer>
  );
});
