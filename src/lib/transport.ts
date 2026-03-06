/**
 * Transport layer — thin wrapper around Tauri APIs.
 *
 * Every store and component imports from here instead of @tauri-apps/* directly.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Lazy imports for Tauri APIs ──────────────────────────────────────

let _tauriInvoke: ((cmd: string, args?: Record<string, unknown>) => Promise<any>) | null = null;
let _tauriListen: ((event: string, handler: (e: any) => void) => Promise<() => void>) | null = null;
let _tauriConvertFileSrc: ((path: string) => string) | null = null;
let _tauriOpenDialog: ((options: any) => Promise<any>) | null = null;
let _tauriOpenUrl: ((url: string) => Promise<void>) | null = null;
let _tauriGetCurrentWindow: (() => any) | null = null;

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
  return _tauriInvoke!(cmd, args);
}

/** Subscribe to backend events via Tauri listen. */
export async function listen<T = unknown>(
  event: string,
  handler: (event: { payload: T }) => void,
): Promise<() => void> {
  await tauriReady;
  return _tauriListen!(event, handler);
}

/** Convert a filesystem path to a URL the webview can load. */
export function convertFileSrc(path: string): string {
  if (_tauriConvertFileSrc) {
    return _tauriConvertFileSrc(path);
  }
  return path;
}

/** Open a native file/folder dialog. */
export async function openDialog(options?: {
  directory?: boolean;
  multiple?: boolean;
  filters?: Array<{ name: string; extensions: string[] }>;
  title?: string;
}): Promise<string | string[] | null> {
  await tauriReady;
  return _tauriOpenDialog!(options ?? {});
}

/** Open a URL in the default browser. */
export async function openUrl(url: string): Promise<void> {
  await tauriReady;
  return _tauriOpenUrl!(url);
}

/** Get the current Tauri window handle. */
export async function getCurrentWindow(): Promise<any | null> {
  await tauriReady;
  return _tauriGetCurrentWindow!();
}
