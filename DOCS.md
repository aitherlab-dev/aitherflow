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

## Image Generation

Local AI image generation through a built-in MCP server. No cloud APIs — everything runs on your GPU.

- **MCP server** `mcp-image-gen` — Rust server using diffusion-rs (stable-diffusion.cpp bindings)
- **Dynamic model config** — models stored in `~/.config/aither-flow/image-gen/models.json`, no hardcoded list
- **Supported architectures:** FLUX.2, FLUX.1, SDXL, Z-Image — add any GGUF model from HuggingFace
- **GGUF quantization** — run large models on consumer GPUs (16GB VRAM)
- **LoRA support** — per-model LoRA adapters with adjustable strength and enable/disable toggle
- **Add models via UI** — choose type, paste HuggingFace URL, components (VAE, encoders) download automatically
- **Auto-register** — models downloaded by URL are automatically added to the config
- **Dashboard card** — at-a-glance model status, LoRA toggle, quick model switch
- **Settings:** model path, output path, resolution presets (square, portrait, landscape, custom), inference steps
- **In-chat preview** — generated images appear directly in the conversation
- **CUDA GPU acceleration** — ~10x faster generation

## Features

- Multi-agent tabs with full process isolation
- Inter-agent messaging and task coordination
- Chat with streaming markdown responses
- **Send messages during streaming** — inject user messages as inline blockquotes while the agent is thinking/writing; messages are queued and processed on the next turn
- Model selector (Sonnet / Opus / Haiku) and reasoning effort control
- **Interactive permission cards** — Allow/Deny cards for tool approvals, AskUserQuestion with free-text and multi-select, ExitPlanMode with approval flow
- Plan mode toggle with deferred mode switch until user confirms
- System prompt editor with per-project management
- Skill browser with favorites, plugin management
- External model providers (OpenRouter, Google Gemini, Ollama) with MCP server
- Knowledge base with RAG — PDF, EPUB, web, YouTube, local embeddings
- Local image generation via MCP server (FLUX.2, FLUX.1, SDXL, Z-Image — GPU-accelerated, LoRA support)
- Vision analysis — images and video via external models
- **Subscription limits** — 5-hour session and weekly rate limits displayed in Tokens dashboard card and CLI Stats settings page, with refresh button and smart caching
- Right-click file attachment — attach files to messages from the file browser
- Telegram bot integration
- Voice input (Deepgram)
- System tray — close to tray, tray icon with toggle and context menu, quit guard for active agents
- Scheduled tasks — run agents on a schedule (interval, daily, weekly, cron), visual builder, live chat tab, Telegram notifications
- CLI Stats — cost per day chart, breakdown by model and project, subscription limits with refresh
- Project card reorder — Shift+drag to rearrange project cards on the welcome screen
- Dark and light themes (warm palette)

## Send Messages During Streaming

Send messages while the agent is actively generating a response. Instead of waiting for the turn to complete, type and press Enter — your message appears as an inline blockquote inside the assistant's current message.

- **Inline quotes** — user message rendered as `> **User:** text` within the streaming response
- **No interruption** — the agent continues working; your message is queued by the CLI and processed on the next turn
- **Send + Stop buttons** — both visible during streaming, so you can either inject a message or stop generation
- **Quote persistence** — inline quotes are preserved when the message finalizes (messageComplete event)

## Subscription Limits

Monitor your Anthropic subscription usage directly in the app. Data is fetched from the Anthropic OAuth API (`/api/oauth/usage`).

- **Dashboard (Tokens card)** — Session (5-hour) and Weekly limits with mini progress bars, reset time display
- **Settings (CLI Stats)** — full breakdown: 5-hour session, Weekly (all models), Weekly Sonnet, Weekly Opus
- **Refresh button** — manual refresh in CLI Stats bypasses cache
- **Smart caching** — 60-second TTL prevents duplicate API calls; automatic retry on 429 (rate limit)
- **Graceful degradation** — if API is unavailable, limits section is hidden (dashboard) or shows error with retry (settings)
- **OAuth token** — read from `~/.claude/.credentials.json` (managed by Claude Code)

## Interactive Permission Cards

When the CLI requests tool approval, interactive cards appear in the chat.

- **Permission cards** — Allow/Deny buttons for tool execution (file edits, bash commands, etc.)
- **AskUserQuestion** — multi-select options and free-text input for agent questions
- **ExitPlanMode** — plan approval dialog; mode switch deferred until user confirms
- **Control protocol** — cards use `control_request`/`control_response` for bidirectional communication with the CLI

## System Tray

The application minimizes to the system tray instead of closing. The window close button hides the window; the app continues running in the background.

- **Left click** tray icon — toggle window visibility
- **Right click** — context menu: Show / Quit
- **Quit guard** — if an agent is actively working, a confirmation dialog appears before exit

## Scheduled Tasks

Run agent tasks automatically on a schedule. Configure via Settings → Scheduler or the Dashboard card.

- **Schedule types:** interval (every N minutes), daily (at HH:MM), weekly (day + time), advanced (visual cron builder)
- **Visual cron builder** — minute/hour selectors, day-of-week toggle buttons, day-of-month picker. No cron syntax knowledge required
- **Local timezone** — all schedules fire at local time
- **Run Now** — test any task immediately
- **Live agent tab** — scheduled tasks automatically create a chat tab showing the agent's work in real time
- **Telegram notification** — optional notification on task completion
- **Dashboard card** — active task count, last run status, quick access to settings
- **Backend:** Rust module with tokio scheduler loop (30s tick), cron crate for expression parsing, 17 unit tests
- **Config:** `~/.config/aither-flow/scheduled_tasks.json`

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
