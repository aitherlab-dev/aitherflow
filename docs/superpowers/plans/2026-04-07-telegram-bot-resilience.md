# Telegram Bot Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Telegram bot resilient to network failures — detect disconnects, retry outgoing messages, surface errors in the UI, and auto-reconnect.

**Architecture:** Three changes: (1) bot_loop tracks its own health via an atomic error flag in BotState, (2) outgoing messages retry on failure instead of silently dropping, (3) frontend polls status and shows reconnection state. No new files — all changes in existing modules.

**Tech Stack:** Rust (tokio, reqwest), React/TypeScript, Zustand

---

### Task 1: Add error tracking to BotState

**Files:**
- Modify: `src-tauri/src/telegram/mod.rs:29-35` (TelegramStatus)
- Modify: `src-tauri/src/telegram/mod.rs:143-159` (BotState)

- [ ] **Step 1: Add `last_error` and `consecutive_errors` fields to BotState**

In `mod.rs`, add tracking fields to `BotState`:

```rust
pub(crate) struct BotState {
    pub config: TelegramConfig,
    pub status: TelegramStatus,
    pub task_handle: Option<tokio::task::JoinHandle<()>>,
    pub outgoing_tx: Option<mpsc::UnboundedSender<TgOutgoing>>,
    pub incoming_tx: Option<mpsc::UnboundedSender<TgIncoming>>,
    pub incoming_rx: Option<mpsc::UnboundedReceiver<TgIncoming>>,
    pub http_client: Option<reqwest::Client>,
    pub stream_message_id: i64,
    pub callback_registry: Vec<String>,
    pub team_builder: Option<TeamBuilder>,
    /// Consecutive getUpdates errors — 0 means healthy
    pub consecutive_errors: u32,
    /// Last error message from bot_loop (for UI display)
    pub last_error: Option<String>,
}
```

Update `start_telegram_bot` in `commands.rs` — both `BotState` initializers (line 66-77 and line 129-140) must include:
```rust
consecutive_errors: 0,
last_error: None,
```

- [ ] **Step 2: Add `reconnecting` field to TelegramStatus**

In `mod.rs`, update `TelegramStatus`:

```rust
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TelegramStatus {
    pub running: bool,
    pub connected: bool,
    pub reconnecting: bool,
    pub error: Option<String>,
    pub bot_username: Option<String>,
}
```

- [ ] **Step 3: Add helper to update error state from bot_loop**

In `mod.rs`, add a public helper after `with_state`:

```rust
/// Called by bot_loop to report health changes.
/// Updates status.reconnecting and last_error for the UI to poll.
pub(crate) fn report_bot_health(consecutive_errors: u32, error: Option<&str>) {
    with_state(|s| {
        if let Some(state) = s.as_mut() {
            state.consecutive_errors = consecutive_errors;
            state.last_error = error.map(|e| e.to_string());
            state.status.reconnecting = consecutive_errors > 0;
            if consecutive_errors == 0 {
                state.status.connected = true;
                state.status.error = None;
            } else {
                state.status.error = error.map(|e| e.to_string());
            }
        }
    });
}
```

- [ ] **Step 4: Run `cargo clippy` from `src-tauri/`**

Run: `cd src-tauri && cargo clippy -- -D warnings`
Expected: warnings about unused fields (we'll use them in next tasks), but no hard errors

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/telegram/mod.rs src-tauri/src/telegram/commands.rs
git commit -m "feat(telegram): add error tracking fields to BotState and TelegramStatus"
```

---

### Task 2: Bot loop reports health and retries outgoing messages

**Files:**
- Modify: `src-tauri/src/telegram/bot.rs:25-148` (bot_loop)
- Modify: `src-tauri/src/telegram/api.rs:65-95` (tg_send_message)

- [ ] **Step 1: Bot loop reports errors via `report_bot_health`**

In `bot.rs`, update the bot_loop error handling. Replace the `Err(e)` branch of `tg_get_updates` (lines 124-128):

```rust
Err(e) => {
    error_backoff_secs = (error_backoff_secs.max(5) * 2).min(60);
    let msg = format!("getUpdates error (retry in {error_backoff_secs}s): {e}");
    eprintln!("[TG] {msg}");
    consecutive_errors += 1;
    super::report_bot_health(consecutive_errors, Some(&msg));
    tokio::time::sleep(std::time::Duration::from_secs(error_backoff_secs)).await;
}
```

And after the `Ok(updates)` line (line 46), add health recovery:

```rust
Ok(updates) => {
    error_backoff_secs = 0;
    if consecutive_errors > 0 {
        consecutive_errors = 0;
        super::report_bot_health(0, None);
        eprintln!("[TG] Connection restored");
    }
    // ... rest of update processing
```

Add `let mut consecutive_errors: u32 = 0;` next to `error_backoff_secs` at line 35.

- [ ] **Step 2: Add retry logic for outgoing messages**

In `bot.rs`, replace the outgoing branch (lines 132-145):

```rust
outgoing = outgoing_rx.recv() => {
    match outgoing {
        Some(msg) => {
            let mut attempts = 0u32;
            loop {
                match tg_send_message(&client, &token, msg.chat_id, &msg.text).await {
                    Ok(()) => break,
                    Err(e) => {
                        attempts += 1;
                        if attempts >= 3 {
                            eprintln!("[TG] send outgoing failed after 3 attempts: {e}");
                            break;
                        }
                        eprintln!("[TG] send outgoing attempt {attempts} failed: {e}, retrying in 2s");
                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    }
                }
            }
        }
        None => {
            eprintln!("[TG] Outgoing channel closed, shutting down");
            break;
        }
    }
}
```

- [ ] **Step 3: Make `tg_send_message` return Err on HTTP failure**

Currently `tg_send_message` in `api.rs` (lines 65-95) logs errors but always returns `Ok(())`. Change the error branches to return `Err`:

```rust
pub(crate) async fn tg_send_message(
    client: &reqwest::Client,
    token: &str,
    chat_id: i64,
    text: &str,
) -> Result<(), String> {
    let chunks = split_message(text, 4000);
    for chunk in chunks {
        let url = format!("{TG_API}{token}/sendMessage");
        let body = serde_json::json!({
            "chat_id": chat_id,
            "text": chunk,
            "parse_mode": "HTML",
            "disable_web_page_preview": true,
        });
        match client.post(&url).json(&body).send().await {
            Ok(r) if !r.status().is_success() => {
                let resp_text = r.text().await.unwrap_or_default();
                let err = sanitize_error(&resp_text, token);
                eprintln!("[TG] sendMessage error: {err}");
                // If it's a parse error, retry without HTML parse_mode
                if resp_text.contains("can't parse entities") {
                    let body_plain = serde_json::json!({
                        "chat_id": chat_id,
                        "text": chunk,
                        "disable_web_page_preview": true,
                    });
                    match client.post(&url).json(&body_plain).send().await {
                        Ok(r2) if r2.status().is_success() => continue,
                        Ok(r2) => {
                            let t = r2.text().await.unwrap_or_default();
                            return Err(sanitize_error(&format!("sendMessage fallback: {t}"), token));
                        }
                        Err(e) => return Err(sanitize_error(&format!("sendMessage fallback: {e}"), token)),
                    }
                }
                return Err(err);
            }
            Err(e) => {
                let err = sanitize_error(&e.to_string(), token);
                eprintln!("[TG] sendMessage error: {err}");
                return Err(err);
            }
            _ => {}
        }
    }
    Ok(())
}
```

Note: this also restores the HTML parse fallback — if Telegram can't parse HTML entities, it retries without parse_mode.

- [ ] **Step 4: Fix callers that don't expect Err from tg_send_message**

In `bot.rs`, the `tg_send_message` calls in the update processing section (access denied message at line 65, unsupported format at line 91) use `if let Err(e)` pattern — those are fine, they already handle errors.

In `handlers.rs`, check all `tg_send_message` calls — they all use `if let Err(e)` or `.await?`, so no changes needed.

- [ ] **Step 5: Run `cargo clippy` and `cargo test`**

Run: `cd src-tauri && cargo clippy -- -D warnings && cargo test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/telegram/bot.rs src-tauri/src/telegram/api.rs
git commit -m "feat(telegram): retry outgoing messages, report health state, restore HTML fallback"
```

---

### Task 3: `get_telegram_status` checks if bot_loop is alive

**Files:**
- Modify: `src-tauri/src/telegram/commands.rs:43-50` (get_telegram_status)

- [ ] **Step 1: Check task_handle liveness in get_telegram_status**

Replace `get_telegram_status` in `commands.rs`:

```rust
#[tauri::command]
pub fn get_telegram_status() -> Result<TelegramStatus, String> {
    Ok(with_state(|s| {
        match s.as_mut() {
            Some(state) => {
                // Check if bot_loop task is still alive
                if let Some(handle) = &state.task_handle {
                    if handle.is_finished() {
                        // bot_loop died — clean up
                        eprintln!("[TG] bot_loop task finished unexpectedly");
                        state.task_handle = None;
                        state.outgoing_tx = None;
                        state.incoming_tx = None;
                        state.incoming_rx = None;
                        state.status = TelegramStatus {
                            running: false,
                            connected: false,
                            reconnecting: false,
                            error: Some("Bot stopped unexpectedly".into()),
                            bot_username: state.status.bot_username.clone(),
                        };
                    }
                }
                state.status.clone()
            }
            None => TelegramStatus::default(),
        }
    }))
}
```

- [ ] **Step 2: Run `cargo clippy`**

Run: `cd src-tauri && cargo clippy -- -D warnings`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/telegram/commands.rs
git commit -m "feat(telegram): detect dead bot_loop in get_telegram_status"
```

---

### Task 4: Frontend shows reconnection state

**Files:**
- Modify: `src/components/settings/TelegramSection.tsx:28-33` (TelegramStatus interface)
- Modify: `src/components/settings/TelegramSection.tsx:106-118` (toggle row)
- Modify: `src/services/telegramService.ts:28-33` (TelegramStatus interface)

- [ ] **Step 1: Update TelegramStatus interface in both files**

In `TelegramSection.tsx`, update the interface:

```typescript
interface TelegramStatus {
  running: boolean;
  connected: boolean;
  reconnecting: boolean;
  error: string | null;
  bot_username: string | null;
}
```

In `telegramService.ts`, same change:

```typescript
interface TelegramStatus {
  running: boolean;
  connected: boolean;
  reconnecting: boolean;
  error: string | null;
  bot_username: string | null;
}
```

Update the default state in `TelegramSection.tsx` (line 28-33):

```typescript
const [status, setStatus] = useState<TelegramStatus>({
  running: false,
  connected: false,
  reconnecting: false,
  error: null,
  bot_username: null,
});
```

- [ ] **Step 2: Show reconnecting state in TelegramSection UI**

In `TelegramSection.tsx`, update the toggle description (lines 108-112):

```tsx
<span className="settings-toggle-desc">
  Send messages to the agent via Telegram.
  {status.running && status.connected && status.bot_username && ` Connected as @${status.bot_username}.`}
  {status.running && status.connected && !status.bot_username && " Bot is running."}
  {status.running && status.reconnecting && " Reconnecting..."}
  {status.running && !status.connected && !status.reconnecting && " Disconnected."}
</span>
```

- [ ] **Step 3: Show error message below toggle when reconnecting**

In `TelegramSection.tsx`, after the `startError` block (after line 124), add reconnecting error display:

```tsx
{status.reconnecting && status.error && (
  <div className="webserver-note" style={{ color: "var(--warning)" }}>
    {status.error}
  </div>
)}
```

- [ ] **Step 4: Poll status periodically when bot is running**

In `TelegramSection.tsx`, add a status polling effect after the save effect (after line 55):

```typescript
useEffect(() => {
  if (!status.running) return;
  const interval = setInterval(() => {
    invoke<TelegramStatus>("get_telegram_status")
      .then(setStatus)
      .catch(console.error);
  }, 5000);
  return () => clearInterval(interval);
}, [status.running]);
```

- [ ] **Step 5: Run `pnpm typecheck`**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/components/settings/TelegramSection.tsx src/services/telegramService.ts
git commit -m "feat(telegram): show reconnecting state and errors in settings UI"
```

---

### Task 5: Auto-restart bot after unexpected death

**Files:**
- Modify: `src/hooks/useTelegramBridge.ts`

- [ ] **Step 1: Add auto-restart logic to useTelegramBridge**

In `useTelegramBridge.ts`, update the poll function to detect bot death and restart:

```typescript
export function useTelegramBridge() {
  const prevIsThinking = useRef(false);
  const abortRef = useRef(false);

  // Poll incoming messages — fast (1s) when bot is running, slow (10s) when idle
  useEffect(() => {
    abortRef.current = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let botActive = false;
    let wasRunning = false;

    const servicePromise = import("../services/telegramService");

    async function poll() {
      if (abortRef.current) return;
      try {
        const svc = await servicePromise;
        const running = await svc.isBotRunning();
        botActive = running;

        if (wasRunning && !running) {
          // Bot died — try to restart once
          console.warn("[TG] Bot stopped unexpectedly, attempting restart");
          try {
            const { invoke } = await import("../lib/transport");
            await invoke("start_telegram_bot");
            botActive = true;
          } catch (e) {
            console.error("[TG] Auto-restart failed:", e);
          }
        }
        wasRunning = running;

        if (running) await pollAndHandle();
      } catch (e) {
        console.error("[TG] poll:", e);
      }
      if (!abortRef.current) {
        timer = setTimeout(poll, botActive ? 1000 : 10000);
      }
    }

    timer = setTimeout(poll, 1000);

    return () => {
      abortRef.current = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
  }, []);

  // Stream agent responses to Telegram (unchanged)
  useEffect(() => {
    const unsub = useChatStore.subscribe((state) => {
      const wasThinking = prevIsThinking.current;
      prevIsThinking.current = state.isThinking;

      if (!wasThinking && state.isThinking) {
        startStreaming();
      }

      if (wasThinking && !state.isThinking) {
        finishStreaming();
      }
    });

    return () => {
      unsub();
      cleanupStreaming();
    };
  }, []);
}
```

- [ ] **Step 2: Run `pnpm typecheck`**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useTelegramBridge.ts
git commit -m "feat(telegram): auto-restart bot on unexpected death"
```

---

### Task 6: Verify everything compiles

**Files:** None (verification only)

- [ ] **Step 1: Run full typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 2: Run Rust checks**

Run: `cd src-tauri && cargo clippy -- -D warnings && cargo test`
Expected: PASS

- [ ] **Step 3: Run lint**

Run: `pnpm lint`
Expected: PASS (or only pre-existing warnings)
