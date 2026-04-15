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
import { launchTeam } from "../stores/agentStore";
import { sendMessage, resumeCurrentChat } from "../stores/chatService";
import { switchChat } from "../stores/chatCrud";
import { toFileType } from "../types/chat";
import type { Attachment, ChatMessage } from "../types/chat";
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
  reconnecting: boolean;
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
    case "request_workspace":
      await handleRequestWorkspace();
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
    case "request_team":
      await handleRequestTeam();
      break;
    case "launch_team":
      await handleLaunchTeam(msg.text, msg.project_path, msg.project_name);
      break;
    case "request_resume":
      await handleRequestResume();
      break;
    case "request_chats":
      await handleRequestChats();
      break;
    case "request_history":
      await handleRequestHistory();
      break;
    case "switch_chat":
      await handleSwitchChat(msg.text);
      break;
    case "resume_project":
      await handleResumeProject(msg.project_path, msg.project_name);
      break;
    case "resume_chat":
      await handleResumeChat(msg.text, msg.project_path, msg.project_name);
      break;
  }
}

async function handleText(msg: TgIncoming): Promise<void> {
  const { agents } = useAgentStore.getState();
  if (agents.length === 0) {
    await invoke("send_to_telegram", {
      text: "No active agents. Start a session first.",
    }).catch(console.error);
    return;
  }

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

function getLastUserMessage(): string | null {
  const { messages } = useChatStore.getState();
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && messages[i].text) {
      const text = messages[i].text!;
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
    lastUserMessage: getLastUserMessage(),
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
  const all = useSkillStore.getState().allSkills();
  const agentState = useAgentStore.getState();
  const projectPath = agentState.agents.find(
    (a) => a.id === agentState.activeAgentId,
  )?.projectPath;
  const skills = all.filter(
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

/** Send last N messages from current chat state to Telegram */
async function sendLastMessages(msgs: ChatMessage[], count: number): Promise<void> {
  const last = msgs.filter((m) => m.text).slice(-count);
  for (const m of last) {
    const prefix = m.role === "user" ? "\u{1F464} User" : "\u{1F916} Assistant";
    const text = stripThinking(m.text!);
    if (text) {
      const truncated = text.length > 4000 ? "..." + text.slice(-4000) : text;
      await invoke("send_to_telegram", { text: `${prefix}:\n${truncated}` }).catch(console.error);
    }
  }
}

async function handleSwitchAgent(agentId: string): Promise<void> {
  const { agents } = useAgentStore.getState();
  const target = agents.find((a) => a.id === agentId);
  if (!target) return;

  await useAgentStore.getState().setActiveAgent(agentId);

  // After switching, chatStore holds the target agent's full current chat —
  // read from there (not from the background agentStates snapshot, which may
  // be stale or contain only messages the user wrote through Telegram).
  const messages = useChatStore.getState().messages;
  await sendLastMessages(messages, 4);
}

async function handleRequestWorkspace(): Promise<void> {
  const { projects } = useProjectStore.getState();
  // Find workspace by path (name may be renamed by user)
  const workspace = projects.find((p) => p.path.endsWith("/Workspace")) ?? projects[0];
  if (!workspace) {
    await invoke("send_to_telegram", {
      text: "No projects configured",
    }).catch(console.error);
    return;
  }

  // Check if there's already an agent running in Workspace
  const { agents, setActiveAgent } = useAgentStore.getState();
  const existingAgent = agents.find((a) => a.projectPath === workspace.path);
  if (existingAgent) {
    // Switch to existing workspace agent
    await setActiveAgent(existingAgent.id);
    await invoke("send_to_telegram", {
      text: `Switched to Workspace agent`,
    }).catch(console.error);
    return;
  }

  // Create new agent in Workspace
  await useAgentStore.getState().createAgent(workspace.path, workspace.name);
  await invoke("send_to_telegram", {
    text: `Workspace agent started`,
  }).catch(console.error);
}

async function handleNewSession(
  projectPath?: string,
  projectName?: string,
): Promise<void> {
  if (!projectPath || !projectName) return;

  // Create agent and switch to it
  await useAgentStore.getState().createAgent(projectPath, projectName);
}

async function handleRequestTeam(): Promise<void> {
  const { projects } = useProjectStore.getState();
  await invoke("telegram_send_team_projects", {
    projects: projects.map((p) => ({
      path: p.path,
      name: p.name,
    })),
  }).catch(console.error);
}

async function handleLaunchTeam(
  rolesJson: string,
  projectPath?: string,
  _projectName?: string,
): Promise<void> {
  if (!projectPath) return;

  try {
    const { roles } = JSON.parse(rolesJson) as { roles: string[] };
    if (!roles?.length) return;

    await launchTeam(projectPath, roles);

    await invoke("send_to_telegram", {
      text: `Team launched (${roles.length} agents)`,
    }).catch(console.error);
  } catch (e) {
    console.error("[TG] launch team error:", e);
    await invoke("send_to_telegram", {
      text: `Team launch failed: ${e}`,
    }).catch(console.error);
  }
}

async function handleRequestResume(): Promise<void> {
  interface RecentChat {
    id: string;
    title: string;
    customTitle: string | null;
    projectPath: string;
    sessionId: string | null;
  }
  let chats: RecentChat[];
  try {
    chats = await invoke<RecentChat[]>("list_recent_chats_all", { limit: 12 });
  } catch (e) {
    console.error("[TG] list_recent_chats_all:", e);
    await invoke("send_to_telegram", { text: "Failed to load chats" }).catch(console.error);
    return;
  }

  if (chats.length === 0) {
    await invoke("send_to_telegram", { text: "No chats yet" }).catch(console.error);
    return;
  }

  const { projects } = useProjectStore.getState();
  const payload = chats.map((c) => {
    const project = projects.find((p) => p.path === c.projectPath);
    const name = project?.name ?? c.projectPath.split("/").pop() ?? c.projectPath;
    return {
      id: c.id,
      title: c.customTitle || c.title,
      projectPath: c.projectPath,
      projectName: name,
    };
  });
  await invoke("telegram_send_recent_chats", { chats: payload }).catch(console.error);
}

async function handleResumeProject(projectPath?: string, projectName?: string): Promise<void> {
  if (!projectPath || !projectName) return;

  // 1. Find or create agent in this project
  const { agents, setActiveAgent, createAgent } = useAgentStore.getState();
  const existing = agents.find((a) => a.projectPath === projectPath);
  if (existing) {
    await setActiveAgent(existing.id);
  } else {
    await createAgent(projectPath, projectName);
  }

  // 2. Load chats for this project sorted by activity (mtime)
  interface ChatMetaLite {
    id: string;
    title: string;
    sessionId: string | null;
    customTitle: string | null;
  }
  let chats: ChatMetaLite[];
  try {
    chats = await invoke<ChatMetaLite[]>("list_chats_by_activity", { projectPath });
  } catch (e) {
    console.error("[TG] list_chats_by_activity:", e);
    await invoke("send_to_telegram", { text: "Failed to load chats" }).catch(console.error);
    return;
  }

  if (chats.length === 0) {
    await invoke("send_to_telegram", { text: `No chats in ${projectName}` }).catch(console.error);
    return;
  }

  const latest = chats[0];
  if (!latest.sessionId) {
    await invoke("send_to_telegram", { text: "Latest chat has no session to resume" }).catch(console.error);
    return;
  }

  // 3. Switch to that chat (loads messages into store)
  await switchChat(latest.id);

  // 4. Start CLI with --resume
  await resumeCurrentChat();

  const title = latest.customTitle || latest.title;
  await invoke("send_to_telegram", { text: `Resumed: ${title}` }).catch(console.error);

  // 5. Send last 4 messages
  await sendLastMessages(useChatStore.getState().messages, 4);
}

/** Resume a specific chat (possibly cross-project) from the Telegram recent-chats picker */
async function handleResumeChat(
  chatId: string,
  projectPath?: string,
  projectName?: string,
): Promise<void> {
  if (!chatId || !projectPath || !projectName) return;

  // 1. Find or create agent for this project
  const { agents, setActiveAgent, createAgent } = useAgentStore.getState();
  const existing = agents.find((a) => a.projectPath === projectPath);
  if (existing) {
    await setActiveAgent(existing.id);
  } else {
    await createAgent(projectPath, projectName);
  }

  // 2. Switch to that chat (loads messages into store)
  try {
    await switchChat(chatId);
  } catch (e) {
    console.error("[TG] switchChat:", e);
    await invoke("send_to_telegram", { text: "Failed to load chat" }).catch(console.error);
    return;
  }

  // 3. Start CLI with --resume (if sessionId exists)
  await resumeCurrentChat();

  const { chatList } = useChatStore.getState();
  const chat = chatList.find((c) => c.id === chatId);
  const title = chat?.customTitle || chat?.title || "Chat";
  await invoke("send_to_telegram", { text: `Resumed: ${title}` }).catch(console.error);

  // 4. Send last 4 messages
  await sendLastMessages(useChatStore.getState().messages, 4);
}

async function handleRequestChats(): Promise<void> {
  const { projectPath } = useChatStore.getState();
  if (!projectPath) {
    await invoke("send_to_telegram", { text: "No active project" }).catch(console.error);
    return;
  }

  interface ChatMetaLite {
    id: string;
    title: string;
    customTitle: string | null;
  }
  let chats: ChatMetaLite[];
  try {
    chats = await invoke<ChatMetaLite[]>("list_chats_by_activity", { projectPath });
  } catch (e) {
    console.error("[TG] list_chats_by_activity:", e);
    await invoke("send_to_telegram", { text: "Failed to load chats" }).catch(console.error);
    return;
  }

  if (chats.length === 0) {
    await invoke("send_to_telegram", { text: "No chats" }).catch(console.error);
    return;
  }

  const payload = chats.slice(0, 10).map((c) => ({
    id: c.id,
    title: c.customTitle || c.title,
  }));
  await invoke("telegram_send_chats", { chats: payload }).catch(console.error);
}

async function handleRequestHistory(): Promise<void> {
  const { messages, projectPath } = useChatStore.getState();
  if (!projectPath) {
    await invoke("send_to_telegram", { text: "No active agent" }).catch(console.error);
    return;
  }
  if (messages.length === 0) {
    await invoke("send_to_telegram", { text: "No messages in current chat" }).catch(console.error);
    return;
  }
  await sendLastMessages(messages, 6);
}

async function handleSwitchChat(chatId: string): Promise<void> {
  await switchChat(chatId);
  await resumeCurrentChat();

  const { chatList, messages } = useChatStore.getState();
  const chat = chatList.find((c) => c.id === chatId);
  const title = chat?.customTitle || chat?.title || "Chat";
  await invoke("send_to_telegram", { text: `Switched to: ${title}` }).catch(console.error);

  await sendLastMessages(messages, 4);
}
