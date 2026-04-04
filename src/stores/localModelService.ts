/**
 * Local model & image generation service — sends prompts to Ollama and image gen
 * from the chat input bar (bypassing Claude CLI).
 */

import { invoke } from "../lib/transport";
import { useChatStore } from "./chatStore";
import { useConductorStore } from "./conductorStore";
import { persistMessages, loadChatList } from "./chatCrud";
import { generateTitle } from "./chatCrud";
import type { ChatMeta } from "./chatStore";
import type { ChatMessage, Attachment } from "../types/chat";

// ── Build message content: plain text or multimodal parts ──

type TextPart = { type: "text"; text: string };
type ImageUrlPart = { type: "image_url"; image_url: { url: string } };
type ContentPart = TextPart | ImageUrlPart;

function buildContent(text: string, attachments?: Attachment[]): string | ContentPart[] {
  const images = attachments?.filter((a) => a.fileType === "image") ?? [];
  const textFiles = attachments?.filter((a) => a.fileType === "text") ?? [];

  // Prepend text file contents to the prompt
  let fullText = "";
  for (const tf of textFiles) {
    fullText += `File: ${tf.name}\n\`\`\`\n${tf.content}\n\`\`\`\n\n`;
  }
  fullText += text;

  if (images.length === 0) return fullText;

  const parts: ContentPart[] = [{ type: "text", text: fullText }];
  for (const img of images) {
    parts.push({ type: "image_url", image_url: { url: img.content } });
  }
  return parts;
}

// ── Ensure chat exists (lazy creation like sendMessage) ──

let isCreatingChat = false;

async function ensureChat(): Promise<string | null> {
  const state = useChatStore.getState();
  let chatId = state.currentChatId;
  if (chatId) return chatId;
  if (isCreatingChat) return null;

  isCreatingChat = true;
  try {
    const title = generateTitle("Local model chat");
    const chat = await invoke<ChatMeta>("create_chat", {
      projectPath: state.projectPath,
      agentId: state.agentId,
      title,
    });
    chatId = chat.id;
    useChatStore.setState({ currentChatId: chatId });
    // Transfer pending local model flag to the new chat
    const conductor = useConductorStore.getState();
    if (conductor.pendingLocalModel) {
      conductor.toggleLocalModel(chatId);
      useConductorStore.setState({ pendingLocalModel: false });
    }
    loadChatList().catch(console.error);
    return chatId;
  } finally {
    isCreatingChat = false;
  }
}

// ── Send prompt to local model (Ollama) with streaming ──

export async function sendToLocalModel(text: string, allAttachments?: Attachment[]) {
  const state = useChatStore.getState();
  if (state.isThinking) return;

  // Add user message
  const userMsg: ChatMessage = {
    id: crypto.randomUUID(),
    role: "user",
    text,
    timestamp: Date.now(),
    attachments: allAttachments && allAttachments.length > 0 ? allAttachments : undefined,
  };
  useChatStore.setState((prev) => ({
    messages: [...prev.messages, userMsg],
    error: null,
    isThinking: true,
  }));

  const chatId = await ensureChat();
  if (!chatId) {
    useChatStore.setState({ isThinking: false, error: "Failed to create chat" });
    return;
  }

  persistMessages().catch(console.error);

  try {
    // Load Ollama config to get default model
    const config = await invoke<{ providers: Array<{ provider: string; defaultModel: string; enabled: boolean }> }>(
      "external_models_load_config",
    );
    const ollama = config.providers.find((p) => p.provider === "ollama");
    const model = ollama?.defaultModel || "llama3";

    // Build full conversation history so the model has context
    const currentMessages = useChatStore.getState().messages;
    const history: Array<{ role: string; content: string | ContentPart[] }> = [];
    for (const msg of currentMessages) {
      if (msg.role !== "user" && msg.role !== "assistant") continue;
      // Last message is the new one — use buildContent for attachments
      if (msg.id === userMsg.id) {
        history.push({ role: "user", content: buildContent(text, allAttachments) });
      } else {
        history.push({ role: msg.role, content: msg.text });
      }
    }

    // Call streaming — events handled by localModelStreamHandler
    await invoke("external_models_call_stream", {
      provider: "ollama",
      model,
      messages: history,
      maxTokens: null,
    });
  } catch (e) {
    console.error("[sendToLocalModel] Failed:", e);
    useChatStore.setState({ error: `Local model error: ${e}`, isThinking: false });
  }
}

// ── Send prompt to image generation ──

export async function sendToImageGen(text: string) {
  const state = useChatStore.getState();
  if (state.isThinking) return;

  // Add user message
  const userMsg: ChatMessage = {
    id: crypto.randomUUID(),
    role: "user",
    text,
    timestamp: Date.now(),
  };
  useChatStore.setState((prev) => ({
    messages: [...prev.messages, userMsg],
    error: null,
    isThinking: true,
  }));

  const chatId = await ensureChat();
  if (!chatId) {
    useChatStore.setState({ isThinking: false, error: "Failed to create chat" });
    return;
  }

  persistMessages().catch(console.error);

  try {
    // Call image gen — returns the file path
    const filePath = await invoke<string>("image_gen_generate", { prompt: text });

    // Create assistant message with the image path so ImageResult renders it
    const assistantMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      text: `Generated image:\n\n${filePath}`,
      timestamp: Date.now(),
      modelLabel: "Image Gen",
    };
    useChatStore.setState((prev) => ({
      messages: [...prev.messages, assistantMsg],
      isThinking: false,
    }));
    persistMessages().catch(console.error);
  } catch (e) {
    console.error("[sendToImageGen] Failed:", e);
    useChatStore.setState({ error: `Image gen error: ${e}`, isThinking: false });
  }
}
