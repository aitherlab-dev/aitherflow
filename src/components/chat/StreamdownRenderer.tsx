import { memo } from "react";
import { Streamdown, type Components } from "streamdown";
import { createCodePlugin } from "@streamdown/code";
import "streamdown/styles.css";
import { openUrl } from "../../lib/transport";

interface StreamdownRendererProps {
  content: string;
  isStreaming?: boolean;
}

const codePlugin = createCodePlugin({
  themes: ["gruvbox-dark-medium", "gruvbox-dark-medium"],
});

const plugins = { code: codePlugin };

const controls = {
  code: { copy: true, download: false },
  table: { copy: true, download: false },
};

const components: Components = {
  a: ({ href, children, ...props }) => (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (href) openUrl(href).catch(console.error);
      }}
      {...props}
    >
      {children}
    </a>
  ),
  table: ({ children, ...props }) => (
    <div className="table-wrapper">
      <table {...props}>{children}</table>
    </div>
  ),
};

export const StreamdownRenderer = memo(function StreamdownRenderer({
  content,
  isStreaming = false,
}: StreamdownRendererProps) {
  const mode = isStreaming ? "streaming" : "static";

  if (!content) return null;

  return (
    <div className="markdown-body">
      <Streamdown
        mode={mode}
        isAnimating={isStreaming}
        plugins={plugins}
        components={components}
        controls={controls}

        animated={false}
      >
        {content}
      </Streamdown>
    </div>
  );
});
