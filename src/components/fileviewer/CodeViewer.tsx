import { memo, useMemo, useCallback, useState, useRef, useEffect } from "react";
import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import rust from "highlight.js/lib/languages/rust";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import ini from "highlight.js/lib/languages/ini";
import yaml from "highlight.js/lib/languages/yaml";
import sql from "highlight.js/lib/languages/sql";
import type { DiffEdit } from "../../types/fileviewer";

// Register languages once
let registered = false;
function ensureRegistered() {
  if (registered) return;
  hljs.registerLanguage("typescript", typescript);
  hljs.registerLanguage("javascript", javascript);
  hljs.registerLanguage("rust", rust);
  hljs.registerLanguage("json", json);
  hljs.registerLanguage("markdown", markdown);
  hljs.registerLanguage("css", css);
  hljs.registerLanguage("xml", xml);
  hljs.registerLanguage("python", python);
  hljs.registerLanguage("bash", bash);
  hljs.registerLanguage("ini", ini);
  hljs.registerLanguage("yaml", yaml);
  hljs.registerLanguage("sql", sql);
  registered = true;
}

interface CodeViewerProps {
  content: string;
  language: string | null;
  diffEdits?: DiffEdit[];
  onLineEdit?: (lineIndex: number, newText: string) => void;
  onSave?: () => void;
}

/** Compute line-level diff markers from edit hunks */
function computeDiffLines(
  content: string,
  edits: DiffEdit[],
): Map<number, "added" | "removed"> {
  const markers = new Map<number, "added" | "removed">();

  for (const edit of edits) {
    if (!edit.oldString && edit.newString) {
      // Pure addition — mark all new lines as added
      const newLines = edit.newString.split("\n");
      const idx = content.indexOf(edit.newString);
      if (idx >= 0) {
        const lineStart = content.slice(0, idx).split("\n").length - 1;
        for (let i = 0; i < newLines.length; i++) {
          markers.set(lineStart + i, "added");
        }
      }
    } else if (edit.oldString && edit.newString) {
      // Replacement — find new text location and mark
      const newLines = edit.newString.split("\n");
      const idx = content.indexOf(edit.newString);
      if (idx >= 0) {
        const lineStart = content.slice(0, idx).split("\n").length - 1;
        for (let i = 0; i < newLines.length; i++) {
          markers.set(lineStart + i, "added");
        }
      }
    }
  }

  return markers;
}

/**
 * Renders highlighted code lines from local files.
 *
 * Security: highlight.js output is used via DOM ref with innerHTML.
 * This is safe because:
 * 1. Input comes from local files read via Tauri commands with path validation
 * 2. highlight.js only emits <span class="hljs-*"> tokens, never arbitrary HTML
 * 3. No user-generated or network-sourced content is rendered this way
 */
export const CodeViewer = memo(function CodeViewer({
  content,
  language,
  diffEdits,
  onLineEdit,
  onSave,
}: CodeViewerProps) {
  ensureRegistered();

  const [editingLine, setEditingLine] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const lines = useMemo(() => content.split("\n"), [content]);

  const highlighted = useMemo(() => {
    if (!language) return lines.map((l) => escapeHtml(l));
    try {
      const result = hljs.highlight(content, { language });
      return result.value.split("\n");
    } catch {
      return lines.map((l) => escapeHtml(l));
    }
  }, [content, language, lines]);

  const diffMarkers = useMemo(() => {
    if (!diffEdits || diffEdits.length === 0) return null;
    return computeDiffLines(content, diffEdits);
  }, [content, diffEdits]);

  const handleDoubleClick = useCallback(
    (lineIdx: number) => {
      if (!onLineEdit) return;
      setEditingLine(lineIdx);
      setEditText(lines[lineIdx]);
    },
    [lines, onLineEdit],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.code === "Escape") {
        setEditingLine(null);
        setEditText("");
      } else if (e.ctrlKey && e.code === "KeyS") {
        e.preventDefault();
        if (editingLine !== null && onLineEdit) {
          onLineEdit(editingLine, editText);
        }
        setEditingLine(null);
        setEditText("");
        onSave?.();
      }
    },
    [editingLine, editText, onLineEdit, onSave],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newVal = e.target.value;
      setEditText(newVal);
      if (editingLine !== null && onLineEdit) {
        onLineEdit(editingLine, newVal);
      }
    },
    [editingLine, onLineEdit],
  );

  // Auto-focus textarea when editing starts
  useEffect(() => {
    if (editingLine !== null && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [editingLine]);

  return (
    <div className="fv-code-viewer">
      <table className="fv-code-table">
        <tbody>
          {highlighted.map((html, idx) => {
            const diffClass = diffMarkers?.get(idx);
            const lineClass = diffClass ? `fv-line--${diffClass}` : "";

            return (
              <tr key={idx} className={`fv-line ${lineClass}`}>
                <td className="fv-line-number">{idx + 1}</td>
                <td
                  className="fv-line-content"
                  onDoubleClick={() => handleDoubleClick(idx)}
                >
                  {editingLine === idx ? (
                    <textarea
                      ref={textareaRef}
                      className="fv-line-editor"
                      value={editText}
                      onChange={handleChange}
                      onKeyDown={handleKeyDown}
                      rows={1}
                      spellCheck={false}
                    />
                  ) : (
                    <LineContent html={html} />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
});

/**
 * Renders a single line of highlighted code via DOM ref.
 * Safe: hljs only produces <span class="hljs-*"> from local file content.
 */
const LineContent = memo(function LineContent({ html }: { html: string }) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (ref.current) {
      // hljs output: only <span class="hljs-*"> tokens from local source files
      ref.current.textContent = "";
      const template = document.createElement("template");
      template.innerHTML = html || "\u00a0";
      ref.current.appendChild(template.content);
    }
  }, [html]);

  return <code ref={ref} />;
});

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
