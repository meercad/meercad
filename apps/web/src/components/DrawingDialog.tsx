/**
 * Technical drawing: the parts' views (front, from above, from the left, isometric) with hidden
 * lines on a standard sheet with frame, title block and overall dimensions, previewed here and
 * downloaded as PDF, SVG or DXF.
 */
import { FileDown, X } from "lucide-react";
import { useEffect, useState } from "react";
import { layoutSheet, writeSheetDxf, writeSheetPdf, writeSheetSvg, type Paper, type SheetView } from "@meercad/io";
import { billOfMaterials, bomCsv, drawingDocument } from "@meercad/model";
import { partName } from "../lib/features";
import { currentDoc, kernel, toast, useApp } from "../store";
import { baseName, download } from "./io";

type ViewName = SheetView["name"];
const VIEWS: [ViewName, string][] = [
  ["front", "Front"],
  ["top", "From above"],
  ["left", "From the left"],
  ["iso", "Isometric"],
];

/** Opens the drawing dialog (from menus and the command palette). */
export const openDrawing = () => window.dispatchEvent(new Event("meercad:drawing"));

export function DrawingDialog() {
  const [open, setOpen] = useState(false);
  const [paper, setPaper] = useState<Paper>("A4");
  const [chosen, setChosen] = useState<ViewName[]>(["front", "top", "left", "iso"]);
  const [title, setTitle] = useState("");
  const [material, setMaterial] = useState("");
  const [drawnBy, setDrawnBy] = useState("");
  const [views, setViews] = useState<SheetView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [withBom, setWithBom] = useState(true);
  const doc = useApp((s) => s.doc);
  const output = useApp((s) => s.output);

  useEffect(() => {
    const show = () => {
      setTitle((t) => t || baseName());
      setOpen(true);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("meercad:drawing", show);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("meercad:drawing", show);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  // The views come from the kernel; they follow the model while the dialog is open.
  useEffect(() => {
    if (!open) return;
    if (!output?.report.bodies.length) {
      setViews(null);
      setError("There is no part to draw yet.");
      return;
    }
    let live = true;
    setError(null);
    kernel
      .drawing(chosen, undefined, drawingDocument(currentDoc()))
      .then((v) => live && setViews(v))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [open, output, chosen.join(",")]);

  if (!open) return null;
  const bom = billOfMaterials(output?.report.bodies ?? [], (id) => partName(id, doc.features), doc.partMaterials ?? {});
  const sheet = views ? layoutSheet(views, { paper, ...(withBom && bom.length > 1 ? { bom } : {}), title: { title: title || "Untitled", material, drawnBy, date: new Date().toLocaleDateString("sv") } }) : null;
  const svg = sheet ? writeSheetSvg(sheet) : null;
  const name = `${baseName()}-drawing`;
  const save = (format: "pdf" | "svg" | "dxf") => {
    if (!sheet) return;
    if (format === "pdf") download(`${name}.pdf`, writeSheetPdf(sheet) as BlobPart, "application/pdf");
    else if (format === "svg") download(`${name}.svg`, svg!, "image/svg+xml");
    else download(`${name}.dxf`, writeSheetDxf(sheet), "image/vnd.dxf");
    toast(`Drawing saved as ${format.toUpperCase()} (scale ${sheet.scaleLabel})`);
  };
  return (
    <div className="modal-backdrop" onPointerDown={() => setOpen(false)}>
      <div className="modal settings drawing-dialog" role="dialog" aria-label="Technical drawing" onPointerDown={(e) => e.stopPropagation()}>
        <header className="settings-head">
          <h2>Technical drawing</h2>
          <button className="icon-btn" onClick={() => setOpen(false)} title="Close (Esc)">
            <X />
          </button>
        </header>
        <div className="drawing-body">
          <div className="drawing-preview">{error ? <div className="callout info">{error}</div> : svg ? <img alt="Drawing preview" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`} /> : <span className="muted">Projecting the views…</span>}</div>
          <div className="drawing-side col" style={{ gap: 10 }}>
            <label className="fld">
              <span className="fld-label">Title</span>
              <input className="field" value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label className="fld">
              <span className="fld-label">Material</span>
              <input className="field" value={material} placeholder="e.g. PETG, aluminium" onChange={(e) => setMaterial(e.target.value)} />
            </label>
            <label className="fld">
              <span className="fld-label">Drawn by</span>
              <input className="field" value={drawnBy} onChange={(e) => setDrawnBy(e.target.value)} />
            </label>
            <div className="fld">
              <span className="fld-label">Sheet</span>
              <div className="segmented">
                {(["A4", "A3", "A2"] as Paper[]).map((p) => (
                  <button key={p} className={p === paper ? "on" : ""} onClick={() => setPaper(p)}>
                    {p}
                  </button>
                ))}
              </div>
            </div>
            <div className="fld">
              <span className="fld-label">Views</span>
              {VIEWS.map(([v, label]) => (
                <label className="checkbox" key={v}>
                  <input type="checkbox" checked={chosen.includes(v)} onChange={(e) => setChosen((c) => (e.target.checked ? VIEWS.map(([x]) => x).filter((x) => c.includes(x) || x === v) : c.filter((x) => x !== v)))} /> {label}
                </label>
              ))}
            </div>
            {bom.length > 1 ? (
              <label className="checkbox">
                <input type="checkbox" checked={withBom} onChange={(e) => setWithBom(e.target.checked)} /> Parts list on the sheet ({bom.length} lines)
              </label>
            ) : null}
            {sheet ? <p className="muted small">Scale {sheet.scaleLabel} · first-angle projection (ISO E) · dashed lines are hidden edges.</p> : null}
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              <button className="btn primary" disabled={!sheet} onClick={() => save("pdf")}>
                <FileDown /> PDF
              </button>
              <button className="btn" disabled={!sheet} onClick={() => save("svg")}>
                SVG
              </button>
              <button className="btn" disabled={!sheet} onClick={() => save("dxf")}>
                DXF
              </button>
              <button className="btn" disabled={!bom.length} onClick={() => download(`${baseName()}-parts.csv`, bomCsv(bom), "text/csv")} title="Parts list for a spreadsheet">
                Parts list CSV
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
