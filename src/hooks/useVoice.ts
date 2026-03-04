import { useState, useCallback, useEffect } from "react";
import { invoke } from "../lib/transport";

export type VoiceState = "idle" | "recording" | "processing";

interface AppSettings {
  groqApiKey: string;
  voiceLanguage: string;
  voicePostProcess: boolean;
  voicePostModel: string;
}

export function useVoice(onInsert: (text: string) => void) {
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");

  const startRecording = useCallback(async () => {
    try {
      await invoke("voice_start");
      setVoiceState("recording");
    } catch (e) {
      console.error("Failed to start recording:", e);
    }
  }, []);

  const stopAndTranscribe = useCallback(async () => {
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

  const toggleVoice = useCallback(async () => {
    if (voiceState === "idle") {
      await startRecording();
    } else if (voiceState === "recording") {
      await stopAndTranscribe();
    }
  }, [voiceState, startRecording, stopAndTranscribe]);

  // Ctrl+` hotkey — same as button: insert into field
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.code === "Backquote") {
        e.preventDefault();
        if (voiceState === "idle") {
          startRecording();
        } else if (voiceState === "recording") {
          stopAndTranscribe();
        }
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [voiceState, startRecording, stopAndTranscribe]);

  return { voiceState, toggleVoice };
}
