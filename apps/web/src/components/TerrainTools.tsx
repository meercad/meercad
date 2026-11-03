/**
 * On-screen parts of designing on a terrain: the bar while a line, area or note is drawn or a part
 * is set onto the ground (finish, cancel, colour, height above the ground — with buttons, so it
 * works on the iPad without a keyboard), and the labels of lines, areas and notes in the view.
 */
import type { Viewport } from "@meercad/viewport";
import { Check, Minus, Pencil, Plus, Trash, Undo2, X } from "lucide-react";
import { useEffect, useReducer, useState } from "react";
import { setPlaceOffset, useTerrainPlace } from "../lib/terrain";
import { STROKE_WIDTHS, cancelMarking, clearTerrainMeasure, deleteMark, editMark, finishMarking, MARK_COLORS, undoMarkPoint, useTerrainDraw, useTerrainMeasure, type TerrainLabel } from "../lib/terrainDraw";
import { partName } from "../lib/features";
import { useApp } from "../store";
import { touchOnly } from "../lib/keyboard";
import { t } from "../lib/i18n";

export function TerrainHud() {
  const draw = useTerrainDraw();
  const place = useTerrainPlace();
  const measure = useTerrainMeasure();
  const features = useApp((s) => s.doc.features);
  // Keys while drawing: Enter finishes, Esc cancels, Backspace takes the last point back.
  useEffect(() => {
    if (!draw.kind) return;
    const keys = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest("input, textarea")) return;
      if (e.key === "Enter") finishMarking();
      else if (e.key === "Escape") cancelMarking();
      else if (e.key === "Backspace") undoMarkPoint();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", keys, true);
    return () => window.removeEventListener("keydown", keys, true);
  }, [draw.kind]);

  if (draw.kind) {
    const title = { line: t("Mark a line"), area: t("Mark an area"), note: t("Pin a note"), point: t("Set a stake-out point"), stroke: t("Highlighter") }[draw.kind];
    return (
      <div className="terrain-hud">
        <strong>{title}</strong>
        <span className="swatches">
          {MARK_COLORS.map((c) => (
            <button key={c} className={`swatch ${draw.color === c ? "on" : ""}`} style={{ background: c }} title={c} onClick={() => useTerrainDraw.setState({ color: c })} />
          ))}
        </span>
        {draw.kind === "stroke" ? (
          <>
            <span className="widths">
              {(Object.keys(STROKE_WIDTHS) as (keyof typeof STROKE_WIDTHS)[]).map((w) => (
                <button key={w} className={`width ${draw.width === w ? "on" : ""}`} title={{ s: t("Thin"), m: t("Medium"), l: t("Wide") }[w]} onClick={() => useTerrainDraw.setState({ width: w })}>
                  <i style={{ height: { s: 3, m: 7, l: 12 }[w] }} />
                </button>
              ))}
            </span>
            <button className="btn sm primary" onClick={cancelMarking}>
              <Check /> {t("Done")}
            </button>
          </>
        ) : null}
        {draw.kind === "line" || draw.kind === "area" ? (
          <>
            <button className="icon-btn sm" title={t("Take back the last point")} disabled={!draw.points.length} onClick={undoMarkPoint}>
              <Undo2 />
            </button>
            <button className="btn sm primary" onClick={finishMarking}>
              <Check /> {t("Done")}
            </button>
          </>
        ) : null}
        {draw.kind !== "stroke" ? (
          <button className="icon-btn sm" title={t("Cancel")} onClick={cancelMarking}>
            <X />
          </button>
        ) : null}
      </div>
    );
  }
  if (measure.scale) {
    return (
      <div className="terrain-hud">
        <strong>{t("Correct the scale")}</strong>
        <span className="muted">{measure.points.length ? t("Now the other end") : touchOnly() ? t("Tap one end of a known distance") : t("Click one end of a known distance")}</span>
        <button className="icon-btn sm" title={t("Cancel")} onClick={clearTerrainMeasure}>
          <X />
        </button>
      </div>
    );
  }
  if (place.body) {
    const step = Math.abs(place.offset) >= 1000 ? 100 : 10;
    return (
      <div className="terrain-hud">
        <strong>{t("{part} on the terrain", { part: partName(place.body, features) })}</strong>
        <span className="muted">{t("Height above the ground")}</span>
        <button className="icon-btn sm" title={t("Lower")} onClick={() => setPlaceOffset(place.offset - step)}>
          <Minus />
        </button>
        <input
          className="hud-num"
          type="number"
          step={step}
          value={place.offset}
          onChange={(e) => Number.isFinite(e.target.valueAsNumber) && setPlaceOffset(e.target.valueAsNumber)}
          aria-label={t("Height above the ground")}
        />
        <span className="muted">mm</span>
        <button className="icon-btn sm" title={t("Raise")} onClick={() => setPlaceOffset(place.offset + step)}>
          <Plus />
        </button>
        <button className="icon-btn sm" title={t("Cancel")} onClick={() => useTerrainPlace.setState({ body: null, move: null })}>
          <X />
        </button>
      </div>
    );
  }
  return null;
}

const ORDER = { note: 1, point: 2, value: 3 } as const;

/**
 * Labels of notes, stake-out points, lines, areas and measurements, kept over their spot while the
 * view moves. Notes and points stand on a pin; values sit on their line or in their area. Where
 * labels would overlap, the drawing in progress, then notes, then points win and the others step
 * back (a point keeps its pin). A tap opens one: its details and buttons to rename or delete it.
 */
export function TerrainLabels({ viewport, labels }: { viewport: Viewport; labels: readonly TerrainLabel[] }) {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => viewport.onChange(redraw), [viewport]);
  const live = (k: string) => k === "drawing" || k === "measure";
  const sorted = [...labels].sort((a, b) => (live(b.key) ? 1 : 0) - (live(a.key) ? 1 : 0) || ORDER[a.kind] - ORDER[b.kind]);
  const taken: [number, number, number, number][] = [];
  const items = sorted.flatMap((l) => {
    const p = viewport.worldToScreen(l.at);
    if (!p) return [];
    // Room the label takes on screen (estimated from its text), to keep labels from covering each other.
    const w = Math.min(l.kind === "note" ? 200 : 260, l.title.length * 7 + 30);
    const h = l.kind === "note" ? 20 + Math.ceil((l.title.length * 7) / 180) * 18 : 26;
    const box: [number, number, number, number] = l.kind === "value" ? [p[0] - w / 2, p[1] - h / 2, p[0] + w / 2, p[1] + h / 2] : [p[0] - w / 2, p[1] - 30 - h, p[0] + w / 2, p[1]];
    const free = l.key === open || !taken.some((r) => box[0] < r[2] && box[2] > r[0] && box[1] < r[3] && box[3] > r[1]);
    if (free) taken.push(box);
    return [{ l, p, free }];
  });
  return (
    <div className="terrain-labels">
      {items.map(({ l, p, free }) => {
        const isOpen = open === l.key;
        const actions =
          isOpen && l.mark ? (
            <span className="tl-actions">
              <button className="icon-btn sm" title={l.mark.kind === "note" ? t("Edit note…") : t("Name…")} onClick={(e) => (e.stopPropagation(), void editMark(l.ref, l.mark!))}>
                <Pencil />
              </button>
              <button className="icon-btn sm" title={t("Delete")} onClick={(e) => (e.stopPropagation(), setOpen(null), deleteMark(l.ref, l.mark!.id))}>
                <Trash />
              </button>
            </span>
          ) : null;
        const toggle = (e: React.MouseEvent) => (e.stopPropagation(), setOpen(isOpen ? null : l.key));
        return (
          <div key={l.key} className={`tl tl-${l.kind} ${isOpen ? "open" : ""} ${free ? "" : "hidden"} ${live(l.key) ? "live" : ""}`} style={{ left: p[0], top: p[1], ["--mark" as string]: l.color }}>
            {l.kind === "value" ? (
              <div className="tl-pill" onClick={toggle}>
                <b>{l.title}</b>
                {l.detail ? <span className="tl-detail">{l.detail}</span> : null}
                {actions}
              </div>
            ) : (
              <>
                <i className="tl-pin" onClick={toggle} />
                <i className="tl-stem" />
                <div className="tl-card" onClick={toggle}>
                  <b>{l.title}</b>
                  {l.detail ? <span className="tl-detail">{l.detail}</span> : null}
                  {actions}
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
