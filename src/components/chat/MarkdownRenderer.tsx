import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { CodeBlock } from "./CodeBlock";
import type { Components } from "react-markdown";

const components: Components = {
  code({ className, children, ...props }) {
    const match = /language-(\w+)/.exec(className ?? "");
    const isBlock = Boolean(match) || String(children).includes("\n");

    if (isBlock) {
      return (
        <CodeBlock
          code={String(children).replace(/\n$/, "")}
          language={match?.[1]}
        />
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
