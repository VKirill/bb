import { useEffect, useSyncExternalStore } from "react";
import { atom, useAtomValue, useSetAtom } from "jotai";

const browserDimmingModalCountAtom = atom(0);

const overlaySelector = [
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"][data-state="open"]',
  '[data-bb-browser-dimming="true"]',
].join(", ");

function overlayOpen(): boolean {
  return (
    typeof document !== "undefined" &&
    document.querySelector(overlaySelector) !== null
  );
}

function subscribeOverlays(notify: () => void): () => void {
  if (typeof document === "undefined") {
    return () => {};
  }
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["role", "data-state", "data-bb-browser-dimming"],
  });
  return () => observer.disconnect();
}

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

export function useIsBrowserDimmingModalOpen(): boolean {
  const count = useAtomValue(browserDimmingModalCountAtom);
  const external = useSyncExternalStore(
    subscribeOverlays,
    overlayOpen,
    () => false,
  );
  return count > 0 || external;
}
