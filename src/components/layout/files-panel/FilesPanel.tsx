import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  Folder,
  Home,
  FolderTree,
  HardDrive,
} from "lucide-react";
import { invoke, listen } from "../../../lib/transport";
import { useAgentStore } from "../../../stores/agentStore";
import { useFileViewerStore } from "../../../stores/fileViewerStore";
import { Tooltip } from "../../shared/Tooltip";
import type { FileEntry, MountEntry } from "../../../types/files";
import type { FilesMode, ContextMenuState } from "./types";
import { InlineNameInput } from "./InlineNameInput";
import { FileContextMenu } from "./FileContextMenu";
import { TreeLevel } from "./TreeEntry";
import { BrowserEntry } from "./BrowserEntry";

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

  // Context menu state
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const [inlineInput, setInlineInput] = useState<{
    type: "folder" | "file";
    dirPath: string;
  } | null>(null);
  const [renamingEntry, setRenamingEntry] = useState<{ path: string; dirPath: string } | null>(null);

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
    }).catch((e) => { console.error(e); setLoading(false); });
  }, [mode, browserPath]);

  // Start file watcher for project directory
  useEffect(() => {
    if (!projectPath) return;
    invoke("watch_directories", { paths: [projectPath] }).catch(console.error);
    return () => {
      invoke("unwatch_directories").catch(console.error);
    };
  }, [projectPath]);

  // Listen for fs-change events and refresh affected directories
  useEffect(() => {
    const unlisten = listen<{ path: string }>("fs-change", (event) => {
      const changedDir = event.payload.path;
      invoke<FileEntry[]>("list_directory", { path: changedDir })
        .then((entries) => {
          if (!entries) return;
          setChildrenCache((prev) => {
            if (!prev.has(changedDir)) return prev;
            const next = new Map(prev);
            next.set(changedDir, entries);
            return next;
          });
          setBrowserPath((current) => {
            if (current === changedDir) {
              setBrowserEntries(entries);
            }
            return current;
          });
        })
        .catch(console.error);
    });
    return () => {
      unlisten.then((fn) => fn()).catch(console.error);
    };
  }, []);

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

  // File click → open in viewer
  const handleFileClick = useCallback((path: string) => {
    useFileViewerStore.getState().openPreview(path).catch(console.error);
  }, []);

  // File double click → pin in viewer
  const handleFileDblClick = useCallback((path: string) => {
    useFileViewerStore.getState().openPinned(path).catch(console.error);
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

  // ── Context menu handlers ──

  const handleEntryContextMenu = useCallback(
    (e: React.MouseEvent, entry: FileEntry) => {
      e.preventDefault();
      e.stopPropagation();
      const dirPath = entry.isDir
        ? entry.path
        : entry.path.replace(/\/[^/]+$/, "");
      setCtxMenu({ x: e.clientX, y: e.clientY, entry, dirPath });
    },
    [],
  );

  const handleBgContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const dirPath =
        mode === "browser" ? browserPath : projectPath;
      if (!dirPath) return;
      setCtxMenu({ x: e.clientX, y: e.clientY, entry: null, dirPath });
    },
    [mode, browserPath, projectPath],
  );

  const closeCtxMenu = useCallback(() => setCtxMenu(null), []);

  const handleCopyPath = useCallback(() => {
    if (!ctxMenu?.entry) return;
    navigator.clipboard.writeText(ctxMenu.entry.path).catch(console.error);
    setCtxMenu(null);
  }, [ctxMenu]);

  const handleCopy = useCallback(() => {
    if (!ctxMenu?.entry) return;
    setCopiedPath(ctxMenu.entry.path);
    setCtxMenu(null);
  }, [ctxMenu]);

  // Refresh the relevant directory listing after mutation
  const refreshDir = useCallback(
    async (dirPath: string) => {
      const entries = await loadDirectory(dirPath);
      if (!entries) return;
      if (mode === "browser" && dirPath === browserPath) {
        setBrowserEntries(entries);
      } else {
        setChildrenCache((prev) => {
          const next = new Map(prev);
          next.set(dirPath, entries);
          return next;
        });
      }
    },
    [mode, browserPath, loadDirectory],
  );

  const handleDelete = useCallback(async () => {
    if (!ctxMenu?.entry) return;
    const entry = ctxMenu.entry;
    const dirPath = ctxMenu.dirPath;
    setCtxMenu(null);
    try {
      await invoke("trash_entry", { path: entry.path });
      await refreshDir(dirPath);
    } catch (e) {
      console.error("Trash failed:", e);
    }
  }, [ctxMenu, refreshDir]);

  const handlePaste = useCallback(async () => {
    if (!copiedPath || !ctxMenu) return;
    const destDir = ctxMenu.dirPath;
    setCtxMenu(null);
    try {
      await invoke("copy_entry", { src: copiedPath, destDir });
      await refreshDir(destDir);
    } catch (e) {
      console.error("Paste failed:", e);
    }
  }, [copiedPath, ctxMenu, refreshDir]);

  const handleNewFolder = useCallback(() => {
    if (!ctxMenu) return;
    const dirPath = ctxMenu.dirPath;
    setCtxMenu(null);
    setInlineInput({ type: "folder", dirPath });
  }, [ctxMenu]);

  const handleNewFile = useCallback(() => {
    if (!ctxMenu) return;
    const dirPath = ctxMenu.dirPath;
    setCtxMenu(null);
    setInlineInput({ type: "file", dirPath });
  }, [ctxMenu]);

  const handleRename = useCallback(() => {
    if (!ctxMenu?.entry) return;
    const entry = ctxMenu.entry;
    const dirPath = ctxMenu.dirPath;
    setCtxMenu(null);
    setRenamingEntry({ path: entry.path, dirPath });
  }, [ctxMenu]);

  const handleRenameSubmit = useCallback(
    async (newName: string) => {
      if (!renamingEntry) return;
      const { path: oldPath, dirPath } = renamingEntry;
      setRenamingEntry(null);
      try {
        await invoke("rename_entry", { oldPath, newName });
        await refreshDir(dirPath);
      } catch (e) {
        console.error("Rename failed:", e);
      }
    },
    [renamingEntry, refreshDir],
  );

  const handleRenameCancel = useCallback(() => setRenamingEntry(null), []);

  const handleInlineSubmit = useCallback(
    async (name: string) => {
      if (!inlineInput) return;
      const { type, dirPath } = inlineInput;
      setInlineInput(null);
      try {
        const cmd = type === "folder" ? "create_directory" : "create_file";
        await invoke(cmd, { path: dirPath, name });
        await refreshDir(dirPath);
      } catch (e) {
        console.error(`Failed to create ${type}:`, e);
      }
    },
    [inlineInput, refreshDir],
  );

  const handleInlineCancel = useCallback(() => setInlineInput(null), []);

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
          <Tooltip text="Browse from home">
            <button
              className="files-panel-header__mode"
              onClick={handleGoHome}
            >
              <Home size={14} />
            </button>
          </Tooltip>
        ) : (
          <Tooltip text="Back to project tree">
            <button
              className="files-panel-header__mode"
              onClick={handleGoTree}
            >
              <FolderTree size={14} />
            </button>
          </Tooltip>
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
      <div className="files-panel-content" onContextMenu={handleBgContextMenu}>
        {mode === "tree" ? (
          <TreeLevel
            parentPath={projectPath}
            depth={0}
            expandedSet={expandedSet}
            childrenCache={childrenCache}
            renamingPath={renamingEntry?.path ?? null}
            onToggle={handleToggle}
            onFileClick={handleFileClick}
            onFileDblClick={handleFileDblClick}
            onContextMenu={handleEntryContextMenu}
            onRenameSubmit={handleRenameSubmit}
            onRenameCancel={handleRenameCancel}
            inlineInput={inlineInput}
            onInlineSubmit={handleInlineSubmit}
            onInlineCancel={handleInlineCancel}
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
                    renamingPath={renamingEntry?.path ?? null}
                    onNavigate={handleNavigate}
                    onFileClick={handleFileClick}
                    onFileDblClick={handleFileDblClick}
                    onContextMenu={handleEntryContextMenu}
                    onRenameSubmit={handleRenameSubmit}
                    onRenameCancel={handleRenameCancel}
                  />
                ))
            )}
            {inlineInput && (
              <InlineNameInput
                placeholder={
                  inlineInput.type === "folder" ? "Folder name" : "File name"
                }
                onSubmit={handleInlineSubmit}
                onCancel={handleInlineCancel}
              />
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

      {/* Context menu */}
      {ctxMenu && (
        <FileContextMenu
          menu={ctxMenu}
          copiedPath={copiedPath}
          onCopyPath={handleCopyPath}
          onCopy={handleCopy}
          onRename={handleRename}
          onDelete={handleDelete}
          onPaste={handlePaste}
          onNewFolder={handleNewFolder}
          onNewFile={handleNewFile}
          onClose={closeCtxMenu}
        />
      )}
    </div>
  );
});
