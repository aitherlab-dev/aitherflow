# aitherflow

Desktop GUI for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI.

Not a replacement — a visual interface on top of the CLI. Claude Code remains the sole engine; aitherflow manages processes and displays results.

## Multi-Agent System

Each agent runs as a **separate CLI process** with full isolation — own context, own session, own tools. This is not just multiple chat tabs.

**Inter-agent communication.** Agents talk to each other through a built-in messaging system (MCP teamwork server). A coordinator can assign tasks, a coder writes code in an isolated worktree, a reviewer checks the result — all running in parallel without interfering with each other.

**Worktree integration.** Agents work in separate git worktrees on their own branches. The main branch stays clean until you explicitly merge. No accidental commits to production, no context conflicts between agents.

**Real coordination example:**
1. Coordinator receives a task and breaks it down
2. Coder creates a worktree, writes code, commits to a feature branch
3. Reviewer inspects the changes, reports bugs
4. Coordinator sends fixes back to the coder
5. You merge when everything is verified

## System Prompts

A full system prompt editor built into the interface — not markdown files with "you are a senior developer" role descriptions.

- Create, edit, and manage system prompts per project
- Prompts shape agent behavior from the first message
- Switch prompts between sessions without touching config files

## External Models

Connect additional AI providers alongside Claude Code. Models are available to agents through a built-in MCP server.

- **OpenRouter** — access to 200+ models (GPT-4o, Gemini, Llama, Mistral, etc.)
- **Google Gemini** — Gemini models with native vision support
- **Ollama** — local models, no API key needed

**Vision.** Analyze images and videos with external models. Video frame extraction via ffmpeg, configurable frame limits, native video support for Gemini. Vision profiles let you tune strategy per provider.

**MCP tools:** `call_model`, `list_models`, `analyze_directory` — agents can call external models mid-conversation for second opinions, translations, or specialized tasks.

API keys are stored in the system keyring, never in config files.

## Knowledge Base

Built-in RAG (Retrieval-Augmented Generation) system. Create knowledge bases from documents — agents search them automatically during conversations.

- **Document sources:** PDF, EPUB, TXT/Markdown, web pages, YouTube transcripts
- **Local embeddings:** fastembed (ONNX) — no external API calls for indexing
- **Vector search:** LanceDB with semantic similarity
- **MCP server** `aitherflow-knowledge` — agents get 4 tools: `search`, `list_bases`, `get_docs`, `reindex`
- Configurable chunk size, overlap, search limits
- Dashboard card for managing knowledge bases

## Features

- Multi-agent tabs with full process isolation
- Inter-agent messaging and task coordination
- Chat with streaming markdown responses
- Model selector (Sonnet / Opus / Haiku) and reasoning effort control
- Interactive permission prompts and plan/edit mode toggle
- System prompt editor with per-project management
- Skill browser with favorites, plugin management
- External model providers (OpenRouter, Google Gemini, Ollama) with MCP server
- Knowledge base with RAG — PDF, EPUB, web, YouTube, local embeddings
- Vision analysis — images and video via external models
- Telegram bot integration
- Voice input (Deepgram)
- Dark and light themes (warm palette)

## Install

### Requirements

- **[Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)** — installed and authenticated (`npm install -g @anthropic-ai/claude-code && claude`)
- Active [Anthropic](https://console.anthropic.com/) subscription (Max or Pro plan)

### Download

Go to [Releases](https://github.com/aitherlab-dev/aitherflow/releases) and download the latest version for your platform:

| Platform | Format |
|----------|--------|
| **Linux** | `.deb` (Ubuntu/Debian), `.rpm` (Fedora) |
| **macOS** | `.dmg` (Apple Silicon) |

> **macOS note:** The app is not signed with an Apple Developer certificate. On first launch, right-click the app → Open → Open to bypass Gatekeeper.

### Build from source

**Prerequisites:** [Rust](https://rustup.rs/) (stable), [Node.js](https://nodejs.org/) 20+, [pnpm](https://pnpm.io/), [Tauri 2 system deps](https://v2.tauri.app/start/prerequisites/)

```bash
git clone https://github.com/aitherlab-dev/aitherflow.git
cd aitherflow
pnpm install
pnpm tauri build
```

Packages will be in `target/release/bundle/`.

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
| Embeddings | fastembed (ONNX) |
| Vector DB | LanceDB |

## Platforms

- **Linux** — deb, rpm
- **macOS** — dmg (Apple Silicon)

## License

[MIT](LICENSE)

---

Part of the [aitherlab](https://github.com/aitherlab-dev) project family.
