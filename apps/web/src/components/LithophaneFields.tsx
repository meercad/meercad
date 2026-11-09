/**
 * The lithophane dialog: a photo (with a preview of how it will look), lithophane or relief, flat,
 * curved or round, sizes as sliders with a typed value each (touch: no keyboard needed), a frame,
 * and where the plate goes.
 */
import { ImagePlus } from "lucide-react";
import { useMemo, useRef, type ReactNode } from "react";
import type { Feature } from "@meercad/schema";
import { describePlane } from "../lib/topology";
import { heightImageFromFile, heightImageUrl } from "../lib/textureImage";
import { toast } from "../store";
import { PlaneBox } from "./GridfinityFields";
import { SliderValue } from "./SliderValue";
import { ExprInput } from "./ExprInput";
import { t } from "../lib/i18n";
import "./lithophane.css";

type Of<O extends Feature["op"]> = Extract<Feature, { op: O }>;
type SetFn = (patch: Record<string, unknown>) => void;

/** Long side of a lithophane's photo in pixels: 0.2 mm per pixel on a 100 mm picture. */
const PHOTO_PIXELS = 500;

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="fld">
    <span className="fld-label">{label}</span>
    {children}
  </div>
);

function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, ReactNode][]; onChange: (v: T) => void }) {
  return (
    <div className="segmented">
      {options.map(([v, label]) => (
        <button key={v} className={v === value ? "on" : ""} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

type Shape = "flat" | "curved" | "round";

export function LithophaneFields({ f, set }: { f: Of<"lithophane">; set: SetFn }) {
  const file = useRef<HTMLInputElement>(null);
  const kind = f.kind ?? "lithophane";
  const relief = kind === "relief";
  const has = !!f.image.pixels && !f.image.pixels.startsWith("blob:");
  // The preview shows what the light (lithophane) or the shadows (relief) will show: a lithophane
  // is dark where it is thick.
  const preview = useMemo(() => (has ? heightImageUrl(f.image, !!f.invert) : null), [has, f.image, f.invert]);
  const curve = typeof f.curve === "number" ? f.curve : f.curve === undefined ? 0 : 120;
  const shape: Shape = curve >= 360 ? "round" : curve > 0 ? "curved" : "flat";
  const width = typeof f.width === "number" ? f.width : 100;
  const height = has ? (width * f.image.height) / f.image.width : 0;

  const choose = async (blob: File | undefined) => {
    if (!blob) return;
    try {
      const image = await heightImageFromFile(blob, { max: PHOTO_PIXELS, stretch: true });
      set({ image, ...(f.name ? {} : { name: blob.name.replace(/\.[^.]+$/, "").slice(0, 60) || undefined }) });
    } catch (e) {
      toast(t("Could not read the picture: {msg}", { msg: e instanceof Error ? e.message : String(e) }), "error");
    }
  };

  return (
    <>
      <Field label={t("Photo")}>
        {preview ? (
          <button className="litho-preview" title={t("Other photo…")} onClick={() => file.current?.click()}>
            <img alt="" src={preview} />
          </button>
        ) : null}
        <div className="row" style={{ alignItems: "center" }}>
          <button className={`btn ${has ? "" : "primary"}`} onClick={() => file.current?.click()}>
            <ImagePlus /> {has ? t("Other photo…") : t("Choose a photo…")}
          </button>
          {has ? <span className="muted small">{`${f.image.width} × ${f.image.height} px · ${width.toFixed(0)} × ${height.toFixed(0)} mm`}</span> : null}
        </div>
      </Field>
      <input ref={file} type="file" accept="image/*" hidden onChange={(e) => void choose(e.target.files?.[0]).finally(() => (e.target.value = ""))} />
      <Field label={t("Kind")}>
        <Seg
          value={kind}
          options={[
            ["lithophane", t("Lithophane")],
            ["relief", t("Relief")],
          ]}
          // The thicknesses go back to the kind's own start values.
          onChange={(k) => set({ kind: k === "lithophane" ? undefined : k, thickness: undefined, depth: undefined })}
        />
      </Field>
      <p className="muted small">{relief ? t("Bright parts stand out, dark parts stay low: the picture shows in the shadows when light falls from the side.") : t("Dark parts get thick, bright parts thin: held against the light or a lamp, the plate shows the photo.")}</p>
      <Field label={t("Shape")}>
        <Seg
          value={shape}
          options={[
            ["flat", t("Flat")],
            ["curved", t("Curved")],
            ["round", t("Lamp shade")],
          ]}
          onChange={(s) => set({ curve: s === "flat" ? undefined : s === "round" ? 360 : 120 })}
        />
      </Field>
      {shape === "curved" ? (
        <Field label={t("Bend")}>
          <SliderValue value={f.curve} fallback={120} min={10} max={350} step={5} unit="deg" onChange={(c) => set({ curve: c ?? 120 })} />
        </Field>
      ) : null}
      <Field label={shape === "round" ? t("Circumference") : t("Picture width")}>
        <SliderValue value={f.width} fallback={100} min={20} max={shape === "round" ? 600 : 250} step={1} unit="mm" onChange={(w) => set({ width: w ?? 100 })} />
      </Field>
      <Field label={relief ? t("Base plate") : t("Thinnest (bright)")}>
        <SliderValue value={f.thickness} fallback={relief ? 1.6 : 0.8} min={0.4} max={5} step={0.1} unit="mm" placeholder={relief ? "1.6" : "0.8"} onChange={(thickness) => set({ thickness })} />
      </Field>
      <Field label={relief ? t("Relief height") : t("Added at dark parts")}>
        <SliderValue value={f.depth} fallback={relief ? 1.6 : 2.2} min={0.2} max={8} step={0.1} unit="mm" placeholder={relief ? "1.6" : "2.2"} onChange={(depth) => set({ depth })} />
      </Field>
      <Field label={t("Frame")}>
        <SliderValue value={f.frame} fallback={0} min={0} max={15} step={0.5} unit="mm" placeholder="0" onChange={(frame) => set({ frame: frame === 0 ? undefined : frame })} />
      </Field>
      <label className="checkbox">
        <input type="checkbox" checked={!!f.invert} onChange={(e) => set({ invert: e.target.checked || undefined })} /> {t("Swap dark and bright")}
      </label>
      <Field label={t("On")}>
        <PlaneBox value={describePlane(f.plane ?? { ref: "origin.XY" })} placeholder={t("Tap a flat face where the plate goes")} />
      </Field>
      <div className="row">
        <Field label={t("Position x")}>
          <ExprInput value={f.position?.[0] ?? 0} onCommit={(x) => set({ position: [x, f.position?.[1] ?? 0] })} />
        </Field>
        <Field label={t("Position y")}>
          <ExprInput value={f.position?.[1] ?? 0} onCommit={(y) => set({ position: [f.position?.[0] ?? 0, y] })} />
        </Field>
      </div>
      <p className="muted small">
        {relief
          ? t("Export as STL or 3MF: only they carry the picture.")
          : t("Print in white at 100 % infill, 0.1–0.12 mm layers; curved plates stand, so print them upright. Export as STL or 3MF: only they carry the picture.")}
      </p>
    </>
  );
}
