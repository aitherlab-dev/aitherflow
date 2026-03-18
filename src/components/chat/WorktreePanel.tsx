import { memo, useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ChevronRight, GitBranch, GitCommit, FolderGit2,
  Trash2, FileEdit, FilePlus, FileX, FileQuestion,
} from "lucide-react";
import { useChatStore } from "../../stores/chatStore";
import { useAgentStore } from "../../stores/agentStore";
import { useShallow } from "zustand/react/shallow";
import { Tooltip } from "../shared/Tooltip";

interface WorktreeEntry {
  path: string;
  branch: string;
  isBare: boolean;
}

interface GitStatus {
  branch: string;
  changedFiles: number;
  untrackedFiles: number;
  stagedFiles: number;
  lastCommit: string;
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

interface CreateWorktreeResult {
  path: string;
  branch: string;
}

/** Icon for file status code */
function FileStatusIcon({ status }: { status: string }) {
  const code = status.trim();
  if (code === "??") return <FileQuestion size={12} className="wt-detail__file-icon wt-detail__file-icon--untracked" />;
  if (code.includes("D")) return <FileX size={12} className="wt-detail__file-icon wt-detail__file-icon--deleted" />;
  if (code.includes("A")) return <FilePlus size={12} className="wt-detail__file-icon wt-detail__file-icon--added" />;
  return <FileEdit size={12} className="wt-detail__file-icon wt-detail__file-icon--modified" />;
}

/** Accordion details for a single worktree */
const WorktreeItemDetails = memo(function WorktreeItemDetails({ worktreePath }: { worktreePath: string }) {
  const [details, setDetails] = useState<WorktreeDetails | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    invoke<WorktreeDetails>("get_worktree_details", { worktreePath, commitCount: 5 })
      .then(setDetails)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [worktreePath]);

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
          <div className="wt-detail__section-title">Recent commits</div>
          {details.recentCommits.map((c) => (
            <div key={c.hash} className="wt-detail__commit">
              <GitCommit size={11} className="wt-detail__commit-icon" />
              <span className="wt-detail__commit-hash">{c.hash}</span>
              <span className="wt-detail__commit-msg">{c.message}</span>
              <span className="wt-detail__commit-time">{c.relativeTime}</span>
            </div>
          ))}
        </div>
      )}

      {details.changedFiles.length === 0 && details.recentCommits.length === 0 && (
        <div className="wt-detail__empty">Clean working tree</div>
      )}
    </div>
  );
});

export const WorktreePanel = memo(function WorktreePanel({
  embedded = false,
  autoCreate = false,
  onAutoCreateConsumed,
}: {
  embedded?: boolean;
  autoCreate?: boolean;
  onAutoCreateConsumed?: () => void;
}) {
  const projectPath = useChatStore((s) => s.projectPath);
  const { agents, activeAgentId } = useAgentStore(useShallow((s) => ({
    agents: s.agents,
    activeAgentId: s.activeAgentId,
  })));

  const [expanded, setExpanded] = useState(false);
  const [worktrees, setWorktrees] = useState<WorktreeEntry[]>([]);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [worktreeStatuses, setWorktreeStatuses] = useState<Map<string, GitStatus>>(new Map());
  const [creating, setCreating] = useState(false);
  const [newBranch, setNewBranch] = useState("");
  const [expandedWt, setExpandedWt] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Find the current active agent and its parent (to determine the root project path)
  const activeAgent = agents.find((a) => a.id === activeAgentId);
  const parentAgent = activeAgent?.parentAgentId
    ? agents.find((a) => a.id === activeAgent.parentAgentId)
    : activeAgent;
  // Root project path = parent's path (for git worktree commands)
  const rootProjectPath = parentAgent?.projectPath ?? projectPath;

  // Load worktrees and status when projectPath changes
  useEffect(() => {
    if (!projectPath) return;

    invoke<GitStatus>("get_git_status", { projectPath })
      .then(setStatus)
      .catch(console.error);

    invoke<WorktreeEntry[]>("get_worktrees", { projectPath: rootProjectPath })
      .then(setWorktrees)
      .catch(console.error);
  }, [projectPath, rootProjectPath]);

  // Fetch git status for each worktree to show changed file counts
  useEffect(() => {
    const nonBare = worktrees.filter((w) => !w.isBare);
    if (nonBare.length === 0) return;

    Promise.all(
      nonBare.map((wt) =>
        invoke<GitStatus>("get_git_status", { projectPath: wt.path })
          .then((s) => [wt.path, s] as const)
          .catch((e) => { console.error("[WorktreePanel] git status error:", e); return null; }),
      ),
    ).then((results) => {
      const map = new Map<string, GitStatus>();
      for (const r of results) {
        if (r) map.set(r[0], r[1]);
      }
      setWorktreeStatuses(map);
    });
  }, [worktrees]);

  // Auto-trigger create mode when requested from parent
  useEffect(() => {
    if (autoCreate) {
      setCreating(true);
      setTimeout(() => inputRef.current?.focus(), 50);
      onAutoCreateConsumed?.();
    }
  }, [autoCreate, onAutoCreateConsumed]);

  const toggle = useCallback(() => setExpanded((v) => !v), []);

  const handleSwitch = useCallback((wt: WorktreeEntry) => {
    if (!activeAgentId || !parentAgent) return;
    const parentId = parentAgent.id;

    // If clicking the root worktree (same path as parent), switch to parent
    if (wt.path === parentAgent.projectPath) {
      useAgentStore.getState().setActiveAgent(parentId).catch(console.error);
      return;
    }

    // Otherwise, create or switch to a worktree child agent
    useAgentStore.getState()
      .createWorktreeAgent(parentId, wt.path, wt.branch || wt.path.split("/").pop() || "worktree")
      .catch(console.error);
  }, [activeAgentId, parentAgent]);

  const handleToggleDetails = useCallback((path: string) => {
    setExpandedWt((prev) => (prev === path ? null : path));
  }, []);

  const handleCreateSubmit = useCallback(async () => {
    const branch = newBranch.trim();
    if (!branch || !rootProjectPath || !parentAgent) {
      setCreating(false);
      setNewBranch("");
      return;
    }

    try {
      const result = await invoke<CreateWorktreeResult>("create_worktree", {
        options: { projectPath: rootProjectPath, branchName: branch, createBranch: true },
      });

      // Refresh worktree list
      const updated = await invoke<WorktreeEntry[]>("get_worktrees", { projectPath: rootProjectPath });
      setWorktrees(updated);

      // Create child agent and switch to it
      await useAgentStore.getState().createWorktreeAgent(parentAgent.id, result.path, result.branch);
    } catch (e) {
      console.error("Failed to create worktree:", e);
    }

    setCreating(false);
    setNewBranch("");
  }, [newBranch, rootProjectPath, parentAgent]);

  const handleCreateKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.code === "Enter") handleCreateSubmit();
    if (e.code === "Escape") { setCreating(false); setNewBranch(""); }
  }, [handleCreateSubmit]);

  const handleRemove = useCallback(async (wt: WorktreeEntry) => {
    if (!rootProjectPath || !parentAgent) return;

    // Find and remove the child agent for this worktree
    const childAgent = agents.find(
      (a) => a.parentAgentId === parentAgent.id && a.projectPath === wt.path,
    );
    if (childAgent) {
      await useAgentStore.getState().removeAgent(childAgent.id);
    }

    // Remove the git worktree
    try {
      await invoke("remove_worktree", { projectPath: rootProjectPath, worktreePath: wt.path });
      const updated = await invoke<WorktreeEntry[]>("get_worktrees", { projectPath: rootProjectPath });
      setWorktrees(updated);
    } catch (e) {
      console.error("Failed to remove worktree:", e);
    }
  }, [rootProjectPath, parentAgent, agents]);

  if (!projectPath || !status) return null;

  const totalChanges = status.changedFiles + status.untrackedFiles + status.stagedFiles;

  const listContent = (
    <div className="worktree-panel__list">
      {worktrees.filter((w) => !w.isBare).map((wt) => (
        <div key={wt.path} className="worktree-panel__entry">
          <div className="worktree-panel__item-row">
            <button
              className="worktree-panel__item-expand"
              onClick={() => handleToggleDetails(wt.path)}
            >
              <ChevronRight
                size={11}
                className={`worktree-panel__item-chevron ${expandedWt === wt.path ? "worktree-panel__item-chevron--open" : ""}`}
              />
            </button>
            <button
              className={`worktree-panel__item ${wt.path === projectPath ? "worktree-panel__item--active" : ""}`}
              onClick={() => handleSwitch(wt)}
            >
              <FolderGit2 size={13} />
              <span className="worktree-panel__item-branch">{wt.branch || "(detached)"}</span>
              {(() => {
                const wtStatus = worktreeStatuses.get(wt.path);
                const count = wtStatus ? wtStatus.changedFiles + wtStatus.untrackedFiles + wtStatus.stagedFiles : 0;
                return count > 0 ? <span className="worktree-panel__changes-badge">{count}</span> : null;
              })()}
              <span className="worktree-panel__item-path">{wt.path.split("/").pop()}</span>
            </button>
            {/* Don't allow removing the root worktree */}
            {wt.path !== rootProjectPath && (
              <Tooltip text="Remove worktree">
                <button
                  className="worktree-panel__item-remove"
                  onClick={() => handleRemove(wt)}
                >
                  <Trash2 size={12} />
                </button>
              </Tooltip>
            )}
          </div>
          {expandedWt === wt.path && (
            <WorktreeItemDetails worktreePath={wt.path} />
          )}
        </div>
      ))}

      {creating && (
        <div className="worktree-panel__create-input">
          <GitBranch size={13} />
          <input
            ref={inputRef}
            className="worktree-panel__input"
            value={newBranch}
            onChange={(e) => setNewBranch(e.target.value)}
            onKeyDown={handleCreateKeyDown}
            onBlur={() => { setCreating(false); setNewBranch(""); }}
            placeholder="branch name"
          />
        </div>
      )}
    </div>
  );

  if (embedded) return listContent;

  return (
    <div className="worktree-panel">
      <div className="worktree-panel__pill">
      <button className="worktree-panel__header" onClick={toggle}>
        <GitBranch size={14} className="worktree-panel__icon" />
        <span className="worktree-panel__branch">{status.branch || "unknown"}</span>
        {totalChanges > 0 && (
          <span className="worktree-panel__changes">{totalChanges} changes</span>
        )}
        {status.lastCommit && (
          <span className="worktree-panel__commit">{status.lastCommit}</span>
        )}
        <ChevronRight size={14} className={`worktree-panel__chevron ${expanded ? "worktree-panel__chevron--open" : ""}`} />
      </button>

      {expanded && listContent}
      </div>
    </div>
  );
});
