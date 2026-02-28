import { memo, useState, useCallback, type ReactNode } from "react";
import { Copy, Check } from "lucide-react";

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

interface CodeBlockProps {
  language?: string;
  children: ReactNode;
}

export const CodeBlock = memo(function CodeBlock({ language, children }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const rawText = extractText(children).replace(/\n$/, "");

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(rawText).catch(console.error);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [rawText]);

  return (
    <div className="code-block">
      <div className="code-block-header">
        {language && <span className="code-block-lang">{language}</span>}
        <button
          onClick={handleCopy}
          className="code-block-copy"
          aria-label="Copy code"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre>
        <code className={language ? `language-${language}` : undefined}>
          {children}
        </code>
      </pre>
    </div>
  );
});
