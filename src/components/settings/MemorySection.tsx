import { useState, useEffect, useCallback } from "react";
import { invoke } from "../../lib/transport";
import { Brain, RefreshCw, Loader, Database } from "lucide-react";
import { useProjectStore } from "../../stores/projectStore";

interface MemoryStats {
  session_count: number;
  message_count: number;
}

export function MemorySection() {
  const projects = useProjectStore((s) => s.projects);
  const [selectedPath, setSelectedPath] = useState("");
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [indexing, setIndexing] = useState(false);
  const [lastResult, setLastResult] = useState("");
  const [error, setError] = useState("");

  const loadStats = useCallback((path: string) => {
    if (!path) {
      setStats(null);
      return;
    }
    invoke<MemoryStats>("memory_stats", { projectPath: path })
      .then(setStats)
      .catch((e) => {
        console.error("memory_stats failed:", e);
        setStats(null);
      });
  }, []);

  useEffect(() => {
    loadStats(selectedPath);
  }, [selectedPath, loadStats]);

  const handleIndex = useCallback(async () => {
    if (!selectedPath || indexing) return;
    setIndexing(true);
    setError("");
    setLastResult("");
    try {
      const count = await invoke<number>("memory_index_project", {
        projectPath: selectedPath,
      });
      setLastResult(
        count > 0
          ? `Indexed ${count} new messages`
          : "Already up to date",
      );
      loadStats(selectedPath);
    } catch (e) {
      setError(String(e));
      console.error("memory_index_project failed:", e);
    } finally {
      setIndexing(false);
    }
  }, [selectedPath, indexing, loadStats]);

  const handleProjectChange = useCallback((path: string) => {
    setSelectedPath(path);
    setLastResult("");
    setError("");
  }, []);

  return (
    <div className="memory-section">
      <div className="memory-description">
        <Brain size={16} className="memory-description__icon" />
        <p>
          Session memory indexes your CLI conversation history into a searchable
          database. The agent uses it to recall past decisions and context.
        </p>
      </div>

      <div className="memory-select-row">
        <label htmlFor="memory-project-select">Project</label>
        <select
          id="memory-project-select"
          className="memory-select"
          value={selectedPath}
          onChange={(e) => handleProjectChange(e.target.value)}
        >
          <option value="">Select project...</option>
          {projects.map((p) => (
            <option key={p.path} value={p.path}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      {selectedPath && stats && (
        <div className="memory-stats-card">
          <Database size={14} className="memory-stats-icon" />
          <span>
            {stats.session_count} sessions, {stats.message_count} messages
          </span>
        </div>
      )}

      {selectedPath && (
        <div className="memory-actions">
          <button
            className="memory-btn memory-btn--accent"
            onClick={handleIndex}
            disabled={indexing}
          >
            {indexing ? (
              <Loader size={14} className="spinning" />
            ) : (
              <RefreshCw size={14} />
            )}
            <span>{indexing ? "Indexing..." : "Index Sessions"}</span>
          </button>
        </div>
      )}

      {lastResult && <div className="memory-result">{lastResult}</div>}
      {error && <div className="memory-error">{error}</div>}
    </div>
  );
}
