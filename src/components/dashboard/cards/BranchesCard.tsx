import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  GitBranch, GitCommit, FolderGit2, Plus, Trash2,
  FileEdit, FilePlus, FileX, FileQuestion, RotateCcw,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useShallow } from "zustand/react/shallow";
import { useChatStore } from "../../../stores/chatStore";
import { useAgentStore } from "../../../stores/agentStore";
import { DashboardCard } from "../DashboardCard";
import { Tooltip } from "../../shared/Tooltip";
import { Modal } from "../../Modal";

/* ── Types (mirror Rust structs) ── */

interface WorktreeEntry {
  path: string;
  branch: string;
  isBare: boolean;
}

interface ChangedFile {
  status: string;
  path: string;
}

interface RecentCommit {
  hash: string;
  message: string;
  relativeTime: string;
}

interface WorktreeDetails {
  changedFiles: ChangedFile[];
  recentCommits: RecentCommit[];
}

/* ── File status icon ── */

function FileStatusIcon({ status }: { status: string }) {
  const code = status.trim();
  if (code === "??") return <FileQuestion size={12} className="wt-detail__file-icon wt-detail__file-icon--untracked" />;
  if (code.includes("D")) return <FileX size={12} className="wt-detail__file-icon wt-detail__file-icon--deleted" />;
  if (code.includes("A")) return <FilePlus size={12} className="wt-detail__file-icon wt-detail__file-icon--added" />;
  return <FileEdit size={12} className="wt-detail__file-icon wt-detail__file-icon--modified" />;
}

/* ── Worktree details with reset button ── */

const WorktreeItemDetails = memo(function WorktreeItemDetails({
  worktreePath,
  worktreeBranch,
  onReset,
}: {
  worktreePath: string;
  worktreeBranch: string;
  onReset: () => void;
}) {
  const [details, setDetails] = useState<WorktreeDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [resetTarget, setResetTarget] = useState<RecentCommit | null>(null);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    setLoading(true);
    invoke<WorktreeDetails>("get_worktree_details", { worktreePath, commitCount: 15 })
      .then(setDetails)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [worktreePath]);

  const handleConfirmReset = useCallback(async () => {
    if (!resetTarget) return;
    setResetting(true);
    try {
      await invoke("worktree_reset", { worktreePath, commitHash: resetTarget.hash });
      // Refresh details after reset
      const updated = await invoke<WorktreeDetails>("get_worktree_details", { worktreePath, commitCount: 15 });
      setDetails(updated);
      onReset();
    } catch (e) {
      console.error("Reset failed:", e);
    } finally {
      setResetting(false);
      setResetTarget(null);
    }
  }, [resetTarget, worktreePath, onReset]);

  if (loading) return <div className="wt-detail__loading">Loading...</div>;
  if (!details) return null;

  return (
    <div className="wt-detail">
      {details.changedFiles.length > 0 && (
        <div className="wt-detail__section">
          <div className="wt-detail__section-title">Changes</div>
          {details.changedFiles.map((f) => (
            <div key={f.path} className="wt-detail__file">
              <FileStatusIcon status={f.status} />
              <span className="wt-detail__file-status">{f.status.trim()}</span>
              <span className="wt-detail__file-path">{f.path}</span>
            </div>
          ))}
        </div>
      )}

      {details.recentCommits.length > 0 && (
        <div className="wt-detail__section">
          <div className="wt-detail__section-title">Commits</div>
          {details.recentCommits.map((c) => (
            <div key={c.hash} className="wt-detail__commit">
              <GitCommit size={11} className="wt-detail__commit-icon" />
              <span className="wt-detail__commit-hash">{c.hash}</span>
              <span className="wt-detail__commit-msg">{c.message}</span>
              <span className="wt-detail__commit-time">{c.relativeTime}</span>
              <Tooltip text="Reset to this commit">
                <button
                  className="wt-detail__reset-btn"
                  onClick={() => setResetTarget(c)}
                >
                  <RotateCcw size={11} />
                </button>
              </Tooltip>
            </div>
          ))}
        </div>
      )}

      {details.changedFiles.length === 0 && details.recentCommits.length === 0 && (
        <div className="wt-detail__empty">Clean working tree</div>
      )}

      {/* Reset confirmation modal */}
      {resetTarget && (
        <div className="modal-overlay" onMouseDown={() => setResetTarget(null)}>
          <div className="modal-card" style={{ width: 360 }} onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-body">
              Reset worktree <strong>{worktreeBranch}</strong> to commit{" "}
              <code className="wt-detail__commit-hash">{resetTarget.hash}</code>?
              <br />
              <span style={{ color: "var(--fg-muted)", fontSize: "0.8rem" }}>
                All changes after this commit will be lost.
              </span>
            </div>
            <div className="modal-footer" style={{ justifyContent: "center" }}>
              <button className="modal-btn" onClick={() => setResetTarget(null)}>Cancel</button>
              <button
                className="modal-btn modal-btn--accent"
                onClick={handleConfirmReset}
                disabled={resetting}
              >
                {resetting ? "Resetting..." : "Reset"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

/* ── Main card ── */

export const BranchesCard = memo(function BranchesCard({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  const projectPath = useChatStore((s) => s.projectPath);
  const { agents, activeAgentId } = useAgentStore(useShallow((s) => ({
    agents: s.agents,
    activeAgentId: s.activeAgentId,
  })));

  const activeAgent = agents.find((a) => a.id === activeAgentId);
  const parentAgent = activeAgent?.parentAgentId
    ? agents.find((a) => a.id === activeAgent.parentAgentId)
    : activeAgent;
  const rootProjectPath = parentAgent?.projectPath ?? projectPath;

  const [worktrees, setWorktrees] = useState<WorktreeEntry[]>([]);
  const [expandedWt, setExpandedWt] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newBranch, setNewBranch] = useState("");
  const newBranchRef = useRef("");
  const inputRef = useRef<HTMLInputElement>(null);
  const [removeTarget, setRemoveTarget] = useState<WorktreeEntry | null>(null);

  const loadWorktrees = useCallback(() => {
    if (!rootProjectPath) return;
    invoke<WorktreeEntry[]>("get_worktrees", { projectPath: rootProjectPath })
      .then(setWorktrees)
      .catch(console.error);
  }, [rootProjectPath]);

  useEffect(() => { loadWorktrees(); }, [loadWorktrees]);

  const nonBare = worktrees.filter((w) => !w.isBare);
  const extraCount = nonBare.length > 1 ? nonBare.length - 1 : 0;

  const handleToggleDetails = useCallback((path: string) => {
    setExpandedWt((prev) => (prev === path ? null : path));
  }, []);

  const handleSwitch = useCallback((wt: WorktreeEntry) => {
    if (!activeAgentId || !parentAgent) return;
    if (wt.path === parentAgent.projectPath) {
      useAgentStore.getState().setActiveAgent(parentAgent.id).catch(console.error);
      return;
    }
    useAgentStore.getState()
      .createWorktreeAgent(parentAgent.id, wt.path, wt.branch || wt.path.split("/").pop() || "worktree")
      .catch(console.error);
  }, [activeAgentId, parentAgent]);

  const handleRemoveConfirm = useCallback(async () => {
    const wt = removeTarget;
    if (!wt || !rootProjectPath || !parentAgent) return;
    setRemoveTarget(null);
    const childAgent = agents.find(
      (a) => a.parentAgentId === parentAgent.id && a.projectPath === wt.path,
    );
    if (childAgent) {
      await useAgentStore.getState().removeAgent(childAgent.id);
    }
    try {
      await invoke("remove_worktree", { projectPath: rootProjectPath, worktreePath: wt.path });
      loadWorktrees();
    } catch (e) {
      console.error("Failed to remove worktree:", e);
    }
  }, [removeTarget, rootProjectPath, parentAgent, agents, loadWorktrees]);

  const handleCreateStart = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setCreating(true);
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  const handleCreateSubmit = useCallback(async () => {
    const branch = newBranchRef.current.trim();
    if (!branch || !rootProjectPath || !parentAgent) {
      setCreating(false);
      setNewBranch("");
      newBranchRef.current = "";
      return;
    }
    try {
      const result = await invoke<{ path: string; branch: string }>("create_worktree", {
        options: { projectPath: rootProjectPath, branchName: branch, createBranch: true },
      });
      loadWorktrees();
      await useAgentStore.getState().createWorktreeAgent(parentAgent.id, result.path, result.branch);
    } catch (e) {
      console.error("Failed to create worktree:", e);
    }
    setCreating(false);
    setNewBranch("");
    newBranchRef.current = "";
  }, [rootProjectPath, parentAgent, loadWorktrees]);

  const handleCreateKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.code === "Enter") handleCreateSubmit();
    if (e.code === "Escape") { setCreating(false); setNewBranch(""); }
  }, [handleCreateSubmit]);

  if (!projectPath) return null;

  const addButton = (
    <Tooltip text="Add worktree">
      <button className="dash-card__action" onClick={handleCreateStart}>
        <Plus size={14} />
      </button>
    </Tooltip>
  );

  return (
    <DashboardCard
      id="branches"
      icon={GitBranch}
      title="Branches"
      statusText={String(nonBare.length)}
      statusColor={extraCount > 0 ? "orange" : "green"}
      expanded={expanded}
      onToggle={onToggle}
      headerExtra={addButton}
    >
      <div className="dash-card__details">
        {nonBare.map((wt) => (
          <div key={wt.path} className="branches-card__entry">
            <div className="branches-card__row">
              <Tooltip text="Show commits">
                <button
                  className={`branches-card__expand ${expandedWt === wt.path ? "branches-card__expand--open" : ""}`}
                  onClick={(e) => { e.stopPropagation(); handleToggleDetails(wt.path); }}
                >
                  <FolderGit2 size={13} />
                </button>
              </Tooltip>
              <button
                className={`branches-card__item ${wt.path === projectPath ? "branches-card__item--active" : ""}`}
                onClick={() => handleSwitch(wt)}
              >
                <span className="branches-card__branch">{wt.branch || "(detached)"}</span>
                <span className="branches-card__path">{wt.path.split("/").pop()}</span>
              </button>
              {wt.path !== rootProjectPath && (
                <Tooltip text="Remove worktree">
                  <button className="branches-card__remove" onClick={() => setRemoveTarget(wt)}>
                    <Trash2 size={12} />
                  </button>
                </Tooltip>
              )}
            </div>
            {expandedWt === wt.path && (
              <WorktreeItemDetails
                worktreePath={wt.path}
                worktreeBranch={wt.branch}
                onReset={loadWorktrees}
              />
            )}
          </div>
        ))}

        {creating && (
          <div className="branches-card__create">
            <GitBranch size={13} />
            <input
              ref={inputRef}
              className="branches-card__input"
              value={newBranch}
              onChange={(e) => { setNewBranch(e.target.value); newBranchRef.current = e.target.value; }}
              onKeyDown={handleCreateKeyDown}
              onBlur={() => { setTimeout(() => { setCreating(false); setNewBranch(""); newBranchRef.current = ""; }, 150); }}
              placeholder="branch name"
            />
          </div>
        )}
      </div>

      <Modal
        open={!!removeTarget}
        title="Remove worktree"
        onClose={() => setRemoveTarget(null)}
        actions={[
          { label: "Cancel", onClick: () => setRemoveTarget(null) },
          { label: "Remove", variant: "danger", onClick: handleRemoveConfirm },
        ]}
      >
        Remove worktree <strong>&quot;{removeTarget?.branch || removeTarget?.path.split("/").pop()}&quot;</strong>?
        <br />
        <span style={{ color: "var(--fg-muted)", fontSize: "0.8rem" }}>
          This will delete the worktree directory and its local changes.
        </span>
      </Modal>
    </DashboardCard>
  );
});
