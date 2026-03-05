import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { openUrl } from "../../lib/transport";
import { CodeBlock } from "./CodeBlock";
import { extractText } from "./utils";
import type { Components } from "react-markdown";

const components: Components = {
  a({ href, children }) {
    return (
      <a
        href={href}
        onClick={(e) => {
          e.preventDefault();
          if (href) openUrl(href).catch(console.error);
        }}
      >
        {children}
      </a>
    );
  },
  table({ children }) {
    return (
      <div className="table-wrapper">
        <table>{children}</table>
      </div>
    );
  },
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
