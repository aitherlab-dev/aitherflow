/**
 * React hook that bridges Telegram bot with the app.
 *
 * - Polls incoming messages and routes them via telegramService
 * - Watches isThinking transitions to stream responses to Telegram
 * - Cleans up on unmount (fixes BUG-005: poll interval leak)
 */

import { useEffect, useRef } from "react";
import { useChatStore } from "../stores/chatStore";
import {
  pollAndHandle,
  startStreaming,
  finishStreaming,
  cleanupStreaming,
} from "../services/telegramService";

export function useTelegramBridge() {
  const prevIsThinking = useRef(false);
  const abortRef = useRef(false);

  // Poll incoming messages — fast (1s) when bot is running, slow (10s) when idle
  useEffect(() => {
    abortRef.current = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let botActive = false;

    const servicePromise = import("../services/telegramService");

    async function poll() {
      if (abortRef.current) return;
      try {
        const { isBotRunning } = await servicePromise;
        const running = await isBotRunning();
        botActive = running;
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

  // Stream agent responses to Telegram
  useEffect(() => {
    const unsub = useChatStore.subscribe((state) => {
      const wasThinking = prevIsThinking.current;
      prevIsThinking.current = state.isThinking;

      // Transition: idle -> thinking
      if (!wasThinking && state.isThinking) {
        startStreaming();
      }

      // Transition: thinking -> done
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
