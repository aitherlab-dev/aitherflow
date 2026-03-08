import { useCallback, type RefObject } from "react";
import { invoke } from "../lib/transport";
import type { Attachment } from "../types/chat";

/** Read a File (blob) into a data URI string */
function readFileAsDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

/**
 * Handles Ctrl+V paste events: images from clipboard, Wayland fallback via Rust.
 */
export function usePasteHandler(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  setText: (updater: string | ((prev: string) => string)) => void,
  addAttachment: (att: Attachment) => void,
) {
  return useCallback(async (e: React.ClipboardEvent) => {
    const cd = e.clipboardData;
    const types = Array.from(cd.types);

    // If text + image together (e.g. Telegram copy), prioritize text
    if (types.includes("text/plain") && types.some((t) => t.startsWith("image/"))) {
      return;
    }

    // Branch 1: explicit File with image MIME
    if (types.includes("Files")) {
      const files = cd.files;
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (file.type.startsWith("image/")) {
          e.preventDefault();
          try {
            const dataUri = await readFileAsDataUri(file);
            addAttachment({
              id: crypto.randomUUID(),
              name: file.name || "pasted-image.png",
              content: dataUri,
              size: file.size,
              fileType: "image",
            });
          } catch (err) {
            console.error("Failed to read pasted file:", err);
          }
          return;
        }
      }
    }

    // Branch 2: raw image type in clipboard items (screenshot)
    if (types.some((t) => t.startsWith("image/"))) {
      e.preventDefault();
      const items = cd.items;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (!file) continue;
          try {
            const dataUri = await readFileAsDataUri(file);
            addAttachment({
              id: crypto.randomUUID(),
              name: "screenshot.png",
              content: dataUri,
              size: file.size,
              fileType: "image",
            });
          } catch (err) {
            console.error("Failed to read pasted image:", err);
          }
          return;
        }
      }
    }

    // Branch 3: empty types (Wayland/WebKitGTK bug) — fallback to Rust clipboard
    if (types.length === 0) {
      e.preventDefault();

      // Try text first
      try {
        const clipText = await invoke<string>("read_clipboard_text");
        if (clipText) {
          const ta = textareaRef.current;
          if (ta) {
            const start = ta.selectionStart;
            const end = ta.selectionEnd;
            const current = ta.value;
            const before = current.slice(0, start);
            const after = current.slice(end);
            setText(before + clipText + after);
            requestAnimationFrame(() => {
              const pos = start + clipText.length;
              ta.selectionStart = pos;
              ta.selectionEnd = pos;
            });
          } else {
            setText((prev: string) => prev + clipText);
          }
          return;
        }
      } catch {
        // No text — try image below
      }

      // Try image
      try {
        const result = await invoke<{
          path: string;
          preview: string;
          size: number;
          filename: string;
        }>("read_clipboard_image");
        addAttachment({
          id: crypto.randomUUID(),
          name: result.filename,
          content: result.preview,
          size: result.size,
          fileType: "image",
        });
      } catch {
        // No image in clipboard either — nothing to paste
      }
      return;
    }

    // Default: let the browser handle text paste normally
  }, [textareaRef, setText, addAttachment]);
}
