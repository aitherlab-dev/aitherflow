import { type ReactNode } from "react";
import { openUrl } from "../../lib/transport";

/**
 * Lightweight inline-only markdown renderer for streaming text.
 * Handles: **bold**, *italic*, `code`, [links](url).
 * Paragraphs via double newlines, <br/> via single newlines.
 * No AST, no dependencies — single-pass regex.
 */

// Combined regex: order matters — backticks first (so * inside code is safe),
// then bold before italic (both use *).
const INLINE_RE =
  /(`[^`]+`|\*\*(?:[^*]|\*(?!\*))+\*\*|\*(?:[^*])+?\*|\[([^\]]+)\]\(([^)]+)\))/g;

function parseInlineSegment(text: string, key: number): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  INLINE_RE.lastIndex = 0;
  while ((match = INLINE_RE.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index);
    if (before) nodes.push(before);

    const token = match[0];

    if (token.startsWith("`")) {
      // Inline code
      nodes.push(
        <code key={`${key}-${match.index}`} className="inline-code">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**")) {
      // Bold
      nodes.push(
        <strong key={`${key}-${match.index}`}>
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith("*")) {
      // Italic
      nodes.push(
        <em key={`${key}-${match.index}`}>
          {token.slice(1, -1)}
        </em>,
      );
    } else if (token.startsWith("[")) {
      // Link
      const linkText = match[2];
      const href = match[3];
      nodes.push(
        <a
          key={`${key}-${match.index}`}
          href={href}
          onClick={(e) => {
            e.preventDefault();
            if (href) openUrl(href).catch(console.error);
          }}
        >
          {linkText}
        </a>,
      );
    }

    lastIndex = match.index + token.length;
  }

  const tail = text.slice(lastIndex);
  if (tail) nodes.push(tail);

  return nodes;
}

function renderParagraph(text: string, pIdx: number): ReactNode {
  const lines = text.split("\n");
  const children: ReactNode[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (i > 0) children.push(<br key={`br-${pIdx}-${i}`} />);
    children.push(...parseInlineSegment(lines[i], pIdx * 1000 + i));
  }

  return <p key={`p-${pIdx}`}>{children}</p>;
}

interface InlineMarkdownProps {
  content: string;
}

export function InlineMarkdown({ content }: InlineMarkdownProps) {
  if (!content) return null;

  const paragraphs = content.split(/\n{2,}/);

  return (
    <div className="markdown-body">
      {paragraphs.map((p, i) => renderParagraph(p, i))}
    </div>
  );
}
