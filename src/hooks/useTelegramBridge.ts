import { useEffect, useRef } from "react";
import { invoke } from "../lib/transport";
import { useChatStore } from "../stores/chatStore";
import { useAgentStore } from "../stores/agentStore";
import type { Attachment } from "../types/chat";

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

interface ProcessFileResult {
  name: string;
  content: string;
  size: number;
  fileType: string;
}

const TELEGRAM_TAG = "[TG] ";

/** Minimum interval between Telegram message edits (ms) */
const STREAM_THROTTLE_MS = 2000;

/**
 * Bridge between Telegram bot and agent.
 * Polls incoming messages, routes them to chatStore,
 * and streams agent responses back to Telegram via editMessageText.
 */
export function useTelegramBridge() {
  const lastFromTelegram = useRef(false);
  const prevIsThinking = useRef(false);

  // Streaming state
  const streamMsgId = useRef<number | null>(null);
  const lastEditTime = useRef(0);
  const lastEditedText = useRef("");
  const streamTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    async function poll() {
      let status: TelegramStatus;
      try {
        status = await invoke<TelegramStatus>("get_telegram_status");
      } catch {
        return;
      }
      if (!status.running) return;

      let messages: TgIncoming[];
      try {
        messages = await invoke<TgIncoming[]>("poll_telegram_messages");
      } catch {
        return;
      }

      for (const msg of messages) {
        await handleIncoming(msg);
      }
    }

    async function handleIncoming(msg: TgIncoming) {
      const chat = useChatStore.getState();

      switch (msg.kind) {
        case "text": {
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
                fileType: result.fileType as "image" | "text",
              });
            } catch (e) {
              console.error("[TG] Failed to process attachment:", e);
            }
          }

          lastFromTelegram.current = true;
          await chat.sendMessage(msg.text, attachments.length > 0 ? attachments : undefined);
          break;
        }

        case "switch_project": {
          if (msg.project_path) {
            const agents = useAgentStore.getState().agents;
            const target = agents.find((a) => a.projectPath === msg.project_path);
            if (target) {
              await useAgentStore.getState().setActiveAgent(target.id);
            }
          }
          break;
        }

        case "new_chat":
          await chat.newChat();
          break;

        case "load_chat":
          if (msg.text) {
            const chatList = chat.chatList;
            const target = chatList.find((c) => c.sessionId === msg.text);
            if (target) {
              await chat.switchChat(target.id);
            }
          }
          break;
      }
    }

    timer = setInterval(poll, 1000);
    return () => {
      if (timer) clearInterval(timer);
    };
  }, []);

  // Stream agent responses to Telegram
  useEffect(() => {
    const unsub = useChatStore.subscribe((state) => {
      const wasThinking = prevIsThinking.current;
      prevIsThinking.current = state.isThinking;

      if (!lastFromTelegram.current) return;

      // Transition: idle → thinking — send initial "..." message
      if (!wasThinking && state.isThinking) {
        streamMsgId.current = null;
        lastEditedText.current = "";
        lastEditTime.current = 0;

        invoke<number>("telegram_stream_start")
          .then((msgId) => {
            streamMsgId.current = msgId;
          })
          .catch(console.error);

        // Start periodic stream updates
        if (streamTimer.current) clearInterval(streamTimer.current);
        streamTimer.current = setInterval(() => {
          if (!streamMsgId.current) return;
          const s = useChatStore.getState();
          if (!s.isThinking) return;

          // Find current assistant text
          for (let i = s.messages.length - 1; i >= 0; i--) {
            const m = s.messages[i];
            if (m.role === "assistant" && m.text) {
              const text = m.text.replace(TELEGRAM_TAG, "").trim();
              // Only edit if text actually changed
              if (text && text !== lastEditedText.current) {
                // Truncate to 4000 chars for Telegram limit
                const truncated = text.length > 4000 ? text.slice(0, 4000) + "..." : text;
                lastEditedText.current = text;
                lastEditTime.current = Date.now();
                invoke("telegram_stream_update", {
                  messageId: streamMsgId.current,
                  text: truncated,
                }).catch(console.error);
              }
              break;
            }
          }
        }, STREAM_THROTTLE_MS);
      }

      // Transition: thinking → done — final update
      if (wasThinking && !state.isThinking) {
        // Stop stream timer
        if (streamTimer.current) {
          clearInterval(streamTimer.current);
          streamTimer.current = null;
        }

        lastFromTelegram.current = false;

        // Final update with complete text
        for (let i = state.messages.length - 1; i >= 0; i--) {
          const m = state.messages[i];
          if (m.role === "assistant" && m.text) {
            const text = m.text.replace(TELEGRAM_TAG, "").trim();
            if (text) {
              if (streamMsgId.current && text.length <= 4000) {
                // Edit the streaming message with final text
                invoke("telegram_stream_update", {
                  messageId: streamMsgId.current,
                  text,
                }).catch(console.error);
              } else {
                // Text too long or no stream msg — send as new message(s)
                invoke("send_to_telegram", { text }).catch(console.error);
              }
            }
            break;
          }
        }

        streamMsgId.current = null;
        lastEditedText.current = "";
      }
    });
    return () => {
      unsub();
      if (streamTimer.current) {
        clearInterval(streamTimer.current);
        streamTimer.current = null;
      }
    };
  }, []);

  // Sync current project to Telegram bot state
  useEffect(() => {
    return useChatStore.subscribe(
      (state) => {
        invoke("telegram_set_project", {
          projectName: state.projectName || null,
          projectPath: state.projectPath || null,
        }).catch(console.error);
      },
    );
  }, []);
}
