/**
 * Local model & image generation service — sends prompts to Ollama and image gen
 * from the chat input bar (bypassing Claude CLI).
 */

import { invoke } from "../lib/transport";
import { useChatStore } from "./chatStore";
import { persistMessages, loadChatList } from "./chatCrud";
import { generateTitle } from "./chatCrud";
import type { ChatMeta } from "./chatStore";
import type { ChatMessage } from "../types/chat";

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
    loadChatList().catch(console.error);
    return chatId;
  } finally {
    isCreatingChat = false;
  }
}

// ── Send prompt to local model (Ollama) with streaming ──

export async function sendToLocalModel(text: string) {
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

  try {
    // Load Ollama config to get default model
    const config = await invoke<{ providers: Array<{ provider: string; defaultModel: string; enabled: boolean }> }>(
      "external_models_load_config",
    );
    const ollama = config.providers.find((p) => p.provider === "ollama");
    const model = ollama?.defaultModel || "llama3";

    // Call streaming — events handled by localModelStreamHandler
    await invoke("external_models_call_stream", {
      provider: "ollama",
      model,
      messages: [{ role: "user", content: text }],
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
