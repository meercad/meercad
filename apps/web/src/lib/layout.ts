/**
 * Phone layout ("compact"): windows up to 600 px wide, i.e. the iPhone and narrow browser windows.
 * The tools move to a bar at the bottom, panels and dialogs open as sheets from below, and the
 * top bar keeps only what fits. `html[data-compact]` lets the stylesheet follow the same switch.
 */
import { useSyncExternalStore } from "react";
import { create } from "zustand";

const query = typeof matchMedia === "undefined" ? null : matchMedia("(max-width: 600px)");

export const isCompact = (): boolean => !!query?.matches;

function mark(): void {
  if (isCompact()) document.documentElement.dataset["compact"] = "";
  else delete document.documentElement.dataset["compact"];
}
mark();
query?.addEventListener("change", mark);

/** Re-renders when the window crosses the phone width. */
export function useCompact(): boolean {
  return useSyncExternalStore(
    (fn) => {
      query?.addEventListener("change", fn);
      return () => query?.removeEventListener("change", fn);
    },
    isCompact,
    () => false,
  );
}

/** Sheets that only the phone layout hides behind a button (on larger screens they are always shown). */
export const usePhoneSheets = create<{ constraints: boolean }>(() => ({ constraints: false }));
