/**
 * Picking several parts in the project overview: a plain click (or tap) toggles one part, Cmd/Ctrl-click
 * does the same, and Shift-click adds every part between the last one clicked and this one, in the
 * order the overview shows them.
 */
export interface MultiSelection {
  ids: readonly string[];
  /** The part a Shift-click counts from: the last one clicked without Shift. */
  anchor: string | null;
}

export const EMPTY_SELECTION: MultiSelection = { ids: [], anchor: null };

/** The selection after clicking `id`; `order` is every part in the order shown. */
export function clickSelect(
  sel: MultiSelection,
  order: readonly string[],
  id: string,
  range = false,
): MultiSelection {
  const from = sel.anchor === null ? -1 : order.indexOf(sel.anchor);
  const to = order.indexOf(id);

  if (range && from >= 0 && to >= 0) {
    const span = order.slice(Math.min(from, to), Math.max(from, to) + 1);
    const ids = new Set([...sel.ids, ...span]);

    return { ids: order.filter((x) => ids.has(x)), anchor: sel.anchor };
  }

  const ids = sel.ids.includes(id)
    ? sel.ids.filter((x) => x !== id)
    : order.filter((x) => x === id || sel.ids.includes(x));

  return { ids, anchor: id };
}

/** Every part, or none when all are already selected. */
export function toggleAll(sel: MultiSelection, order: readonly string[]): MultiSelection {
  const all = order.length > 0 && order.every((x) => sel.ids.includes(x));

  return { ids: all ? [] : [...order], anchor: null };
}

/** Drops parts that are no longer shown (moved, deleted, or the folder changed). */
export function keepShown(sel: MultiSelection, order: readonly string[]): MultiSelection {
  const ids = sel.ids.filter((x) => order.includes(x));
  const anchor = sel.anchor !== null && order.includes(sel.anchor) ? sel.anchor : null;

  return ids.length === sel.ids.length && anchor === sel.anchor ? sel : { ids, anchor };
}
