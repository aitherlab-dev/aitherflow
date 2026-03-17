/**
 * Telegram bot bridge logic — handles incoming messages,
 * sends menus/agents/skills, manages streaming responses.
 *
 * Pure service — no React, no hooks. Called by useTelegramBridge.
 */

import { invoke } from "../lib/transport";
import { useChatStore } from "../stores/chatStore";
import { useAgentStore } from "../stores/agentStore";
import { useProjectStore } from "../stores/projectStore";

import { useSkillStore } from "../stores/skillStore";
import { sendMessage } from "../stores/chatService";
import { toFileType } from "../types/chat";
import type { Attachment } from "../types/chat";
import type { ProcessFileResult } from "../types/files";

interface TgIncoming {
  kind: string;
  text: string;
  project_path?: string;
  project_name?: string;
  attachment_path?: string;
}

interface TelegramStatus {
  running: boolean;
  connected: boolean;
  error: string | null;
  bot_username: string | null;
}

// ── State ──

const STREAM_THROTTLE_MS = 1000;
const TURN_SEPARATOR = "\n<!-- turn -->\n";

/** True when the last user message came from Telegram (not from the app) */
let lastFromTelegram = false;

let lastStreamText = "";
let streamTimer: ReturnType<typeof setInterval> | null = null;
/** ID of the last assistant message sent to Telegram (to avoid duplicates) */
let lastSentMessageId: string | null = null;

/** Strip thinking blocks — take text after last turn separator */
function stripThinking(raw: string): string {
  const sep = raw.lastIndexOf(TURN_SEPARATOR);
  return sep !== -1 ? raw.slice(sep + TURN_SEPARATOR.length).trim() : raw.trim();
}

// ── Public API ──

export function isBotRunning(): Promise<boolean> {
  return invoke<TelegramStatus>("get_telegram_status")
    .then((s) => s.running && s.connected)
    .catch((e) => {
      console.error("[TG] isBotRunning:", e);
      return false;
    });
}

export async function pollAndHandle(): Promise<void> {
  const running = await isBotRunning();
  if (!running) return;

  let messages: TgIncoming[];
  try {
    messages = await invoke<TgIncoming[]>("poll_telegram_messages");
  } catch (e) {
    console.error("Telegram polling error:", e);
    return;
  }

  for (const msg of messages) {
    await handleIncoming(msg);
  }
}

export function startStreaming(): void {
  if (!lastFromTelegram) return;

  lastStreamText = "";

  if (streamTimer) clearInterval(streamTimer);
  streamTimer = setInterval(() => {
    const s = useChatStore.getState();
    if (!s.isThinking) return;

    // During streaming, the current response is in streamingMessage, not in messages
    const text = s.streamingMessage?.role === "assistant" ? s.streamingMessage.text : null;
    if (text) {
      const clean = stripThinking(text);
      if (clean && clean !== lastStreamText) {
        lastStreamText = clean;
        const truncated =
          clean.length > 4000 ? clean.slice(-4000) : clean;
        invoke("telegram_stream_edit", { text: truncated }).catch(
          console.error,
        );
      }
    }
  }, STREAM_THROTTLE_MS);
}

export function finishStreaming(): void {
  if (streamTimer) {
    clearInterval(streamTimer);
    streamTimer = null;
  }

  if (!lastFromTelegram) {
    lastStreamText = "";
    return;
  }
  lastFromTelegram = false;

  const state = useChatStore.getState();

  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i];
    if (m.role === "assistant" && m.text) {
      if (m.id === lastSentMessageId) break;
      lastSentMessageId = m.id;

      const clean = stripThinking(m.text);
      if (clean) {
        invoke("telegram_stream_edit", { text: clean.length > 4000 ? clean.slice(-4000) : clean })
          .then(() => invoke("telegram_stream_reset"))
          .catch(console.error);
      } else {
        invoke("telegram_stream_reset").catch(console.error);
      }
      break;
    }
  }

  lastStreamText = "";
}

export function cleanupStreaming(): void {
  if (streamTimer) {
    clearInterval(streamTimer);
    streamTimer = null;
  }
}

/** Reset all module state when switching agents */
export function resetTelegramState(): void {
  cleanupStreaming();
  lastFromTelegram = false;
  lastStreamText = "";
  lastSentMessageId = null;
}

// ── Incoming message handlers ──

async function handleIncoming(msg: TgIncoming): Promise<void> {
  switch (msg.kind) {
    case "text":
      await handleText(msg);
      break;
    case "request_menu":
      await handleRequestMenu();
      break;
    case "request_agents":
      await handleRequestAgents();
      break;
    case "request_projects":
      await handleRequestProjects();
      break;
    case "request_skills":
      await handleRequestSkills();
      break;
    case "request_stop":
      await handleRequestStop();
      break;
    case "switch_agent":
      await handleSwitchAgent(msg.text);
      break;
    case "new_session":
      await handleNewSession(msg.project_path, msg.project_name);
      break;
    case "stop_agent":
      await handleStopAgent(msg.text);
      break;
  }
}

async function handleText(msg: TgIncoming): Promise<void> {
  const attachments: Attachment[] = [];
  if (msg.attachment_path) {
    try {
      const result = await invoke<ProcessFileResult>("process_file", {
        path: msg.attachment_path,
      });
      attachments.push({
        id: crypto.randomUUID(),
        name: result.name,
        content: result.content,
        size: result.size,
        fileType: toFileType(result.fileType),
      });
      // Clean up temp file after reading into memory
      invoke("delete_file", { path: msg.attachment_path }).catch(console.error);
    } catch (e) {
      console.error("[TG] Failed to process attachment:", e);
    }
  }

  lastFromTelegram = true;
  await sendMessage(msg.text, attachments.length > 0 ? attachments : undefined);
}

function getLastAssistantMessage(): string | null {
  const { messages } = useChatStore.getState();
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant" && messages[i].text) {
      const text = stripThinking(messages[i].text!);
      if (!text) continue;
      return text.length > 500 ? "..." + text.slice(-500) : text;
    }
  }
  return null;
}

function getCurrentAgentName(): string | null {
  const { agentId } = useChatStore.getState();
  if (!agentId) return null;
  const { agents } = useAgentStore.getState();
  const agent = agents.find((a) => a.id === agentId);
  return agent?.projectName ?? null;
}

async function handleRequestMenu(): Promise<void> {
  const { agents } = useAgentStore.getState();
  const { isThinking, messages } = useChatStore.getState();

  // Mark last assistant message as sent so streaming won't duplicate it
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant" && messages[i].text) {
      lastSentMessageId = messages[i].id;
      break;
    }
  }

  await invoke("telegram_send_menu", {
    agents: agents.map((a) => ({
      id: a.id,
      projectName: a.projectName,
    })),
    currentAgent: getCurrentAgentName(),
    lastMessage: getLastAssistantMessage(),
    isThinking,
  }).catch(console.error);
}

async function handleRequestAgents(): Promise<void> {
  const { agents } = useAgentStore.getState();
  const { agentId } = useChatStore.getState();

  await invoke("telegram_send_agents", {
    agents: agents.map((a) => ({
      id: a.id,
      projectName: a.projectName,
      active: a.id === agentId,
    })),
  }).catch(console.error);
}

async function handleRequestProjects(): Promise<void> {
  const { projects } = useProjectStore.getState();
  await invoke("telegram_send_projects", {
    projects: projects.map((p) => ({
      path: p.path,
      name: p.name,
    })),
  }).catch(console.error);
}

async function handleRequestSkills(): Promise<void> {
  const allFavorites = useSkillStore.getState().getFavorites();
  const agentState = useAgentStore.getState();
  const projectPath = agentState.agents.find(
    (a) => a.id === agentState.activeAgentId,
  )?.projectPath;
  const skills = allFavorites.filter(
    (s) => s.source.type !== "project" || s.source.projectPath === projectPath,
  );
  await invoke("telegram_send_skills", {
    skills: skills.map((s) => ({
      id: s.command,
      name: s.name,
    })),
  }).catch(console.error);
}

async function handleRequestStop(): Promise<void> {
  const { agents } = useAgentStore.getState();
  await invoke("telegram_send_stop", {
    agents: agents.map((a) => ({
      id: a.id,
      projectName: a.projectName,
    })),
  }).catch(console.error);
}

async function handleStopAgent(agentId: string): Promise<void> {
  const { agents } = useAgentStore.getState();
  const target = agents.find((a) => a.id === agentId);
  if (!target) return;

  const name = target.projectName;
  await useAgentStore.getState().removeAgent(agentId);
  await invoke("send_to_telegram", {
    text: `Stopped: ${name}`,
  }).catch(console.error);
}

async function handleSwitchAgent(agentId: string): Promise<void> {
  const { agents } = useAgentStore.getState();
  const target = agents.find((a) => a.id === agentId);
  if (!target) return;

  await useAgentStore.getState().setActiveAgent(agentId);
}

async function handleNewSession(
  projectPath?: string,
  projectName?: string,
): Promise<void> {
  if (!projectPath || !projectName) return;

  // Create agent and switch to it
  await useAgentStore.getState().createAgent(projectPath, projectName);
}
