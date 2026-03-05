import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "../lib/transport";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

export type VoiceState = "idle" | "recording" | "processing" | "streaming";

interface AppSettings {
  groqApiKey: string;
  voiceLanguage: string;
  voicePostProcess: boolean;
  voicePostModel: string;
  voiceProvider: string;
  deepgramApiKey: string;
}

/**
 * @param onInsert — append text (Groq final result, Anthropic final on endpoint)
 * @param onReplace — replace all text in field (Anthropic interim updates)
 */
export function useVoice(
  onInsert: (text: string) => void,
  onReplace: (text: string) => void,
) {
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const accumulatedRef = useRef("");
  const prefixRef = useRef(""); // text that was in the field before streaming started
  const providerRef = useRef("");
  const finalizedRef = useRef(""); // Deepgram finalized text
  const interimRef = useRef(""); // Deepgram current interim
  const unlistenersRef = useRef<UnlistenFn[]>([]);

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
        apiKey: settings.groqApiKey,
        language: settings.voiceLanguage,
        postProcess: settings.voicePostProcess ?? true,
        postModel: settings.voicePostModel || "llama-3.3-70b-versatile",
      });

      if (text.trim()) {
        onInsert(text.trim());
      }
    } catch (e) {
      console.error("Transcription failed:", e);
    } finally {
      setVoiceState("idle");
    }
  }, [onInsert]);

  const startStream = useCallback(async (provider: string) => {
    try {
      const settings = await invoke<AppSettings>("load_settings");
      accumulatedRef.current = "";
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
            onReplace(combined);
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
            onReplace(combined);
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
    }
  }, [onReplace]);

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
  }, []);

  const cleanupStreamListeners = useCallback(() => {
    for (const unlisten of unlistenersRef.current) {
      unlisten();
    }
    unlistenersRef.current = [];
  }, []);

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

  // Ctrl+` hotkey — toggle voice on/off
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.code === "Backquote") {
        e.preventDefault();
        toggleVoice();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [voiceState, toggleVoice]);

  // Reset accumulated text (call on send to avoid re-filling textarea)
  const resetStream = useCallback(() => {
    accumulatedRef.current = "";
    prefixRef.current = "";
    finalizedRef.current = "";
    interimRef.current = "";
  }, []);

  return { voiceState, toggleVoice, resetStream };
}
