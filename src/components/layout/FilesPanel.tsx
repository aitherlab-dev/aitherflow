import { memo, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Folder,
  FolderOpen,
  File,
  ChevronRight,
  Home,
  FolderTree,
  HardDrive,
  Copy,
  ClipboardPaste,
  FolderPlus,
  FilePlus,
  Clipboard,
  Trash2,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAgentStore } from "../../stores/agentStore";
import { useFileViewerStore } from "../../stores/fileViewerStore";
import { useAttachmentStore } from "../../stores/attachmentStore";
import type { FileEntry, MountEntry } from "../../types/files";

type FilesMode = "tree" | "browser";

// ── Context menu state ──

interface ContextMenuState {
  x: number;
  y: number;
  /** The entry that was right-clicked (null = background click) */
  entry: FileEntry | null;
  /** The parent directory path for operations */
  dirPath: string;
}

// ── Inline name input (for new file / new folder) ──

const InlineNameInput = memo(function InlineNameInput({
  placeholder,
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const submittedRef = useRef(false);

  useEffect(() => {
    // Delay focus to avoid race with menu closing
    const id = requestAnimationFrame(() => ref.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.code === "Enter" && value.trim()) {
        submittedRef.current = true;
        onSubmit(value.trim());
      } else if (e.code === "Escape") {
        onCancel();
      }
    },
    [value, onSubmit, onCancel],
  );

  const handleBlur = useCallback(() => {
    // Small delay so Enter/click handlers fire before blur cancels
    setTimeout(() => {
      if (!submittedRef.current) onCancel();
    }, 100);
  }, [onCancel]);

  return (
    <div className="files-entry files-inline-input">
      <input
        ref={ref}
        className="files-inline-input__field"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        placeholder={placeholder}
        spellCheck={false}
      />
    </div>
  );
});

// ── Context menu component (rendered via portal) ──

const FileContextMenu = memo(function FileContextMenu({
  menu,
  copiedPath,
  onCopyPath,
  onCopy,
  onDelete,
  onPaste,
  onNewFolder,
  onNewFile,
  onClose,
}: {
  menu: ContextMenuState;
  copiedPath: string | null;
  onCopyPath: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onPaste: () => void;
  onNewFolder: () => void;
  onNewFile: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.code === "Escape") onClose();
    };
    // Use capture so this fires before onClick handlers on buttons
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  // Adjust position so menu doesn't overflow viewport
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });
  useEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let { x, y } = menu;
    if (x + rect.width > vw) x = vw - rect.width - 4;
    if (y + rect.height > vh) y = vh - rect.height - 4;
    setPos({ x, y });
  }, [menu]);

  return createPortal(
    <div
      ref={ref}
      className="files-context-menu"
      style={{ left: pos.x, top: pos.y }}
    >
      {menu.entry && (
        <>
          <button type="button" className="files-context-menu__item" onClick={onCopyPath}>
            <Clipboard size={14} />
            <span>Copy Path</span>
          </button>
          <button type="button" className="files-context-menu__item" onClick={onCopy}>
            <Copy size={14} />
            <span>Copy</span>
          </button>
          <button
            type="button"
            className="files-context-menu__item files-context-menu__item--danger"
            onClick={onDelete}
          >
            <Trash2 size={14} />
            <span>Delete</span>
          </button>
        </>
      )}
      <button
        type="button"
        className="files-context-menu__item"
        onClick={onPaste}
        disabled={!copiedPath}
      >
        <ClipboardPaste size={14} />
        <span>Paste</span>
      </button>
      <div className="files-context-menu__sep" />
      <button type="button" className="files-context-menu__item" onClick={onNewFolder}>
        <FolderPlus size={14} />
        <span>New Folder</span>
      </button>
      <button type="button" className="files-context-menu__item" onClick={onNewFile}>
        <FilePlus size={14} />
        <span>New File</span>
      </button>
    </div>,
    document.body,
  );
});

// ── Tree entry (recursive, one row) ──

const TreeEntry = memo(function TreeEntry({
  entry,
  depth,
  expanded,
  onToggle,
  onFileClick,
  onFileDblClick,
  onContextMenu,
  children,
}: {
  entry: FileEntry;
  depth: number;
  expanded: boolean;
  onToggle: (path: string) => void;
  onFileClick: (path: string) => void;
  onFileDblClick: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void;
  children?: React.ReactNode;
}) {
  const [flash, setFlash] = useState(false);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleClick = useCallback(() => {
    if (entry.isDir) {
      onToggle(entry.path);
      return;
    }
    // Single click with delay to detect double click
    if (clickTimer.current) {
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
      onFileDblClick(entry.path);
    } else {
      clickTimer.current = setTimeout(() => {
        clickTimer.current = null;
        onFileClick(entry.path);
        setFlash(true);
        setTimeout(() => setFlash(false), 400);
      }, 250);
    }
  }, [entry.isDir, entry.path, onToggle, onFileClick, onFileDblClick]);

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData("text/plain", entry.path);
    e.dataTransfer.effectAllowed = "copy";
    useAttachmentStore.getState().setDragPath(entry.path);
  }, [entry.path]);

  const handleDragEnd = useCallback(() => {
    useAttachmentStore.getState().setDragPath(null);
  }, []);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => onContextMenu(e, entry),
    [onContextMenu, entry],
  );

  return (
    <>
      <div
        className={`files-entry ${entry.isDir ? "files-entry--dir" : "files-entry--file"} ${flash ? "files-entry--flash" : ""}`}
        style={{ paddingLeft: depth * 16 + 8 }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        draggable={!entry.isDir}
        onDragStart={!entry.isDir ? handleDragStart : undefined}
        onDragEnd={!entry.isDir ? handleDragEnd : undefined}
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
  onFileClick,
  onFileDblClick,
  onContextMenu,
}: {
  entry: FileEntry;
  onNavigate: (path: string) => void;
  onFileClick: (path: string) => void;
  onFileDblClick: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void;
}) {
  const [flash, setFlash] = useState(false);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleClick = useCallback(() => {
    if (entry.isDir) {
      onNavigate(entry.path);
      return;
    }
    if (clickTimer.current) {
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
      onFileDblClick(entry.path);
    } else {
      clickTimer.current = setTimeout(() => {
        clickTimer.current = null;
        onFileClick(entry.path);
        setFlash(true);
        setTimeout(() => setFlash(false), 400);
      }, 250);
    }
  }, [entry.isDir, entry.path, onNavigate, onFileClick, onFileDblClick]);

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData("text/plain", entry.path);
    e.dataTransfer.effectAllowed = "copy";
    useAttachmentStore.getState().setDragPath(entry.path);
  }, [entry.path]);

  const handleDragEnd = useCallback(() => {
    useAttachmentStore.getState().setDragPath(null);
  }, []);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => onContextMenu(e, entry),
    [onContextMenu, entry],
  );

  return (
    <div
      className={`files-entry ${entry.isDir ? "files-entry--dir" : "files-entry--file"} ${flash ? "files-entry--flash" : ""}`}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      draggable={!entry.isDir}
      onDragStart={!entry.isDir ? handleDragStart : undefined}
      onDragEnd={!entry.isDir ? handleDragEnd : undefined}
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
  onFileClick,
  onFileDblClick,
  onContextMenu,
  inlineInput,
  onInlineSubmit,
  onInlineCancel,
}: {
  parentPath: string;
  depth: number;
  expandedSet: Set<string>;
  childrenCache: Map<string, FileEntry[]>;
  onToggle: (path: string) => void;
  onFileClick: (path: string) => void;
  onFileDblClick: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void;
  inlineInput: { type: "folder" | "file"; dirPath: string } | null;
  onInlineSubmit: (name: string) => void;
  onInlineCancel: () => void;
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
          onFileClick={onFileClick}
          onFileDblClick={onFileDblClick}
          onContextMenu={onContextMenu}
        >
          {entry.isDir && expandedSet.has(entry.path) && (
            <TreeLevel
              parentPath={entry.path}
              depth={depth + 1}
              expandedSet={expandedSet}
              childrenCache={childrenCache}
              onToggle={onToggle}
              onFileClick={onFileClick}
              onFileDblClick={onFileDblClick}
              onContextMenu={onContextMenu}
              inlineInput={inlineInput}
              onInlineSubmit={onInlineSubmit}
              onInlineCancel={onInlineCancel}
            />
          )}
        </TreeEntry>
      ))}
      {inlineInput && inlineInput.dirPath === parentPath && (
        <InlineNameInput
          placeholder={inlineInput.type === "folder" ? "Folder name" : "File name"}
          onSubmit={onInlineSubmit}
          onCancel={onInlineCancel}
        />
      )}
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

  // Context menu state
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const [inlineInput, setInlineInput] = useState<{
    type: "folder" | "file";
    dirPath: string;
  } | null>(null);

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
      // Refresh tree cache if this directory is expanded
      invoke<FileEntry[]>("list_directory", { path: changedDir })
        .then((entries) => {
          if (!entries) return;
          // Update tree cache
          setChildrenCache((prev) => {
            if (!prev.has(changedDir)) return prev;
            const next = new Map(prev);
            next.set(changedDir, entries);
            return next;
          });
          // Update browser entries if viewing this directory
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
      <div className="files-panel-content" onContextMenu={handleBgContextMenu}>
        {mode === "tree" ? (
          <TreeLevel
            parentPath={projectPath}
            depth={0}
            expandedSet={expandedSet}
            childrenCache={childrenCache}
            onToggle={handleToggle}
            onFileClick={handleFileClick}
            onFileDblClick={handleFileDblClick}
            onContextMenu={handleEntryContextMenu}
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
                    onNavigate={handleNavigate}
                    onFileClick={handleFileClick}
                    onFileDblClick={handleFileDblClick}
                    onContextMenu={handleEntryContextMenu}
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
