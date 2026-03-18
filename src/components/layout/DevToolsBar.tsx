import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { invoke } from "../../lib/transport";
import { useAgentStore } from "../../stores/agentStore";
import { useChatStore } from "../../stores/chatStore";
import { Tooltip } from "../shared/Tooltip";

// ── Build button with confirmation popup ──

export const BuildButton = memo(function BuildButton() {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [status, setStatus] = useState<"idle" | "blocked" | "closing">("idle");
  const btnRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  const isThinking = useChatStore((s) => s.isThinking);

  // Close popup on outside click
  useEffect(() => {
    if (!confirmOpen) return;
    function handleMouseDown(e: MouseEvent) {
      if (
        btnRef.current?.contains(e.target as Node) ||
        popupRef.current?.contains(e.target as Node)
      )
        return;
      setConfirmOpen(false);
    }
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [confirmOpen]);

  const handleClick = useCallback(() => {
    setConfirmOpen((prev) => !prev);
  }, []);

  const handleConfirm = useCallback(async () => {
    setConfirmOpen(false);

    if (isThinking) {
      setStatus("blocked");
      setTimeout(() => setStatus("idle"), 1500);
      return;
    }

    setStatus("closing");
    try {
      await invoke("self_build");
    } catch (err) {
      setStatus("idle");
      console.error("Self-build failed:", err);
    }
  }, [isThinking]);

  return (
    <div className="devtools-btn-wrap">
      <Tooltip text="Build and install">
      <button
        ref={btnRef}
        className={`devtools-btn ${status === "blocked" ? "devtools-btn--blocked" : ""} ${status === "closing" ? "devtools-btn--closing" : ""}`}
        onClick={handleClick}
      >
        {status === "blocked"
          ? "BUSY"
          : status === "closing"
            ? "CLOSING..."
            : "BUILD"}
      </button>
      </Tooltip>
      {confirmOpen && (
        <div ref={popupRef} className="build-confirm-popup">
          <span className="build-confirm-text">Build & restart?</span>
          <div className="build-confirm-buttons">
            <button
              className="build-confirm-btn build-confirm-no"
              onClick={() => setConfirmOpen(false)}
            >
              No
            </button>
            <button
              className="build-confirm-btn build-confirm-yes"
              onClick={handleConfirm}
            >
              Yes
            </button>
          </div>
        </div>
      )}
    </div>
  );
});

// ── Dev toggle button ──

export const DevButton = memo(function DevButton() {
  const [devServers, setDevServers] = useState<Set<string>>(new Set());
  const projectPath = useAgentStore(
    useShallow((s) => s.agents.find((a) => a.id === s.activeAgentId)?.projectPath ?? ""),
  );
  const isRunning = projectPath ? devServers.has(projectPath) : false;

  const handleToggle = useCallback(async () => {
    if (!projectPath) return;

    if (isRunning) {
      try {
        await invoke("stop_dev", { projectPath });
      } catch (err) {
        console.error("Stop dev failed:", err);
      }
      setDevServers((prev) => {
        const next = new Set(prev);
        next.delete(projectPath);
        return next;
      });
    } else {
      try {
        const launched = await invoke<string>("self_dev", { projectPath });
        console.log("Dev launched:", launched);
        setDevServers((prev) => new Set(prev).add(projectPath));
      } catch (err) {
        console.error("Self-dev failed:", err);
      }
    }
  }, [projectPath, isRunning]);

  return (
    <Tooltip text={isRunning ? "Stop dev server" : "Start dev server"}>
      <button
        className={`devtools-btn ${isRunning ? "devtools-btn--dev-active" : ""}`}
        onClick={handleToggle}
      >
        {isRunning && <span className="dev-pulse" />}
        {isRunning ? "STOP" : "DEV"}
      </button>
    </Tooltip>
  );
});

// ── DevTools bar (under sidebar) ──

export const DevToolsBar = memo(function DevToolsBar() {
  return (
    <div className="sidebar-footer">
      <BuildButton />
      <DevButton />
    </div>
  );
});
