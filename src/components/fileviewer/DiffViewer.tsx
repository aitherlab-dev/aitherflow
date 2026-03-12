import { memo, useMemo } from "react";
import type { DiffEdit } from "../../types/fileviewer";

interface DiffViewerProps {
  content: string;
  diffEdits: DiffEdit[];
  snapshot: string | null;
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

export const DiffViewer = memo(function DiffViewer({
  content,
  diffEdits,
  snapshot,
}: DiffViewerProps) {
  const diffLines = useMemo(() => {
    const hasOld = diffEdits.some((e) => e.oldString);
    if (!hasOld) {
      return content.split("\n").map((line, i) => ({
        type: "normal" as const,
        content: line,
        lineNumber: i + 1,
      }));
    }
    const source = snapshot ?? content;
    return buildDiffLines(source, diffEdits);
  }, [diffEdits, snapshot, content]);

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
});
