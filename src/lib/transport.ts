/**
 * Transport layer — thin wrapper around Tauri APIs.
 *
 * Every store and component imports from here instead of @tauri-apps/* directly.
 */

import type { Window } from "@tauri-apps/api/window";

type DialogOptions = {
  directory?: boolean;
  multiple?: boolean;
  filters?: Array<{ name: string; extensions: string[] }>;
  title?: string;
};

// ── Lazy imports for Tauri APIs ──────────────────────────────────────

let _tauriInvoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;
let _tauriListen: ((event: string, handler: (e: { payload: unknown }) => void) => Promise<() => void>) | null = null;
let _tauriConvertFileSrc: ((path: string) => string) | null = null;
let _tauriOpenDialog: ((options: DialogOptions) => Promise<string | string[] | null>) | null = null;
let _tauriOpenUrl: ((url: string) => Promise<void>) | null = null;
let _tauriGetCurrentWindow: (() => Window) | null = null;

const tauriReady: Promise<void> = (async () => {
  const [core, event, dialog, opener, win] = await Promise.all([
    import("@tauri-apps/api/core"),
    import("@tauri-apps/api/event"),
    import("@tauri-apps/plugin-dialog"),
    import("@tauri-apps/plugin-opener"),
    import("@tauri-apps/api/window"),
  ]);
  _tauriInvoke = core.invoke;
  _tauriConvertFileSrc = core.convertFileSrc;
  _tauriListen = event.listen;
  _tauriOpenDialog = dialog.open;
  _tauriOpenUrl = opener.openUrl;
  _tauriGetCurrentWindow = win.getCurrentWindow;
})();

// ── Public API ─────────────────────────────────────────────────────

/** Call a backend command via Tauri invoke. */
export async function invoke<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  await tauriReady;
  return _tauriInvoke!(cmd, args) as Promise<T>;
}

/** Subscribe to backend events via Tauri listen. */
export async function listen<T = unknown>(
  event: string,
  handler: (event: { payload: T }) => void,
): Promise<() => void> {
  await tauriReady;
  return _tauriListen!(event, handler as (e: { payload: unknown }) => void);
}

/** Convert a filesystem path to a URL the webview can load. */
export async function convertFileSrc(path: string): Promise<string> {
  await tauriReady;
  return _tauriConvertFileSrc!(path);
}

/** Open a native file/folder dialog. */
export async function openDialog(options?: DialogOptions): Promise<string | string[] | null> {
  await tauriReady;
  return _tauriOpenDialog!(options ?? {});
}

/** Open a URL in the default browser. Only http/https allowed. */
export async function openUrl(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) {
    console.warn(`openUrl blocked non-http protocol: ${url}`);
    return;
  }
  await tauriReady;
  return _tauriOpenUrl!(url);
}

/** Get the current Tauri window handle. */
export async function getCurrentWindow(): Promise<Window> {
  await tauriReady;
  return _tauriGetCurrentWindow!();
}
