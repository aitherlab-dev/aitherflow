/**
 * Stream handler for local model (Ollama) responses.
 * Listens to "local-model-stream" Tauri events and updates chatStore.
 * Uses RAF batching like chatStreamHandler.ts for smooth streaming.
 *
 * Side-effect module: importing this file registers the listener.
 */

import { listen } from "../lib/transport";
import { useChatStore } from "./chatStore";
import { persistMessages } from "./chatCrud";
import type { ChatMessage } from "../types/chat";

// ── Event types from Rust LocalModelEvent ──

interface StreamChunk {
  type: "StreamChunk";
  text: string;
}

interface StreamComplete {
  type: "StreamComplete";
  full_text: string;
  model: string;
  provider: string;
}

interface StreamError {
  type: "StreamError";
  error: string;
}

type LocalModelEvent = StreamChunk | StreamComplete | StreamError;

// ── RAF batching ──

let streamBuffer: string | null = null;
let streamBufferIsNew = false;
let streamBufferAgentId: string | null = null;
let rafId: number | null = null;

function flushStreamBuffer() {
  rafId = null;
  if (streamBuffer === null) return;

  const text = streamBuffer;
  const isNew = streamBufferIsNew;
  const bufferedAgentId = streamBufferAgentId;
  streamBuffer = null;
  streamBufferIsNew = false;
  streamBufferAgentId = null;

  const { getState: get, setState: set } = useChatStore;

  // If the active agent changed since buffering, discard the stale buffer
  if (bufferedAgentId && bufferedAgentId !== get().agentId) return;

  const existing = get().streamingMessage;

  if (!isNew && existing) {
    set({ streamingMessage: { ...existing, text: existing.text + text }, isThinking: true });
  } else if (isNew) {
    set({
      streamingMessage: {
        id: crypto.randomUUID(),
        role: "assistant",
        text,
        timestamp: Date.now(),
        isStreaming: true,
      },
      isThinking: true,
    });
  }
}

function cancelRaf() {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  if (streamBuffer !== null) {
    flushStreamBuffer();
  }
  streamBuffer = null;
  streamBufferIsNew = false;
  streamBufferAgentId = null;
}

// ── Event handler ──

function handleLocalModelEvent(e: LocalModelEvent) {
  const { getState: get, setState: set } = useChatStore;

  switch (e.type) {
    case "StreamChunk": {
      const isNew = !get().streamingMessage;
      streamBuffer = (streamBuffer ?? "") + e.text;
      streamBufferAgentId = get().agentId;
      if (isNew) streamBufferIsNew = true;
      if (rafId === null) {
        rafId = requestAnimationFrame(flushStreamBuffer);
      }
      break;
    }

    case "StreamComplete": {
      cancelRaf();
      const sm = get().streamingMessage;
      const completed: ChatMessage = {
        id: sm?.id ?? crypto.randomUUID(),
        role: "assistant",
        text: e.full_text,
        timestamp: sm?.timestamp ?? Date.now(),
        isStreaming: false,
        modelLabel: `${e.model} (${e.provider})`,
      };
      set((prev) => ({
        messages: [...prev.messages, completed],
        streamingMessage: null,
        isThinking: false,
      }));
      persistMessages().catch(console.error);
      break;
    }

    case "StreamError": {
      cancelRaf();
      const sm = get().streamingMessage;
      // If there was partial text, commit it with an error note
      if (sm && sm.text) {
        const errorMsg: ChatMessage = {
          ...sm,
          text: sm.text + `\n\n*Error: ${e.error}*`,
          isStreaming: false,
          modelLabel: "local",
        };
        set((prev) => ({
          messages: [...prev.messages, errorMsg],
          streamingMessage: null,
          isThinking: false,
          error: e.error,
        }));
      } else {
        set({ streamingMessage: null, isThinking: false, error: e.error });
      }
      break;
    }
  }
}

// ── Register listener (singleton, HMR-safe) ──

if (!(globalThis as Record<string, unknown>).__localModelStreamListenerRegistered) {
  (globalThis as Record<string, unknown>).__localModelStreamListenerRegistered = true;
  listen<LocalModelEvent>("local-model-stream", (event) =>
    handleLocalModelEvent(event.payload),
  ).catch(console.error);
}
