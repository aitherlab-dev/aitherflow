# aitherflow

Desktop GUI for [Claude Code](https://claude.ai/code) CLI.

Not a replacement — a visual interface on top of the CLI. Claude Code remains the sole engine; aitherflow manages processes and displays results.

## Features (planned)

- Multi-agent tabs with full isolation (each agent = own CLI process)
- Chat interface with streaming responses
- Skill, hook, and MCP server management through the GUI
- Interactive permission prompts (native desktop dialogs)
- Gruvbox dark/light theme
- SQLite-backed memory with full-text search
- File viewer, web preview, and more

## Stack

| Layer | Tech |
|-------|------|
| Backend | Rust, Tauri 2 |
| Frontend | React 19, TypeScript, Vite |
| Styling | Tailwind CSS v4, Gruvbox palette |
| State | Zustand |
| Icons | Lucide React |
| Data | SQLite + FTS5, JSON |

## Platforms

- **Linux** — primary target
- **macOS** — secondary
- Windows is not supported

## Development

```bash
pnpm install
pnpm tauri dev
```

## License

[MIT](LICENSE)

---

Part of the [aitherlab](https://github.com/aitherlab-dev) project family.
