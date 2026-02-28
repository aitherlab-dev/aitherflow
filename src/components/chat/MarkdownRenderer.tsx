import { memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { CodeBlock } from "./CodeBlock";
import type { Components } from "react-markdown";

/** Recursively extract plain text from React node tree */
function extractText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (!node) return "";
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (typeof node === "object" && "props" in node) {
    return extractText((node as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

const components: Components = {
  code({ className, children, ...props }) {
    const match = /language-(\w+)/.exec(className ?? "");
    const rawText = extractText(children);
    const isBlock = Boolean(match) || rawText.includes("\n");

    if (isBlock) {
      return (
        <CodeBlock language={match?.[1]}>
          {children}
        </CodeBlock>
      );
    }

    return (
      <code className="inline-code" {...props}>
        {children}
      </code>
    );
  },
};

const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeHighlight];

interface MarkdownRendererProps {
  content: string;
}

export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
}: MarkdownRendererProps) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
