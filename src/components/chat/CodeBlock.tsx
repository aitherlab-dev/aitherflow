import { memo, useState, useCallback, useRef, useEffect, type ReactNode } from "react";
import { Copy, Check } from "lucide-react";
import { extractText } from "./utils";

interface CodeBlockProps {
  language?: string;
  children: ReactNode;
}

export const CodeBlock = memo(function CodeBlock({ language, children }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const rawText = extractText(children).replace(/\n$/, "");

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(rawText).catch(console.error);
    setCopied(true);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 2000);
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
