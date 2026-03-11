import { useState, useCallback, useEffect, useRef } from "react";
import { invoke, listen } from "../lib/transport";

type UnlistenFn = () => void;

export type VoiceState = "idle" | "recording" | "processing" | "streaming";

import type { AppSettings } from "../types/settings";

/**
 * @param onInsert — append text (Groq final result, Anthropic final on endpoint)
 * @param onReplace — replace all text in field (Anthropic interim updates)
 */
export function useVoice(
  onInsert: (text: string) => void,
  onReplace: (text: string) => void,
  getPrefix?: () => string,
) {
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const accumulatedRef = useRef("");
  const prefixRef = useRef(""); // text that was in the field before streaming started
  const providerRef = useRef("");
  const finalizedRef = useRef(""); // Deepgram finalized text
  const interimRef = useRef(""); // Deepgram current interim
  const unlistenersRef = useRef<UnlistenFn[]>([]);
  const busyRef = useRef(false); // guard against concurrent startStream
  const onInsertRef = useRef(onInsert);
  const onReplaceRef = useRef(onReplace);
  const getPrefixRef = useRef(getPrefix);
  onInsertRef.current = onInsert;
  onReplaceRef.current = onReplace;
  getPrefixRef.current = getPrefix;

  // Clean up event listeners on unmount
  useEffect(() => {
    return () => {
      for (const unlisten of unlistenersRef.current) {
        unlisten();
      }
    };
  }, []);

  const startGroq = useCallback(async () => {
    try {
      await invoke("voice_start");
      setVoiceState("recording");
    } catch (e) {
      console.error("Failed to start recording:", e);
    }
  }, []);

  const stopGroq = useCallback(async () => {
    setVoiceState("processing");
    try {
      const audioData = await invoke<number[]>("voice_stop");
      const settings = await invoke<AppSettings>("load_settings");

      const text = await invoke<string>("voice_transcribe", {
        audioData,
        language: settings.voiceLanguage,
        postProcess: settings.voicePostProcess ?? true,
        postModel: settings.voicePostModel || "llama-3.3-70b-versatile",
      });

      if (text.trim()) {
        onInsertRef.current(text.trim());
      }
    } catch (e) {
      console.error("Transcription failed:", e);
    } finally {
      setVoiceState("idle");
    }
  }, []);

  const cleanupStreamListeners = useCallback(() => {
    for (const unlisten of unlistenersRef.current) {
      unlisten();
    }
    unlistenersRef.current = [];
  }, []);

  const startStream = useCallback(async (provider: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      // Clean up any existing listeners first (prevents leak on double call)
      cleanupStreamListeners();

      const settings = await invoke<AppSettings>("load_settings");
      accumulatedRef.current = "";
      prefixRef.current = getPrefixRef.current?.() ?? "";
      providerRef.current = provider;

      // Set up event listeners before starting stream
      const unlisteners: UnlistenFn[] = [];

      if (provider === "deepgram") {
        // Deepgram sends full transcript per segment — replace, don't accumulate
        finalizedRef.current = "";
        interimRef.current = "";

        unlisteners.push(
          await listen<string>("voice-interim", (event) => {
            interimRef.current = event.payload;
            const combined = prefixRef.current
              ? prefixRef.current + " " + finalizedRef.current + interimRef.current
              : finalizedRef.current + interimRef.current;
            onReplaceRef.current(combined);
            accumulatedRef.current = finalizedRef.current + interimRef.current;
          })
        );

        unlisteners.push(
          await listen<void>("voice-final", () => {
            finalizedRef.current += interimRef.current + " ";
            interimRef.current = "";
          })
        );
      } else {
        // Anthropic sends incremental deltas — accumulate
        unlisteners.push(
          await listen<string>("voice-interim", (event) => {
            accumulatedRef.current += event.payload;
            const combined = prefixRef.current
              ? prefixRef.current + " " + accumulatedRef.current
              : accumulatedRef.current;
            onReplaceRef.current(combined);
          })
        );

        unlisteners.push(
          await listen<void>("voice-final", () => {
            accumulatedRef.current += " ";
          })
        );
      }

      unlisteners.push(
        await listen<string>("voice-error", (event) => {
          console.error("Voice stream error:", event.payload);
          cleanupStreamListeners();
          setVoiceState("idle");
        })
      );

      unlistenersRef.current = unlisteners;

      await invoke("voice_start_stream", {
        language: settings.voiceLanguage || "en",
        provider,
        apiKey: provider === "deepgram" ? settings.deepgramApiKey : "",
      });

      setVoiceState("streaming");
    } catch (e) {
      console.error("Failed to start voice stream:", e);
      cleanupStreamListeners();
      setVoiceState("idle");
    } finally {
      busyRef.current = false;
    }
  }, [cleanupStreamListeners]);

  const stopStream = useCallback(async () => {
    try {
      await invoke("voice_stop_stream");
    } catch (e) {
      console.error("Failed to stop voice stream:", e);
    } finally {
      accumulatedRef.current = "";
      prefixRef.current = "";
      cleanupStreamListeners();
      setVoiceState("idle");
    }
  }, [cleanupStreamListeners]);

  const toggleVoice = useCallback(async () => {
    if (voiceState === "idle") {
      const settings = await invoke<AppSettings>("load_settings");
      const provider = settings.voiceProvider || "groq";
      if (provider === "anthropic" || provider === "deepgram") {
        await startStream(provider);
      } else {
        await startGroq();
      }
    } else if (voiceState === "recording") {
      await stopGroq();
    } else if (voiceState === "streaming") {
      await stopStream();
    }
  }, [voiceState, startGroq, stopGroq, startStream, stopStream]);

  // Start voice (called on hotkey press)
  const startVoice = useCallback(async () => {
    if (voiceState !== "idle") return;
    const settings = await invoke<AppSettings>("load_settings");
    const provider = settings.voiceProvider || "groq";
    if (provider === "anthropic" || provider === "deepgram") {
      await startStream(provider);
    } else {
      await startGroq();
    }
  }, [voiceState, startGroq, startStream]);

  // Stop voice (called on hotkey release)
  const stopVoice = useCallback(async () => {
    if (voiceState === "recording") {
      await stopGroq();
    } else if (voiceState === "streaming") {
      await stopStream();
    }
  }, [voiceState, stopGroq, stopStream]);

  // Hotkey events: push-to-talk (start/stop) and toggle mode
  useEffect(() => {
    const onStart = () => { startVoice().catch(console.error); };
    const onStop = () => { stopVoice().catch(console.error); };
    const onToggle = () => { toggleVoice().catch(console.error); };
    window.addEventListener("hotkey:voiceStart", onStart);
    window.addEventListener("hotkey:voiceStop", onStop);
    window.addEventListener("hotkey:toggleVoice", onToggle);
    return () => {
      window.removeEventListener("hotkey:voiceStart", onStart);
      window.removeEventListener("hotkey:voiceStop", onStop);
      window.removeEventListener("hotkey:toggleVoice", onToggle);
    };
  }, [startVoice, stopVoice, toggleVoice]);

  // Reset accumulated text (call on send to avoid re-filling textarea)
  const resetStream = useCallback(() => {
    accumulatedRef.current = "";
    prefixRef.current = "";
    finalizedRef.current = "";
    interimRef.current = "";
  }, []);

  return { voiceState, toggleVoice, resetStream };
}
