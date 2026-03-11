# aitherflow

Desktop GUI for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI.

Not a replacement — a visual interface on top of the CLI. Claude Code remains the sole engine; aitherflow manages processes and displays results.

## Features

- Multi-agent tabs with full isolation (each agent = own CLI process)
- Chat with streaming markdown responses
- Model selector (Sonnet / Opus / Haiku) and reasoning effort control
- Interactive permission prompts and plan/edit mode toggle
- Skill browser with favorites, plugin management
- Telegram bot integration
- Voice input (Groq)
- Dark and light themes (warm palette)

## Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) — installed and authenticated
- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) 20+
- [pnpm](https://pnpm.io/)
- Tauri 2 system dependencies — see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

## Build from source

```bash
git clone https://github.com/aitherlab-dev/aitherflow.git
cd aitherflow
pnpm install
pnpm tauri build
```

Packages (`.deb`, `.rpm`) will be in `src-tauri/target/release/bundle/`.

For development:

```bash
pnpm tauri dev
```

## Stack

| Layer | Tech |
|-------|------|
| Backend | Rust, Tauri 2 |
| Frontend | React 19, TypeScript, Vite |
| Styling | Tailwind CSS v4 |
| State | Zustand |
| Icons | Lucide React |
| Data | JSON |

## Platforms

- **Linux** — deb, rpm
- **macOS** — planned

## License

[MIT](LICENSE)

---

Part of the [aitherlab](https://github.com/aitherlab-dev) project family.
