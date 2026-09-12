import { useEffect, useSyncExternalStore } from "react";
import { atom, useAtomValue, useSetAtom } from "jotai";

const browserDimmingModalCountAtom = atom(0);

export function useBrowserDimmingOverlay(active: boolean): void {
  const setCount = useSetAtom(browserDimmingModalCountAtom);
  useEffect(() => {
    if (!active) {
      return;
    }
    setCount((count) => count + 1);
    return () => setCount((count) => count - 1);
  }, [active, setCount]);
}

export function useBrowserDimmingModal(active: boolean): void {
  useBrowserDimmingOverlay(active);
}

const dialogSelector =
  '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]';
function externalDialogOpen(): boolean {
  return (
    typeof document !== "undefined" &&
    document.querySelector(dialogSelector) !== null
  );
}
function subscribeDialogs(notify: () => void): () => void {
  const observer = new MutationObserver(notify);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["role", "data-state"],
  });
  return () => observer.disconnect();
}
export function useIsBrowserDimmingModalOpen(): boolean {
  const count = useAtomValue(browserDimmingModalCountAtom);
  const external = useSyncExternalStore(
    subscribeDialogs,
    externalDialogOpen,
    () => false,
  );
  return count > 0 || external;
}
