import { useState, useCallback } from "react";
import { invoke } from "../lib/transport";
import { toFileType } from "../types/chat";
import type { Attachment } from "../types/chat";
import type { ProcessFileResult } from "../types/files";

export function useFileAttach() {
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  /** Process file paths via Rust backend and add as attachments */
  const processFromPaths = useCallback(async (paths: string[]) => {
    const results = await Promise.allSettled(
      paths.map((path) => invoke<ProcessFileResult>("process_file", { path })),
    );
    const newAttachments: Attachment[] = [];
    for (const r of results) {
      if (r.status === "fulfilled") {
        newAttachments.push({
          id: crypto.randomUUID(),
          name: r.value.name,
          content: r.value.content,
          size: r.value.size,
          fileType: toFileType(r.value.fileType),
        });
      } else {
        console.error("Failed to process file:", r.reason);
      }
    }
    if (newAttachments.length > 0) {
      setAttachments((prev) => [...prev, ...newAttachments]);
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
