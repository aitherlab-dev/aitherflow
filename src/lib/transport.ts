/**
 * Transport abstraction layer.
 *
 * Detects whether the app runs inside Tauri (desktop) or in a plain browser
 * and routes every backend call through the appropriate channel:
 *   • Tauri  → invoke() / listen() / plugin APIs
 *   • Browser → REST fetch() / WebSocket
 *
 * Every store and component imports from here instead of @tauri-apps/* directly.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Environment detection ──────────────────────────────────────────

const isTauri = typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;

// ── Lazy imports for Tauri APIs (only loaded in Tauri) ─────────────

let _tauriInvoke: ((cmd: string, args?: Record<string, unknown>) => Promise<any>) | null = null;
let _tauriListen: ((event: string, handler: (e: any) => void) => Promise<() => void>) | null = null;
let _tauriConvertFileSrc: ((path: string) => string) | null = null;
let _tauriOpenDialog: ((options: any) => Promise<any>) | null = null;
let _tauriOpenUrl: ((url: string) => Promise<void>) | null = null;
let _tauriGetCurrentWindow: (() => any) | null = null;

const tauriReady: Promise<void> = isTauri
  ? (async () => {
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
    })()
  : Promise.resolve();

// ── Browser WebSocket (singleton, lazy) ────────────────────────────

let _ws: WebSocket | null = null;
let _wsReady: Promise<void> | null = null;
const _wsListeners = new Map<string, Set<(payload: any) => void>>();

function getWebServerUrl(): string {
  // In browser mode the page is served by Axum, so same origin
  return window.location.origin;
}

function ensureWebSocket(): Promise<void> {
  if (_wsReady) return _wsReady;

  _wsReady = new Promise<void>((resolve, reject) => {
    const base = getWebServerUrl().replace(/^http/, "ws");
    // Cookie is sent automatically by the browser for same-origin WS
    _ws = new WebSocket(`${base}/ws`);

    _ws.onopen = () => resolve();
    _ws.onerror = () => reject(new Error("WebSocket connection failed"));

    _ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        const channel: string = data.channel;
        const payload = data.payload;
        const handlers = _wsListeners.get(channel);
        if (handlers) {
          for (const fn of handlers) fn({ payload });
        }
      } catch {
        console.error("WebSocket message parse error");
      }
    };

    _ws.onclose = () => {
      _ws = null;
      _wsReady = null;
    };
  });

  return _wsReady;
}

// ── Public API ─────────────────────────────────────────────────────

/** Call a backend command. In Tauri → invoke(). In browser → POST /api/{cmd}. */
export async function invoke<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (isTauri) {
    await tauriReady;
    return _tauriInvoke!(cmd, args);
  }

  const url = `${getWebServerUrl()}/api/${cmd}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: args ? JSON.stringify(args) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch((e) => { console.error(e); return res.statusText; });
    throw new Error(text);
  }

  const text = await res.text();
  return text ? JSON.parse(text) : (undefined as T);
}

/** Subscribe to backend events. In Tauri → listen(). In browser → WebSocket. */
export async function listen<T = unknown>(
  event: string,
  handler: (event: { payload: T }) => void,
): Promise<() => void> {
  if (isTauri) {
    await tauriReady;
    return _tauriListen!(event, handler);
  }

  await ensureWebSocket();
  let handlers = _wsListeners.get(event);
  if (!handlers) {
    handlers = new Set();
    _wsListeners.set(event, handlers);
  }
  handlers.add(handler);

  return () => {
    handlers!.delete(handler);
    if (handlers!.size === 0) _wsListeners.delete(event);
  };
}

/** Convert a filesystem path to a URL the webview/browser can load. */
export function convertFileSrc(path: string): string {
  if (isTauri && _tauriConvertFileSrc) {
    return _tauriConvertFileSrc(path);
  }
  // Cookie is sent automatically for same-origin requests
  return `${getWebServerUrl()}/api/file?path=${encodeURIComponent(path)}`;
}

/** Open a native file/folder dialog. In browser → <input type="file">. */
export async function openDialog(options?: {
  directory?: boolean;
  multiple?: boolean;
  filters?: Array<{ name: string; extensions: string[] }>;
  title?: string;
}): Promise<string | string[] | null> {
  if (isTauri) {
    await tauriReady;
    return _tauriOpenDialog!(options ?? {});
  }

  // Browser fallback: hidden <input type="file">
  return new Promise((resolve) => {
    if (options?.directory) {
      // Browsers can't pick directories reliably — return null
      resolve(null);
      return;
    }

    const input = document.createElement("input");
    input.type = "file";
    if (options?.multiple) input.multiple = true;
    if (options?.filters) {
      input.accept = options.filters
        .flatMap((f) => f.extensions.map((e) => `.${e}`))
        .join(",");
    }

    input.onchange = () => {
      if (!input.files || input.files.length === 0) {
        resolve(null);
        return;
      }
      // Return File objects (browser has no paths) — stores handle differently
      if (options?.multiple) {
        resolve(Array.from(input.files).map((f) => f.name));
      } else {
        resolve(input.files[0].name);
      }
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** Open a URL in the default browser / new tab. */
export async function openUrl(url: string): Promise<void> {
  if (isTauri) {
    await tauriReady;
    return _tauriOpenUrl!(url);
  }
  window.open(url, "_blank", "noopener");
}

/** Get the current Tauri window handle. Returns null in browser. */
export async function getCurrentWindow(): Promise<any | null> {
  if (isTauri) {
    await tauriReady;
    return _tauriGetCurrentWindow!();
  }
  return null;
}

/** Whether we're running in a browser (not Tauri). */
export function isBrowser(): boolean {
  return !isTauri;
}
