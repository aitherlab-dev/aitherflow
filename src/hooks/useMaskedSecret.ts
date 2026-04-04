import { useState, useCallback, useRef } from "react";

interface UseMaskedSecretOptions {
  clearOnEmpty?: boolean;
}

/**
 * Single-key masked secret: stores real value in a ref, displays ****xxxx mask.
 * `clearOnEmpty` (default true) — whether empty input clears the real value.
 */
export function useMaskedSecret(options?: UseMaskedSecretOptions) {
  const clearOnEmpty = options?.clearOnEmpty ?? true;
  const realRef = useRef("");
  const [displayValue, setDisplayValue] = useState("");
  const setFromLoad = useCallback((realVal: string) => {
    realRef.current = realVal;
    setDisplayValue(realVal ? (realVal.length > 4 ? `****${realVal.slice(-4)}` : "****") : "");
  }, []);

  const setFromInput = useCallback(
    (val: string) => {
      setDisplayValue(val);
      if (!val && clearOnEmpty) {
        realRef.current = "";
      } else if (val && !val.startsWith("****")) {
        realRef.current = val;
      }
    },
    [clearOnEmpty],
  );

  return { displayValue, realRef, setFromInput, setFromLoad };
}

/**
 * Multi-key masked secrets: manages a Record of real keys by id.
 * Display masking is handled externally (e.g. input type="password").
 */
export function useMaskedSecrets() {
  const realKeysRef = useRef<Record<string, string>>({});
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});

  const setFromLoad = useCallback((id: string, realVal: string) => {
    realKeysRef.current[id] = realVal;
  }, []);

  const resolveFromInput = useCallback((id: string, val: string) => {
    if (val && !val.startsWith("****")) {
      realKeysRef.current[id] = val;
    } else if (!val) {
      realKeysRef.current[id] = "";
    }
  }, []);

  const remove = useCallback((id: string) => {
    delete realKeysRef.current[id];
  }, []);

  const toggleShowKey = useCallback((id: string) => {
    setShowKeys((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  return { realKeysRef, showKeys, setFromLoad, resolveFromInput, remove, toggleShowKey };
}
