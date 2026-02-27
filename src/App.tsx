import { useState } from "react";
import { Sun, Moon } from "lucide-react";

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
          background: "var(--bg-card)",
          color: "var(--fg-muted)",
          border: "1px solid var(--border)",
        }}
      >
        {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
        <span className="text-sm">{theme === "dark" ? "Light" : "Dark"}</span>
      </button>

      <p className="text-[var(--fg-dim)] text-xs">v0.1.0 — Stage 1</p>
    </div>
  );
}
