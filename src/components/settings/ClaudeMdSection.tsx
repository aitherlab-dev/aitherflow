import { useState, useEffect, useCallback, useRef } from "react";
import { Save, ChevronDown, FileText } from "lucide-react";
import { invoke } from "../../lib/transport";

interface ClaudeMdEntry {
  label: string;
  path: string;
  exists: boolean;
}

export function ClaudeMdSection() {
  const [entries, setEntries] = useState<ClaudeMdEntry[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load list of CLAUDE.md files
  useEffect(() => {
    invoke<ClaudeMdEntry[]>("list_claude_md_files")
      .then((list) => {
        setEntries(list);
        if (list.length > 0) {
          setSelected(list[0].path);
        }
        setLoading(false);
      })
      .catch(console.error);
  }, []);

  // Load content when selection changes
  useEffect(() => {
    if (!selected) return;
    invoke<string>("read_claude_md", { path: selected })
      .then((text) => {
        setContent(text);
        setOriginal(text);
      })
      .catch(console.error);
  }, [selected]);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const handleSave = useCallback(() => {
    if (!selected || content === original) return;
    setSaving(true);
    invoke("save_claude_md", { path: selected, content })
      .then(() => {
        setOriginal(content);
        // Update exists status
        setEntries((prev) =>
          prev.map((e) => (e.path === selected ? { ...e, exists: true } : e))
        );
      })
      .catch(console.error)
      .finally(() => setSaving(false));
  }, [selected, content, original]);

  // Ctrl+S to save
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === "KeyS" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleSave]);

  const hasChanges = content !== original;
  const selectedEntry = entries.find((e) => e.path === selected);

  if (loading) return null;

  return (
    <div className="claude-md-section">
      {/* File selector */}
      <div className="claude-md-header">
        <div className="claude-md-selector" ref={dropdownRef}>
          <button
            className="claude-md-selector-btn"
            onClick={() => setDropdownOpen(!dropdownOpen)}
          >
            <FileText size={14} />
            <span className="claude-md-selector-label">
              {selectedEntry?.label ?? "Select file"}
            </span>
            {selectedEntry && !selectedEntry.exists && (
              <span className="claude-md-badge-new">new</span>
            )}
            <ChevronDown size={14} />
          </button>
          {dropdownOpen && (
            <div className="claude-md-dropdown">
              {entries.map((entry) => (
                <button
                  key={entry.path}
                  className={`claude-md-dropdown-item ${entry.path === selected ? "claude-md-dropdown-item--active" : ""}`}
                  onClick={() => {
                    setSelected(entry.path);
                    setDropdownOpen(false);
                  }}
                >
                  <span>{entry.label}</span>
                  {!entry.exists && <span className="claude-md-badge-new">new</span>}
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          className="claude-md-save-btn"
          onClick={handleSave}
          disabled={!hasChanges || saving}
          title="Save (Ctrl+S)"
        >
          <Save size={14} />
          <span>{saving ? "Saving..." : "Save"}</span>
        </button>
      </div>

      {/* Path hint */}
      <div className="claude-md-path">{selected}</div>

      {/* Editor */}
      <textarea
        ref={textareaRef}
        className="claude-md-editor"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder={selectedEntry?.exists ? "" : "File does not exist yet. Start typing to create it."}
        spellCheck={false}
      />
    </div>
  );
}
