import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  Folder,
  FolderOpen,
  File,
  ChevronRight,
  Home,
  FolderTree,
  HardDrive,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useAgentStore } from "../../stores/agentStore";
import { useAttachmentStore } from "../../stores/attachmentStore";
import type { FileEntry, MountEntry } from "../../types/files";

type FilesMode = "tree" | "browser";

// ── Tree entry (recursive, one row) ──

const TreeEntry = memo(function TreeEntry({
  entry,
  depth,
  expanded,
  onToggle,
  onAttach,
  children,
}: {
  entry: FileEntry;
  depth: number;
  expanded: boolean;
  onToggle: (path: string) => void;
  onAttach: (path: string) => void;
  children?: React.ReactNode;
}) {
  const [flash, setFlash] = useState(false);

  const handleClick = useCallback(() => {
    if (entry.isDir) {
      onToggle(entry.path);
    } else {
      onAttach(entry.path);
      setFlash(true);
      setTimeout(() => setFlash(false), 400);
    }
  }, [entry.isDir, entry.path, onToggle, onAttach]);

  return (
    <>
      <div
        className={`files-entry ${entry.isDir ? "files-entry--dir" : "files-entry--file"} ${flash ? "files-entry--flash" : ""}`}
        style={{ paddingLeft: depth * 16 + 8 }}
        onClick={handleClick}
      >
        {entry.isDir ? (
          <>
            <ChevronRight
              size={12}
              className={`files-entry__chevron ${expanded ? "files-entry__chevron--open" : ""}`}
            />
            {expanded ? (
              <FolderOpen size={16} className="files-entry__icon files-entry__icon--dir" />
            ) : (
              <Folder size={16} className="files-entry__icon files-entry__icon--dir" />
            )}
          </>
        ) : (
          <File size={16} className="files-entry__icon files-entry__icon--file" />
        )}
        <span className="files-entry__name">{entry.name}</span>
      </div>
      {expanded && children}
    </>
  );
});

// ── Browser entry (flat, one row) ──

const BrowserEntry = memo(function BrowserEntry({
  entry,
  onNavigate,
  onAttach,
}: {
  entry: FileEntry;
  onNavigate: (path: string) => void;
  onAttach: (path: string) => void;
}) {
  const [flash, setFlash] = useState(false);

  const handleClick = useCallback(() => {
    if (entry.isDir) {
      onNavigate(entry.path);
    } else {
      onAttach(entry.path);
      setFlash(true);
      setTimeout(() => setFlash(false), 400);
    }
  }, [entry.isDir, entry.path, onNavigate, onAttach]);

  return (
    <div
      className={`files-entry ${entry.isDir ? "files-entry--dir" : "files-entry--file"} ${flash ? "files-entry--flash" : ""}`}
      onClick={handleClick}
    >
      {entry.isDir ? (
        <Folder size={16} className="files-entry__icon files-entry__icon--dir" />
      ) : (
        <File size={16} className="files-entry__icon files-entry__icon--file" />
      )}
      <span className="files-entry__name">{entry.name}</span>
    </div>
  );
});

// ── Recursive tree renderer ──

function TreeLevel({
  parentPath,
  depth,
  expandedSet,
  childrenCache,
  onToggle,
  onAttach,
}: {
  parentPath: string;
  depth: number;
  expandedSet: Set<string>;
  childrenCache: Map<string, FileEntry[]>;
  onToggle: (path: string) => void;
  onAttach: (path: string) => void;
}) {
  const entries = childrenCache.get(parentPath);
  if (!entries) return null;

  return (
    <>
      {entries.map((entry) => (
        <TreeEntry
          key={entry.path}
          entry={entry}
          depth={depth}
          expanded={expandedSet.has(entry.path)}
          onToggle={onToggle}
          onAttach={onAttach}
        >
          {entry.isDir && expandedSet.has(entry.path) && (
            <TreeLevel
              parentPath={entry.path}
              depth={depth + 1}
              expandedSet={expandedSet}
              childrenCache={childrenCache}
              onToggle={onToggle}
              onAttach={onAttach}
            />
          )}
        </TreeEntry>
      ))}
    </>
  );
}

// ── Main FilesPanel ──

export const FilesPanel = memo(function FilesPanel() {
  const getActiveAgent = useAgentStore((s) => s.getActiveAgent);
  const activeAgentId = useAgentStore((s) => s.activeAgentId);
  const agent = getActiveAgent();
  const projectPath = agent?.projectPath ?? "";
  const projectName = agent?.projectName ?? "Project";

  const [mode, setMode] = useState<FilesMode>("tree");
  const [homePath, setHomePath] = useState("");

  // Tree state
  const [expandedSet, setExpandedSet] = useState<Set<string>>(new Set());
  const [childrenCache, setChildrenCache] = useState<Map<string, FileEntry[]>>(new Map());

  // Browser state
  const [browserPath, setBrowserPath] = useState("");
  const [browserEntries, setBrowserEntries] = useState<FileEntry[]>([]);

  // Loading state
  const [loading, setLoading] = useState(false);

  // Mounted drives
  const [mounts, setMounts] = useState<MountEntry[]>([]);

  // Get $HOME and mounts on mount
  useEffect(() => {
    invoke<string>("get_home_path").then(setHomePath).catch(console.error);
    invoke<MountEntry[]>("list_mounts").then(setMounts).catch(console.error);
  }, []);

  // Track project changes to reset tree state
  const prevProjectRef = useRef(projectPath);
  useEffect(() => {
    if (prevProjectRef.current !== projectPath) {
      prevProjectRef.current = projectPath;
      setExpandedSet(new Set());
      setChildrenCache(new Map());
      // If in tree mode, stay; if in browser, keep browsing
    }
  }, [projectPath]);

  // Load root level on mount (tree mode)
  useEffect(() => {
    if (!projectPath) return;
    loadDirectory(projectPath).then((entries) => {
      if (entries) {
        setChildrenCache(new Map([[projectPath, entries]]));
      }
    }).catch(console.error);
  }, [projectPath, activeAgentId]);

  // Load browser entries when path changes
  useEffect(() => {
    if (mode !== "browser" || !browserPath) return;
    setLoading(true);
    loadDirectory(browserPath).then((entries) => {
      if (entries) setBrowserEntries(entries);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [mode, browserPath]);

  const loadDirectory = useCallback(async (path: string): Promise<FileEntry[] | null> => {
    try {
      return await invoke<FileEntry[]>("list_directory", { path });
    } catch (e) {
      console.error("Failed to list directory:", e);
      return null;
    }
  }, []);

  // Tree: toggle folder expand/collapse
  const handleToggle = useCallback(async (path: string) => {
    setExpandedSet((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });

    // Load children if not cached
    if (!childrenCache.has(path)) {
      const entries = await loadDirectory(path);
      if (entries) {
        setChildrenCache((prev) => {
          const next = new Map(prev);
          next.set(path, entries);
          return next;
        });
      }
    }
  }, [childrenCache, loadDirectory]);

  // Attach file
  const handleAttach = useCallback((path: string) => {
    useAttachmentStore.getState().queueAttachment(path);
  }, []);

  // Browser: navigate to folder
  const handleNavigate = useCallback((path: string) => {
    setBrowserPath(path);
  }, []);

  // Browser: go up one level (limited to $HOME)
  const handleGoUp = useCallback(() => {
    const parent = browserPath.replace(/\/[^/]+\/?$/, "");
    if (parent && homePath && parent.length >= homePath.length) {
      setBrowserPath(parent);
    }
  }, [browserPath, homePath]);

  // Switch to browser mode at $HOME
  const handleGoHome = useCallback(() => {
    if (!homePath) return;
    setMode("browser");
    setBrowserPath(homePath);
  }, [homePath]);

  // Switch back to tree mode
  const handleGoTree = useCallback(() => {
    setMode("tree");
  }, []);

  // Breadcrumbs for browser mode (relative to $HOME, starting with ~)
  const breadcrumbs = (() => {
    if (!browserPath || !homePath) return [];
    const relative = browserPath.startsWith(homePath)
      ? browserPath.slice(homePath.length)
      : browserPath;
    const parts = relative.split("/").filter(Boolean);
    const crumbs: { label: string; path: string }[] = [
      { label: "~", path: homePath },
    ];
    let currentPath = homePath;
    for (const part of parts) {
      currentPath += "/" + part;
      crumbs.push({ label: part, path: currentPath });
    }
    return crumbs;
  })();

  if (!projectPath) {
    return <div className="files-panel files-panel--empty">No project selected</div>;
  }

  return (
    <div className="files-panel">
      {/* Header */}
      <div className="files-panel-header">
        <span className="files-panel-header__title">
          {mode === "tree" ? projectName : "File Manager"}
        </span>
        {mode === "tree" ? (
          <button
            className="files-panel-header__mode"
            onClick={handleGoHome}
            title="Browse from home"
          >
            <Home size={14} />
          </button>
        ) : (
          <button
            className="files-panel-header__mode"
            onClick={handleGoTree}
            title="Back to project tree"
          >
            <FolderTree size={14} />
          </button>
        )}
      </div>

      {/* Browser breadcrumbs */}
      {mode === "browser" && (
        <div className="files-breadcrumbs">
          {breadcrumbs.map((crumb, i) => (
            <span key={crumb.path} className="files-breadcrumb">
              {i > 0 && <span className="files-breadcrumb__sep">/</span>}
              <button
                className="files-breadcrumb__btn"
                onClick={() => setBrowserPath(crumb.path)}
              >
                {crumb.label}
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Content */}
      <div className="files-panel-content">
        {mode === "tree" ? (
          <TreeLevel
            parentPath={projectPath}
            depth={0}
            expandedSet={expandedSet}
            childrenCache={childrenCache}
            onToggle={handleToggle}
            onAttach={handleAttach}
          />
        ) : (
          <>
            {/* ".." go up (until $HOME) */}
            {browserPath !== homePath && (
              <div
                className="files-entry files-entry--dir"
                onClick={handleGoUp}
              >
                <Folder size={16} className="files-entry__icon files-entry__icon--dir" />
                <span className="files-entry__name">..</span>
              </div>
            )}
            {loading ? (
              <div className="files-panel--loading">Loading...</div>
            ) : (
              browserEntries
                .filter((e) => !e.name.startsWith("."))
                .map((entry) => (
                  <BrowserEntry
                    key={entry.path}
                    entry={entry}
                    onNavigate={handleNavigate}
                    onAttach={handleAttach}
                  />
                ))
            )}
            {/* Drives section — shown at $HOME, below home folders */}
            {browserPath === homePath && mounts.length > 0 && (
              <div className="files-drives">
                <div className="files-drives__label">Drives</div>
                {mounts.map((m) => (
                  <div
                    key={m.path}
                    className="files-entry files-entry--dir"
                    onClick={() => handleNavigate(m.path)}
                  >
                    <HardDrive size={16} className="files-entry__icon files-entry__icon--drive" />
                    <span className="files-entry__name">{m.name}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
});
