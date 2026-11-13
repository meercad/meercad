/**
 * Phone layout ("compact"): windows up to 600 px wide or 580 px tall, i.e. the iPhone (also turned
 * sideways, where the tool rail would run off the bottom and take "Done" with it) and small Mac windows.
 * The tools move to a bar at the bottom, panels and dialogs open as sheets from below, and the
 * top bar keeps only what fits. `html[data-compact]` lets the stylesheet follow the same switch.
 */
import { useSyncExternalStore } from "react";
import { create } from "zustand";

const query =
  typeof matchMedia === "undefined" ? null : matchMedia("(max-width: 600px), (max-height: 580px)");

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
