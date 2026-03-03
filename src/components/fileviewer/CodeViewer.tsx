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
  snapshot?: string | null;
  onLineEdit?: (lineIndex: number, newText: string) => void;
  onSave?: () => void;
}

interface DiffLine {
  type: "normal" | "removed" | "added";
  content: string;
  lineNumber: number | null;
}

/** Append split lines to result array, returning updated line number */
function pushLines(
  result: DiffLine[],
  text: string,
  type: DiffLine["type"],
  lineNum: number,
): number {
  for (const line of text.split("\n")) {
    result.push({
      type,
      content: line,
      lineNumber: type === "removed" ? null : lineNum++,
    });
  }
  return lineNum;
}

/** Build diff lines from snapshot content and edit hunks */
function buildDiffLines(content: string, edits: DiffEdit[]): DiffLine[] {
  // Filter edits that have oldString and find their positions
  const located: { charIdx: number; edit: DiffEdit }[] = [];
  let searchFrom = 0;
  for (const edit of edits) {
    if (!edit.oldString) continue;
    const idx = content.indexOf(edit.oldString, searchFrom);
    if (idx < 0) continue;
    located.push({ charIdx: idx, edit });
    searchFrom = idx + edit.oldString.length;
  }

  // If no edits found in content, return plain lines
  if (located.length === 0) {
    return content.split("\n").map((line, i) => ({
      type: "normal" as const,
      content: line,
      lineNumber: i + 1,
    }));
  }

  const result: DiffLine[] = [];
  let lineNum = 1;
  let cursor = 0;

  for (const { charIdx, edit } of located) {
    // Text before this edit → normal lines
    if (charIdx > cursor) {
      lineNum = pushLines(result, content.slice(cursor, charIdx), "normal", lineNum);
    }

    // Old text → removed lines
    pushLines(result, edit.oldString, "removed", lineNum);

    // New text → added lines
    if (edit.newString) {
      lineNum = pushLines(result, edit.newString, "added", lineNum);
    }

    cursor = charIdx + edit.oldString.length;
  }

  // Text after last edit → normal lines
  if (cursor < content.length) {
    pushLines(result, content.slice(cursor), "normal", lineNum);
  }

  return result;
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
  snapshot,
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

  // Build diff lines from snapshot when we have edits with oldString
  const diffLines = useMemo(() => {
    if (!diffEdits || diffEdits.length === 0) return null;
    const hasOld = diffEdits.some((e) => e.oldString);
    if (!hasOld) return null;
    const source = snapshot ?? content;
    return buildDiffLines(source, diffEdits);
  }, [diffEdits, snapshot, content]);

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

  // Diff mode: plain text with removed/added/normal lines
  if (diffLines) {
    return (
      <div className="fv-code-viewer">
        <table className="fv-code-table">
          <tbody>
            {diffLines.map((dl, idx) => (
              <tr
                key={idx}
                className={`fv-line${dl.type !== "normal" ? ` fv-line--${dl.type}` : ""}`}
              >
                <td className="fv-line-number">
                  {dl.type === "removed" ? "\u2212" : dl.type === "added" ? "+" : dl.lineNumber}
                </td>
                <td className="fv-line-content">
                  <code>{dl.content || "\u00a0"}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  // Normal mode: syntax highlighting + editing
  return (
    <div className="fv-code-viewer">
      <table className="fv-code-table">
        <tbody>
          {highlighted.map((html, idx) => (
            <tr key={idx} className="fv-line">
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
          ))}
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
