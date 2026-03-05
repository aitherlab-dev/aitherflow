import { memo } from "react";
import { ExternalLink } from "lucide-react";

const MCP_RESOURCES = [
  {
    name: "Official MCP Servers",
    url: "https://github.com/modelcontextprotocol/servers",
    desc: "Anthropic's official collection",
  },
  {
    name: "Awesome MCP Servers",
    url: "https://github.com/punkpeye/awesome-mcp-servers",
    desc: "Community-curated list",
  },
  {
    name: "Glama MCP Directory",
    url: "https://glama.ai/mcp/servers",
    desc: "Searchable catalog with descriptions",
  },
  {
    name: "mcp.so",
    url: "https://mcp.so",
    desc: "MCP server registry",
  },
  {
    name: "Smithery",
    url: "https://smithery.ai",
    desc: "MCP server marketplace",
  },
];

export const McpResources = memo(function McpResources() {
  return (
    <div className="mcp-resources">
      <h4 className="mcp-resources-title">Where to find MCP servers</h4>
      <div className="mcp-resources-list">
        {MCP_RESOURCES.map((r) => (
          <a
            key={r.url}
            className="mcp-resource-link"
            href={r.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="mcp-resource-name">{r.name}</span>
            <ExternalLink size={11} className="mcp-resource-icon" />
            <span className="mcp-resource-desc">{r.desc}</span>
          </a>
        ))}
      </div>
    </div>
  );
});
