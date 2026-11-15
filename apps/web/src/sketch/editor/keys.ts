/** Keyboard input of the sketch editor: shortcuts through the control scheme, and typed values. */
import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { actionFor, SKETCH_CONTEXT } from "../../lib/keymap";
import { closeSketch } from "../../store";
import { applyConstraint, deleteSelection, selectAll, toggleConstruction } from "../actions";
import { setSketchSelection, setTool, useSketchUi, type SketchTool } from "../state";
import { typeIntoEntry } from "./entry";
import { ENTRY_AFTER_TWO, ENTRY_FIELDS } from "./tools";
import type { Entry, ToolState } from "./types";

/** What the keys act on. */
export interface KeyEditor {
  ts: ToolState;
  setEntry: Dispatch<SetStateAction<Entry | null>>;
  setTip: (tip: null) => void;
  finishSpline: () => void;
  rerender: () => void;
}

/**
 * Listens to the keyboard while the editor is open. Subscribed once; the keys act on the latest
 * render's editor, so a spline finished by a key is added to the sketch as it is now.
 */
export function useSketchKeys(current: KeyEditor) {
  const latest = useRef(current);
  latest.current = current;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement
      ) {
        return;
      }

      // Every key goes through the active control scheme (lib/controls).
      const action = actionFor(event, SKETCH_CONTEXT);

      if (action === "select_all") {
        event.preventDefault();

        return selectAll();
      }

      if (event.metaKey || event.ctrlKey) return;

      const editor = latest.current;
      if (typeValue(editor, event)) return;
      if (!action) return;
      if (action === "sketch.construction") return toggleConstruction();
      if (action.startsWith("sketch.")) return setTool(action.slice(7) as SketchTool);
      if (action.startsWith("constraint.")) return applyConstraint(action.slice(11));

      runAction(editor, action);
    };

    window.addEventListener("keydown", onKey);

    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** Typing a number while drawing opens exact-value fields at the cursor; true if the key went there. */
function typeValue(editor: KeyEditor, event: KeyboardEvent): boolean {
  const fields = ENTRY_FIELDS[useSketchUi.getState().tool];
  const needed = ENTRY_AFTER_TWO.has(useSketchUi.getState().tool) ? 2 : 1;

  if (
    !fields ||
    editor.ts.points.length < needed ||
    event.altKey ||
    !(/^[0-9.]$/.test(event.key) || event.key === "Tab")
  ) {
    return false;
  }

  event.preventDefault();
  // Keys typed quickly can arrive before the fields have focus: they go on into the open fields.
  editor.setEntry((cur) => typeIntoEntry(cur, event.key, event.shiftKey, fields));

  return true;
}

/**
 * Confirm and cancel: a spline being drawn is kept; cancel then drops what is being drawn, puts the
 * tool down, clears the selection and closes the sketch, one step per press.
 */
function runAction(editor: KeyEditor, action: string) {
  const { ts } = editor;

  // Confirm or cancel ends a spline being drawn (keeping it).
  if (
    (action === "confirm" || action === "cancel") &&
    useSketchUi.getState().tool === "spline" &&
    ts.points.length >= 2
  ) {
    return editor.finishSpline();
  }

  if (action === "cancel") {
    if (ts.points.length || ts.dimFirst) {
      ts.points = [];
      ts.dimFirst = null;
      editor.setEntry(null);
      editor.setTip(null);

      return editor.rerender();
    }

    if (useSketchUi.getState().tool !== "select") return setTool("select");
    if (useSketchUi.getState().selection.length) return setSketchSelection([]);

    return closeSketch();
  }

  if (action === "confirm") return closeSketch();
  if (action === "delete") return deleteSelection();
}
