/**
 * The surface texture dialog's fields: pattern tiles with rendered previews, then depth, pitch and
 * angle as sliders with a typed value each (touch: drag the slider, no keyboard needed), the
 * pattern's own options and a picture for a custom pattern.
 */
import { Dices, ImagePlus } from "lucide-react";
import { useRef, type ReactNode } from "react";
import { TEXTURE_PATTERNS, type Expr, type TextureFeature, type TexturePattern } from "@meercad/schema";
import { decodeHeightImage, defaultFade, evaluate, PATTERNS } from "@meercad/model";
import { patternThumb } from "../lib/textureThumbs";
import { heightImageFromFile } from "../lib/textureImage";
import { setDraftTextures, toast, useApp } from "../store";
import { ExprInput } from "./ExprInput";
import { t } from "../lib/i18n";
import "./texture.css";

export const PATTERN_LABELS: Record<TexturePattern, string> = {
  ribs: t("texture::Round ribs"),
  ribs_square: t("texture::Square ribs"),
  ribs_v: t("texture::V ribs"),
  knurl: t("texture::Diamond knurl"),
  cross_knurl: t("texture::Straight knurl"),
  hex: t("texture::Honeycomb"),
  dots: t("texture::Dots"),
  waves: t("texture::Waves"),
  brick: t("texture::Bricks"),
  wood: t("texture::Wood grain"),
  leather: t("texture::Leather"),
  weave: t("texture::Weave"),
  image: t("texture::Picture"),
};

type Set = (patch: Record<string, unknown>) => void;

/** A value as a number, or `fallback` when it is an expression that does not work out. */
function useNumber(e: Expr | undefined, fallback: number): number {
  const params = useApp((s) => s.output?.report.params);
  if (e === undefined) return fallback;
  if (typeof e === "number") return e;
  try {
    return evaluate(e, new Map(Object.entries(params ?? {})));
  } catch {
    return fallback;
  }
}

/** A slider for touch and mouse plus the typed value; while the slider moves, textures preview coarse. */
function SliderValue({ value, fallback, min, max, step, unit, onChange, placeholder }: { value: Expr | undefined; fallback: number; min: number; max: number; step: number; unit: "mm" | "deg" | ""; onChange: (v: Expr | undefined) => void; placeholder?: string }) {
  const n = useNumber(value, fallback);
  const end = () => setDraftTextures(false);
  return (
    <div className="texture-slider">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={Math.min(max, Math.max(min, n))}
        onPointerDown={() => setDraftTextures(true)}
        onPointerUp={end}
        onPointerCancel={end}
        onBlur={end}
        onChange={(e) => onChange(Number(Number(e.target.value).toFixed(3)))}
      />
      <div className="texture-value">
        <ExprInput value={value} unit={unit} placeholder={placeholder} onCommit={onChange} onLive={onChange} />
      </div>
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="fld">
      <span className="fld-label">{label}</span>
      {children}
    </div>
  );
}

export function TextureFields({ f, set, faces }: { f: TextureFeature; set: Set; faces: ReactNode }) {
  const file = useRef<HTMLInputElement>(null);
  const info = PATTERNS[f.pattern];
  const pitch = useNumber(f.pitch, info.pitch);
  const image = f.image && !f.image.pixels.startsWith("blob:") ? decodeHeightImage(f.image) : undefined;

  const pick = (p: TexturePattern) => {
    if (p === f.pattern) return;
    // Values still at the old pattern's start values move to the new one's.
    const old = PATTERNS[f.pattern];
    const next = PATTERNS[p];
    set({
      pattern: p,
      ...(f.pitch === old.pitch ? { pitch: next.pitch } : {}),
      ...(f.depth === old.depth ? { depth: next.depth } : f.depth === -old.depth ? { depth: -next.depth } : {}),
      ratio: undefined,
      ...(p === "wood" || p === "leather" ? { seed: f.seed ?? 1 } : {}),
    });
    if (p === "image" && !f.image) file.current?.click();
  };

  const choosePicture = async (blob: File | undefined) => {
    if (!blob) return;
    try {
      const img = await heightImageFromFile(blob);
      set({ image: img, pattern: "image" });
    } catch (e) {
      toast(t("Could not read the picture: {msg}", { msg: e instanceof Error ? e.message : String(e) }), "error");
    }
  };

  return (
    <>
      <Labeled label={t("Faces")}>{faces}</Labeled>
      <Labeled label={t("Pattern")}>
        <div className="texture-grid" role="radiogroup" aria-label={t("Pattern")}>
          {TEXTURE_PATTERNS.map((p) => (
            <button key={p} role="radio" aria-checked={p === f.pattern} className={`texture-tile ${p === f.pattern ? "on" : ""}`} title={PATTERN_LABELS[p]} onClick={() => pick(p)}>
              {p === "image" && !image ? <span className="texture-thumb placeholder"><ImagePlus /></span> : <img className="texture-thumb" alt="" src={patternThumb(p, p === "image" && image ? { image } : {})} />}
              <span className="texture-name">{PATTERN_LABELS[p]}</span>
            </button>
          ))}
        </div>
      </Labeled>
      {f.pattern === "image" ? (
        <div className="row">
          <button className="btn" onClick={() => file.current?.click()}>
            <ImagePlus /> {f.image ? t("Other picture…") : t("Choose a picture…")}
          </button>
          {f.image ? <span className="muted small">{`${f.image.width} × ${f.image.height}`}</span> : null}
        </div>
      ) : null}
      <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => void choosePicture(e.target.files?.[0]).finally(() => (e.target.value = ""))} />
      <Labeled label={t("Depth")}>
        <SliderValue value={f.depth} fallback={info.depth} min={-3} max={3} step={0.05} unit="mm" onChange={(depth) => set({ depth: depth ?? info.depth })} />
      </Labeled>
      <Labeled label={f.pattern === "image" ? t("Picture width") : t("texture::Spacing")}>
        <SliderValue value={f.pitch} fallback={info.pitch} min={0.5} max={f.pattern === "image" ? 100 : 30} step={0.1} unit="mm" onChange={(p) => set({ pitch: p ?? info.pitch })} />
      </Labeled>
      <Labeled label={t("Angle")}>
        <SliderValue value={f.angle} fallback={0} min={-90} max={90} step={1} unit="deg" onChange={(angle) => set({ angle: angle === 0 ? undefined : angle })} />
      </Labeled>
      {info.ratio !== undefined ? (
        <Labeled label={t("Raised share")}>
          <SliderValue value={f.ratio} fallback={info.ratio} min={0.1} max={0.95} step={0.01} unit="" placeholder={String(info.ratio)} onChange={(ratio) => set({ ratio })} />
        </Labeled>
      ) : null}
      <Labeled label={t("Fade at the border")}>
        <SliderValue value={f.fade} fallback={defaultFade(pitch)} min={0} max={10} step={0.1} unit="mm" placeholder={t("auto")} onChange={(fade) => set({ fade })} />
      </Labeled>
      <div className="row">
        <label className="checkbox" style={{ flex: 1 }}>
          <input type="checkbox" checked={!!f.invert} onChange={(e) => set({ invert: e.target.checked || undefined })} /> {t("Swap high and low")}
        </label>
        {f.pattern === "wood" || f.pattern === "leather" ? (
          <button className="btn" title={t("Another random variant of the pattern")} onClick={() => set({ seed: Math.floor(Math.random() * 100000) })}>
            <Dices /> {t("Vary")}
          </button>
        ) : null}
      </div>
      <p className="muted small">{t("Positive depth raises the pattern, negative cuts it in. It runs on across smooth edges and fades out at the border. Only the triangles change: STL, 3MF and OBJ export the texture; STEP, volume and mass keep the smooth faces.")}</p>
    </>
  );
}
