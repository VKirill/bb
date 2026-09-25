import { useMemo } from "react";
import type { JsonValue } from "@get-bb/plugin-sdk";

type Submission = { pluginId: string; data: JsonValue };

export function createVkComposerDispatch() {
  let pending: Submission | undefined;
  return {
    set(pluginId: string, data: JsonValue | null) {
      if (pending && pending.pluginId !== pluginId) {
        if (data === null) return;
        throw new Error("Another plugin already configured this draft.");
      }
      pending =
        data === null ? undefined : { pluginId, data: structuredClone(data) };
    },
    resolve(explicit?: Submission) {
      if (explicit && pending && explicit.pluginId !== pending.pluginId) {
        throw new Error("Another plugin already configured this draft.");
      }
      return explicit ?? pending;
    },
    accepted(submitted: Submission | undefined) {
      if (submitted === pending) pending = undefined;
    },
  };
}

export function useVkComposerDispatch(scopeKey: string) {
  return useMemo(() => createVkComposerDispatch(), [scopeKey]);
}
