/**
 * Session lifecycle — serialized session chain, model/permission switching,
 * stop/restart, and settings cache.
 */

import { invoke } from "../lib/transport";
import type { StartSessionOptions } from "../types/conductor";
import { useChatStore } from "./chatStore";
import { useConductorStore } from "./conductorStore";

// ── Settings cache ──

let cachedSettings: { bypassPermissions: boolean; enableChrome: boolean } | null = null;
let settingsCacheTime = 0;
const SETTINGS_CACHE_TTL = 10_000; // 10 seconds

export function invalidateSettingsCache() {
  cachedSettings = null;
  settingsCacheTime = 0;
}

export async function getSettings() {
  if (!cachedSettings || Date.now() - settingsCacheTime > SETTINGS_CACHE_TTL) {
    cachedSettings = await invoke<{ bypassPermissions: boolean; enableChrome: boolean }>("load_settings");
    settingsCacheTime = Date.now();
  }
  return cachedSettings;
}

// ── Session chain ──

let sessionChain: Promise<void> = Promise.resolve();

export function enqueueSession<T>(fn: () => Promise<T>): Promise<T> {
  const prev = sessionChain;
  let done: () => void;
  sessionChain = new Promise((r) => { done = r; });
  return (async () => {
    try {
      await prev;
      return await fn();
    } finally {
      done!();
    }
  })();
}

/** Wait for hasSession to become false (processExited), max 5s.
 *  Subscribe BEFORE checking current value to avoid TOCTOU race. */
function waitForSessionExit(): Promise<void> {
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      unsub();
      console.warn("[sessionManager] CLI process did not exit within 5s, force-clearing session state");
      useChatStore.setState({ hasSession: false });
      resolve();
    }, 5000);
    const unsub = useChatStore.subscribe((s) => {
      if (!s.hasSession) {
        clearTimeout(timeout);
        unsub();
        resolve();
      }
    });
    // Check AFTER subscribing — if already false, resolve immediately
    if (!useChatStore.getState().hasSession) {
      clearTimeout(timeout);
      unsub();
      resolve();
    }
  });
}

// ── Stop / Restart ──

export async function stopGeneration() {
  const { agentId } = useChatStore.getState();
  try {
    await invoke("stop_session", { agentId });
  } catch (e) {
    console.error("[stopGeneration] Failed:", e);
  } finally {
    // Always reset state if the session hasn't changed during await
    if (useChatStore.getState().agentId === agentId) {
      useChatStore.setState({ isThinking: false, planMode: false, currentToolActivity: null });
    }
  }
}

export async function restartSession() {
  const { agentId, hasSession } = useChatStore.getState();
  if (!hasSession) return;
  try {
    await invoke("stop_session", { agentId });
  } catch (e) {
    console.error("Failed to restart session:", e);
  }
}

// ── Switch permission mode ──

export function switchPermissionMode(mode: "default" | "plan") {
  const conductor = useConductorStore.getState();
  conductor.setSelectedPermissionMode(mode);

  const { agentId, hasSession } = useChatStore.getState();
  if (!hasSession) return Promise.resolve();

  return enqueueSession(() => switchPermissionModeInner(mode, agentId, conductor));
}

async function switchPermissionModeInner(
  mode: "default" | "plan",
  agentId: string,
  conductor: ReturnType<typeof useConductorStore.getState>,
) {
  const sessionId = conductor.sessionId;

  try {
    await invoke("stop_session", { agentId });
  } catch (e) {
    console.error("Failed to stop session for mode switch:", e);
  }

  await waitForSessionExit();

  const state = useChatStore.getState();
  let enableChrome = true;
  try {
    const settings = await invoke<{ enableChrome: boolean }>("load_settings");
    enableChrome = settings.enableChrome;
  } catch (e) { console.error("Failed to load settings for mode switch:", e); }

  const permissionMode = mode !== "default" ? mode : undefined;

  useChatStore.setState({ planMode: mode === "plan" });

  try {
    const permRole = useConductorStore.getState().getAgentRole(state.agentId);

    await invoke("start_session", {
      options: {
        agentId: state.agentId,
        prompt: "",
        projectPath: state.projectPath,
        model: conductor.selectedModel || undefined,
        effort: conductor.selectedEffort !== "high" ? conductor.selectedEffort : undefined,
        resumeSessionId: sessionId ?? undefined,
        permissionMode,
        chrome: enableChrome,
        roleSystemPrompt: permRole?.system_prompt ? permRole.system_prompt : undefined,
        roleAllowedTools: permRole?.allowed_tools.length ? permRole.allowed_tools : undefined,
      } satisfies StartSessionOptions,
    });
    useChatStore.setState({ hasSession: true });
  } catch (e) {
    console.error("[switchPermissionMode] Failed:", e);
    useChatStore.setState({ error: "Failed to switch mode. Please try again." });
  }
}

// ── Switch model ──

export function switchModel(newModel: string) {
  const conductor = useConductorStore.getState();
  conductor.setSelectedModel(newModel);

  const { agentId, hasSession } = useChatStore.getState();
  if (!hasSession) return Promise.resolve();

  return enqueueSession(() => switchModelInner(newModel, agentId, conductor));
}

async function switchModelInner(
  newModel: string,
  agentId: string,
  conductor: ReturnType<typeof useConductorStore.getState>,
) {
  const sessionId = conductor.sessionId;

  try {
    await invoke("stop_session", { agentId });
  } catch (e) {
    console.error("Failed to stop session for model switch:", e);
  }

  await waitForSessionExit();

  const state = useChatStore.getState();
  let enableChrome = true;
  try {
    const settings = await invoke<{ enableChrome: boolean }>("load_settings");
    enableChrome = settings.enableChrome;
  } catch (e) { console.error("Failed to load settings for model switch:", e); }

  const permissionMode = conductor.selectedPermissionMode !== "default" ? conductor.selectedPermissionMode : undefined;

  try {
    const permRole = useConductorStore.getState().getAgentRole(state.agentId);

    await invoke("start_session", {
      options: {
        agentId: state.agentId,
        prompt: "",
        projectPath: state.projectPath,
        model: newModel || undefined,
        effort: conductor.selectedEffort !== "high" ? conductor.selectedEffort : undefined,
        resumeSessionId: sessionId ?? undefined,
        permissionMode,
        chrome: enableChrome,
        roleSystemPrompt: permRole?.system_prompt ? permRole.system_prompt : undefined,
        roleAllowedTools: permRole?.allowed_tools.length ? permRole.allowed_tools : undefined,
      } satisfies StartSessionOptions,
    });
    useChatStore.setState({ hasSession: true });
  } catch (e) {
    console.error("[switchModel] Failed:", e);
    useChatStore.setState({ error: "Failed to switch model. Please try again." });
  }
}
