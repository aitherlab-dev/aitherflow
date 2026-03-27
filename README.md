<h1 align="center">🧃 AITHERFLOW</h1>

<p align="center">
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="https://www.rust-lang.org/"><img src="https://img.shields.io/badge/Built%20with-Rust-orange.svg" alt="Built with Rust"></a>
  <a href="https://tauri.app/"><img src="https://img.shields.io/badge/Runs%20on-Toory%20...%20Torri%20...%20Tauri-blue.svg" alt="Runs on Tauri"></a>
</p>

<p align="center">
  Desktop GUI for <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a> CLI. Multi-agent system with inter-agent communication, knowledge bases (RAG), external model providers, vision analysis, and more.
</p>

<p align="center">
  <strong><a href="DOCS.md">Documentation</a></strong> · <strong><a href="https://github.com/aitherlab-dev/aitherflow/releases">Releases</a></strong> · <strong><a href="https://github.com/aitherlab-dev">aitherlab</a></strong>
</p>

---

> **[CAMERA 3... no wait, CAMERA 1... which one has the red light??]**

https://github.com/user-attachments/assets/efbedbd6-ced3-40b6-a7be-d0f482aee412

### *"It's like a compurter program... for your compurter"* — Dr. Steve Brule

---

## What Is This Prorgam

Okay so basically, aitherflow is a **desktop wraper** *(wrappper? ...rapper?)* for Claude Code CLI. You know Claude? He's the smart computer man who lives inside the wires. Very smart. Probably went to college or something, I dunno.

**[awkward pause, someone drops a coffee mug off-screen]**

The point is — Claude does all the thinking, and aitherflow makes it look pretty. Like when you put a nice frame around a pitcher of your dog. The dog didn't change but now it's got a frame. Same thing. Exackly the same thing.

```
┌─────────────────────────────┐
│                             │
│     YOUR BEAUTIFUL GUI      │
│     (that's "gooey")        │
│                             │
│   ┌─────────────────────┐   │
│   │  CLAUDE CODE CLI    │   │
│   │  (the smart part)   │   │
│   │  he's doin all the  │   │
│   │  work in there      │   │
│   └─────────────────────┘   │
│                             │
│   [CHAT] [FILES] [BRAINS]   │
│                             │
└─────────────────────────────┘
     ↑
     you are here
     (probably)
```

---

## Featurse

**[VHS tracking artifacts intensify]**

- **Multi-Agent Suport** — You can run like, MULTIPLE Claudes at the same time. It's like having a bunch of smart guys but they're all named Claude. *[turns to wrong camera]* Each one gets their own little process, like little apartments for compurter brains.

- **RAG Knowledge Bases** — RAG stands for... *[squints at teleprompter]* ...Reely Awesome...Growledg...? Anyway it reads your documents and remembers stuff. PDFs, EPUBs, websites, even YouTube. It's like a libary but it lives in your compurter and doesn't shush you.

- **Telegram Integratoin** — Send files to Telegram right from the app! Like sending a fax but it actually works and goes to your phone instead of a machine that nobody checks ever.

- **Image Generashion** — Your compurter can draw pitchers now. Like an artist but without the beret and the sad backstory. It uses your **GPU** *(that's the expensieve card inside your compurter that gamers yell about)* to make images LOCALLY. No cloud. The pitchers never leave your house. *[accidentally knocks a model off the desk]* You pick a model — FLUCKS... FLUX? And SDXL which I think is a skateboard trick — download it from HuggingFace *(aww that's a nice name for a website)* and then just ask Claude to draw stuff and BAM, pitcher shows up right in the chat. **[BRULE holds up a crayon drawing]** It's like this but better. Way better. Don't tell my mom I said that.

- **Schedulled Tasks** — Now your compurter can do stuff WHILE YOU SLEEP. *[leans into camera]* Set up a task — like "send me the news at 6am" — pick a schedule (every day, every hour, whatever you want) and aitherflow will run a whole Claude agent automaticly. There's a nice little builder where you pick minutes and hours and days with buttons, no need to learn that cron thing that looks like a phone number from the future. When the task runs, a chat tab appears so you can see what Claude did. It even sends you a Telegram messige when it's done. *[holds up phone proudly]* Look ma, I automated!

---

## Techknical Stack

**[low quality title card with clip art of a computer]**

| What | The Thing | My Notes |
|------|-----------|----------|
| Backend | Rust / Tauri 2 | Rust is very fast. Like a car but for code. Vroom vroom. |
| Frontend | React 19 + TypeScript | It's react. You know react. Everybody knows react. If you don't know react I can't help you, sorry. |
| Styling | Tailwind CSS v4 | You type little words and the compurter makes it pretty. Magic. |
| State | Zustand | It's like Redux but it doesn't make you want to cry. Each store is its own little guy. They don't talk to each other, like my neighbors. |
| Data | JSON files | Just files. On your disk. No databaise. Simple, like me. |
| Image Gen | diffusion-rs / FLUX.2, FLUX.1, SDXL, Z-Image | Your video card becomes an artist. FLUX, LoRA, the whole shebang. Add any model from HuggingFace and it just works. Like Picasso but with more VRAM. |
| Scheduling | Cron + Tokio | Your compurter has an alarm clock now. Very responsible. |
| Platforms | Linux + macOS | No Windoes, sorry. *[whispers to camera]* we don't talk about Windoes here |

---

## Instollation

**[SCENE: A kitchen, for some reason. BRULE stands at the counter with a laptop next to a blender]**

### Preerequitsites

You're gonna need some stuff first. Don't worry it's easy, I did it and I'm... well I did it.

- **[Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)** — the smart guy who does the actual work. Install him first: `npm install -g @anthropic-ai/claude-code && claude`
- An [Anthropic](https://console.anthropic.com/) subscription (Max or Pro plan). Because smart compurter men aren't free. Well, the app is free. The brain costs money. Like college.

### Download the Prorgam

Go to **[Releases](https://github.com/aitherlab-dev/aitherflow/releases)** and grab the latest one:

| Platform | Format | Notes |
|----------|--------|-------|
| **Linux** | `.deb`, `.rpm` | For Ubuntu people and Fedora people. You know who you are. |
| **macOS** | `.dmg` | Apple Silicon. Right-click → Open → Open because Apple doesn't trust us. Rude. |

### Bilding from Sorse

If you're one of THOSE people who builds everything from source (respect), here you go:

```bash
# Clone it (not like the movie, more like copying)
git clone https://github.com/aitherlab-dev/aitherflow.git
cd aitherflow

# Install the depandensees
pnpm install

# Run the development mode
# (this is the one where it's not finished yet but you can look at it)
pnpm tauri dev
```

**[BRULE accidentally hits enter too many times]**

```bash
# For the real deal production build:
pnpm tauri build
# Now you got a real program! Like the ones that come on CDs!
# Remember CDs? They were shiny.
```

You need [Rust](https://rustup.rs/), [Node.js](https://nodejs.org/) 20+, [pnpm](https://pnpm.io/), and [Tauri 2 system deps](https://v2.tauri.app/start/prerequisites/). That's a lot of stuff but I believe in you. Probably.

---

## Projeckt Structur

**[camera slowly zooms in on BRULE's face as he tries to read the teleprompter]**

```
aitherflow/
├── src/                    ← the gooey part (React)
│   ├── components/         ← little pieces of the gooey
│   │   ├── chat/           ← where you talk to Claude
│   │   ├── dashboard/      ← the main screen with cards and stuff
│   │   ├── settings/       ← tweaky knobs
│   │   ├── knowledge/      ← the brain library (RAG)
│   │   └── teamwork/       ← multi-agent party zone
│   ├── stores/             ← zustand lives here (one per room)
│   ├── hooks/              ← react hooks (not fishing hooks)
│   └── types/              ← typescript types (like labels for your jars)
│
├── src-tauri/              ← the rusty part (Rust backend)
│   └── src/
│       ├── conductor/      ← the boss module, runs everything
│       ├── rag/            ← knowledge base brain stuff
│       ├── image_gen/      ← picture making factory
│       ├── scheduler/      ← timed task zone (cron stuff)
│       ├── telegram/       ← phone messaging thing
│       ├── plugins/        ← extra bits
│       └── [many .rs files]← each one does a little job, like ants
│
└── fa fa fa fa fa fa fa...
```

---

## How It Werks

**[informercial voice, camera 2]**

So Claude Code has this CLI thing, right? It's a command line... interfenace. You type stuff and it types stuff back. Very advanced.

Aitherflow takes that CLI and puts a BEAUTIFUL GRAPHICAL wrapper around it. Like putting a tuxedo on a very smart dog.

```
YOU → type message in pretty GUI
         ↓
AITHERFLOW → sends it to Claude CLI process
         ↓
CLAUDE → thinks real hard (he's very smart)
         ↓
AITHERFLOW → shows you the anser in pretty GUI
         ↓
YOU → "wow that's great thanks compurter"
```

The streaming works like this: first you get a `system` message (that's Claude saying hi), then a bunch of `content_block_delta` messages (that's him thinking out loud, fa fa fa), then `assistant` (he's done thinking), then `result` (here's your anser, dummy).

**[BRULE picks up a phone that isn't ringing]** Yes? No, I'm doing the documintation right now. Tell Gary I'll call him back.

---

## Multi-Agent Mode

**[title card: "MULTI-AGENT MODE" in Comic Sans, spinning]**

This is the cool part. You can have MULTIPLE Claudes running at the SAME TIME. Each one is a separate CLI process with full isolation. They each get their own context, their own session, their own tools. This is not just tabs. This is like... a whole office building of Claudes. *[looks at notes written on hand]*

It's like a restaurant but instead of waiters you have a bunch of Claudes running around and they're all really smart but they CAN talk to each other through a built-in messaging system. Unlike my family at Thanksgiving.

**Real example of them working together:**
1. Coordinator gets a task and breaks it down (the boss Claude)
2. Coder creates a worktree, writes code, commits to a feature branch (the worker Claude)
3. Reviewer inspects the changes, reports bugs (the mean Claude)
4. Coordinator sends fixes back to the coder (middle management Claude)
5. You merge when everything looks good (you're still the real boss, don't worry)

---

## RAG (Reely Awesome Growledg)

**[BRULE holds up a book upside down]**

The RAG system lets Claude read your documents so he knows stuff. It uses:

- **fastembed** for making embedings (that's when you turn words into numbers, I think. Locally. No API calls. Your words stay in your compurter.)
- **LanceDB** for storing the numbers somewhere
- It can read: PDFs, EPUBs, plain text, websites, and even YouTube vidoes (!)

There's a whole MCP server called `aitherflow-knowledge` that gives Claude four tools: search, list bases, get documents, and reindex. That's four tools. Count 'em. *[holds up three fingers]*

You can configure chunk sizes and overlap and search limits and stuff like that. I don't know what those words mean but there's a nice dashboard card where you can click buttons.

---

## External Models

**[BRULE puts on reading glasses upside down]**

Sometimes Claude needs a second opinion. Like when you go to another doctor because the first doctor said something you didn't like. So we added external model support:

- **OpenRouter** — 200+ models. That's a lot of models. Like a modeling agency but for AI.
- **Google Gemini** — Google's models. They can look at pictures too (vision). Fancy.
- **Ollama** — local models, no API key needed. They live in your compurter like Claude but they're different guys.

Agents can call these models mid-conversation using MCP tools: `call_model`, `list_models`, `analyze_directory`. It's like phoning a friend on Who Wants to Be a Millionaire except the friend is also a compurter.

API keys go in your system keyring. Not in config files. Because we're profeshional.

---

## Developmint

**[scene transitions with a star wipe effect that takes too long]**

```bash
pnpm tauri dev          # makes it go (development mode)
pnpm tauri build        # makes it go (for real this time)
pnpm typecheck          # checks if you typed good
pnpm lint               # yells at you about your code style
cargo clippy            # a little crab tells you what's wrong (from src-tauri/)
cargo test              # makes sure nothing is broken (from src-tauri/)
```

### Importent Rules for Develorpers

1. **`spawn_blocking`** — use it for ALL tauri commands with file operations. If you don't, the compurter gets stuck like when you put too much bread in the toaster.
2. **`atomic_write()`** — for writing files safely. Because files are importent.
3. **NO Virtuoso** — Do NOT add virtualization to MessageList. It was removed on purpose. Like when they took asbestos out of buildings. It caused problems. Don't put it back.
4. **Lucide React ONLY** — for icons. No inline SVG. No CSS icons. Only Lucide. *[stares directly into camera]* Only. Lucide.
5. **CSS variables** — all colors must use CSS variables. If I catch you hardcoding a hex value I will come to your house and... well I won't actually do anything but I'll be very disappornted.

For the full boring technical documentation, check out **[DOCS.md](DOCS.md)**. It was written by a normal person, not by Dr. Steve Brule.

---

## Contribooting

**[camera is slightly tilted, nobody fixes it for the rest of the segment]**

Want to help make aitherflow better? That's nice of you. Here's what you do:

1. Fork the reportisory (that's like copying someone's homework but it's allowed)
2. Make your changes in a worktree — **NEVER checkout or switch branches!!** Only `git worktree add`. This is very serious. Last time someone did a `git checkout` we lost... *[gets emotional]* ...we lost Daryl's whole branch. Gone. Like tears in rain.
3. Make sure `pnpm typecheck` and `pnpm lint` and `cargo clippy` don't yell at you
4. Submit a PR and we'll look at it probably

**[BRULE accidentally closes the laptop]** Wait how do I... *[opens it again]* ...okay sorry about that.

---

## Trubbleshooting

**[low-res graphic: "HAVING PROBLEMS?" with a stock photo of a confused woman]**

| Problem | Solushion |
|---------|-----------|
| Black screen after WebView crash | Run the build from terminal, look for `Gdk-Message: Error 71`. That means the front end crashed. It's always the front end. *[shakes head]* |
| App won't start | Did you install the depandensees? Did you run `pnpm install`? You gotta do that first, ya dingus. |
| Claude isn't responding | Check if Claude CLI is installed and working. Type `claude --version` in your terminel. If nothing happens, Claude has left the building. |
| Colors look wrong | You probably hardcoded a hex value. I TOLD you not to do that. Use CSS variables. Read the section about CSS variables. I'll wait. |
| Multiple agents acting weird | Make sure each agent has its own state. Don't cross the stores. Never cross the stores. Like ghostbusters but for Zustand. |

---

## Lisense

[MIT](LICENSE). That means you can do whatever you want with it. Free, like the air. Or like the samples at Costco. *[chewing something]* Have you been to Costco? They have great sampoles.

---

## Branding

**aitherflow** — Written in **Oswald** font. "aither" is Bold 700, "flow" is Extra Light 200. It's called typografy. Very fancy.

**[VHS static]**

---

Made with 🧃 by [aitherlab](https://github.com/aitherlab-dev)

Powered by [Claude Code](https://claude.ai) (the smart compurter man) · Built with [Tauri](https://tauri.app/) (the framework, not the car... wait is there a car called Tauri? I should check... *[gets distracted]*)

---

**[END CARD: "FOR YOUR HEALTH" in glowing text, BRULE gives a thumbs up to camera 4, which is not recording]**

*"Remember: aitherflow is for your compurter health. Check it out!"* — Dr. Steve Brule

**[static, then test pattern]**

---

<p align="center">
<sub>This README was written during a fever dream at the Channel 5 studios.<br>For actual documentation, see <a href="DOCS.md">DOCS.md</a>. Seriously.</sub>
</p>
