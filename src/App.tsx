import { useState, useEffect, useRef } from "react";
import { Sun, Moon, Send, Square, RotateCcw } from "lucide-react";
import { useConductorStore } from "./stores/conductorStore";

export function App() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
  }

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-8">
      {/* Logo */}
      <h1
        className="select-none tracking-[0.05em]"
        style={{ fontFamily: "'Oswald', sans-serif", fontSize: "3rem" }}
      >
        <span style={{ fontWeight: 700, color: "var(--fg)" }}>aither</span>
        <span style={{ fontWeight: 200, color: "var(--accent)" }}>flow</span>
      </h1>

      <p className="text-[var(--fg-muted)] text-sm">
        Desktop GUI for Claude Code CLI
      </p>

      {/* Theme toggle */}
      <button
        onClick={toggleTheme}
        className="flex items-center gap-2 rounded-lg px-4 py-2 transition-colors"
        style={{
          background: "var(--bg-hover)",
          color: "var(--fg)",
          border: "1px solid var(--border)",
        }}
      >
        {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
        <span className="text-sm">{theme === "dark" ? "Light" : "Dark"}</span>
      </button>

      {/* Dev test panel — only in dev mode, removed in Stage 3 */}
      {import.meta.env.DEV && <DevPanel />}

      <p className="text-[var(--fg-dim)] text-xs">v0.2.0 — Stage 2</p>
    </div>
  );
}

/** Temporary dev panel for testing CLI integration (Stage 2 only) */
function DevPanel() {
  const {
    streamingText,
    model,
    isThinking,
    error,
    sessionId,
    inputTokens,
    outputTokens,
    costUsd,
    events,
    startSession,
    sendFollowup,
    stopSession,
    reset,
    initListener,
    destroyListener,
  } = useConductorStore();

  const [input, setInput] = useState("");
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    initListener();
    return () => destroyListener();
  }, [initListener, destroyListener]);

  // Auto-scroll event log
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [events]);

  async function handleSend() {
    const text = input.trim();
    if (!text) return;
    setInput("");

    if (sessionId) {
      await sendFollowup(text);
    } else {
      await startSession(text);
    }
  }

  return (
    <div
      className="flex w-full max-w-2xl flex-col gap-3 rounded-xl p-4"
      style={{
        background: "var(--bg-soft)",
        border: "1px solid var(--border)",
      }}
    >
      {/* Status line */}
      <div
        className="flex flex-wrap gap-3 text-xs"
        style={{ color: "var(--fg-muted)" }}
      >
        <span>Model: {model ?? "—"}</span>
        <span>Session: {sessionId ? "active" : "none"}</span>
        <span>
          {isThinking ? (
            <span style={{ color: "var(--accent)" }}>Thinking...</span>
          ) : (
            "Idle"
          )}
        </span>
        <span>
          Tokens: {inputTokens}in / {outputTokens}out
        </span>
        <span>Cost: ${costUsd.toFixed(4)}</span>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-lg p-2 text-xs" style={{ color: "var(--red)" }}>
          {error}
        </div>
      )}

      {/* Streaming text output */}
      <pre
        className="max-h-60 overflow-auto rounded-lg p-3 text-sm whitespace-pre-wrap"
        style={{
          background: "var(--bg-hard)",
          color: "var(--fg)",
          minHeight: "4rem",
        }}
      >
        {streamingText || "(no output yet)"}
      </pre>

      {/* Input + buttons */}
      <div className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.code === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend().catch(console.error);
            }
          }}
          placeholder="Type a message..."
          className="flex-1 rounded-lg px-3 py-2 text-sm outline-none"
          style={{
            background: "var(--input-bg)",
            color: "var(--fg)",
            border: "1px solid var(--border)",
          }}
        />
        <button
          onClick={() => {
            handleSend().catch(console.error);
          }}
          disabled={isThinking || !input.trim()}
          className="flex items-center gap-1 rounded-lg px-3 py-2 text-sm transition-opacity disabled:opacity-40"
          style={{
            background: "var(--accent)",
            color: "#fff",
          }}
        >
          <Send size={14} />
        </button>
        <button
          onClick={() => {
            stopSession().catch(console.error);
          }}
          className="flex items-center gap-1 rounded-lg px-3 py-2 text-sm"
          style={{
            background: "var(--bg-hover)",
            color: "var(--fg)",
            border: "1px solid var(--border)",
          }}
        >
          <Square size={14} />
        </button>
        <button
          onClick={reset}
          className="flex items-center gap-1 rounded-lg px-3 py-2 text-sm"
          style={{
            background: "var(--bg-hover)",
            color: "var(--fg)",
            border: "1px solid var(--border)",
          }}
        >
          <RotateCcw size={14} />
        </button>
      </div>

      {/* Raw event log */}
      <details>
        <summary
          className="cursor-pointer text-xs"
          style={{ color: "var(--fg-dim)" }}
        >
          Event log ({events.length})
        </summary>
        <div
          ref={logRef}
          className="mt-1 max-h-40 overflow-auto rounded-lg p-2 font-mono text-xs"
          style={{
            background: "var(--bg-hard)",
            color: "var(--fg-dim)",
          }}
        >
          {events.map((e, i) => (
            <div key={i} className="border-b border-[var(--border)] py-0.5">
              <span style={{ color: "var(--accent)" }}>{e.type}</span>{" "}
              {JSON.stringify(e)}
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
