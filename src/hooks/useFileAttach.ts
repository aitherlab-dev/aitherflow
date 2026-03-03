import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Attachment } from "../types/chat";

interface ProcessFileResult {
  name: string;
  content: string;
  size: number;
  fileType: string;
}

export function useFileAttach() {
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  /** Process file paths via Rust backend and add as attachments */
  const processFromPaths = useCallback(async (paths: string[]) => {
    for (const path of paths) {
      try {
        const result = await invoke<ProcessFileResult>("process_file", { path });
        const att: Attachment = {
          id: crypto.randomUUID(),
          name: result.name,
          content: result.content,
          size: result.size,
          fileType: result.fileType as "image" | "text",
        };
        setAttachments((prev) => [...prev, att]);
      } catch (e) {
        console.error("Failed to process file:", e);
      }
    }
  }, []);

  /** Add a pre-built attachment (e.g. from clipboard paste) */
  const addAttachment = useCallback((att: Attachment) => {
    setAttachments((prev) => [...prev, att]);
  }, []);

  /** Remove attachment by id, cleaning up temp files if needed */
  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const removed = prev.find((a) => a.id === id);
      if (removed && removed.name.startsWith("paste-")) {
        invoke("cleanup_temp_file", {
          path: `/tmp/aither-flow/${removed.name}`,
        }).catch(console.error);
      }
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  /** Clear all attachments */
  const clearAttachments = useCallback(() => {
    setAttachments([]);
  }, []);

  return { attachments, processFromPaths, addAttachment, removeAttachment, clearAttachments };
}
