/**
 * The rendered view's bar: turn the model on a turntable, show or leave out the backdrop, and save
 * a high-resolution picture of the view as it is (sizes for screens, prints and shops). Big
 * targets, no keys needed, so it works the same with a mouse and with a finger.
 */
import { ImageDown, RotateCw, SquareDashed, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { Viewport } from "@meercad/viewport";
import { t } from "../lib/i18n";
import { toast } from "../store";
import { baseName, download } from "./io";
import { showMenu } from "./Menu";
import "../materials.css";

/** Picture sizes offered by "Save image". */
export function imageSizes(view: {
  width: number;
  height: number;
}): { label: string; width: number; height: number }[] {
  const s = (w: number, h: number) => `${w} × ${h}`;
  const sw = Math.round(view.width * 2);
  const sh = Math.round(view.height * 2);

  return [
    { label: t("As on screen, sharp ({size})", { size: s(sw, sh) }), width: sw, height: sh },
    { label: t("Full HD ({size})", { size: s(1920, 1080) }), width: 1920, height: 1080 },
    { label: t("4K ({size})", { size: s(3840, 2160) }), width: 3840, height: 2160 },
    { label: t("Square ({size})", { size: s(2048, 2048) }), width: 2048, height: 2048 },
  ];
}

/** Renders the view at a size and saves it as a PNG. */
export async function saveRender(
  viewport: Viewport,
  width: number,
  height: number,
  transparent: boolean,
): Promise<void> {
  try {
    const canvas = viewport.renderImage(width, height, { transparent });
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error(t("the picture could not be encoded"));

    download(`${baseName()} ${canvas.width}x${canvas.height}.png`, new Uint8Array(await blob.arrayBuffer()));
  } catch (error) {
    toast(
      t("Could not save the picture: {error}", {
        error: error instanceof Error ? error.message : String(error),
      }),
      "error",
    );
  }
}

export function RenderBar({ vp: viewport, onExit }: { vp: Viewport; onExit: () => void }) {
  const [spin, setSpin] = useState(viewport.turntable);
  const [transparent, setTransparent] = useState(false);
  useEffect(() => () => viewport.setTurntable(false), [viewport]);

  return (
    <div className="render-bar" role="toolbar" aria-label={t("Rendered view")}>
      <button
        className={`icon-btn ${spin ? "active" : ""}`}
        title={spin ? t("Stop turning") : t("Turntable: turn the model slowly")}
        aria-pressed={spin}
        onClick={() => {
          viewport.setTurntable(!spin);
          setSpin(!spin);
        }}
      >
        <RotateCw />
        <span>{t("Turntable")}</span>
      </button>
      <button
        className={`icon-btn ${transparent ? "active" : ""}`}
        title={t("Save pictures without a background (transparent)")}
        aria-pressed={transparent}
        onClick={() => setTransparent(!transparent)}
      >
        <SquareDashed />
        <span>{t("Transparent")}</span>
      </button>
      <button
        className="icon-btn"
        title={t("Save a high-resolution picture of this view")}
        onClick={(event) => {
          const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
          const element = viewport.renderer.domElement;
          showMenu(
            rect.left,
            rect.bottom + 6,
            imageSizes({ width: element.clientWidth, height: element.clientHeight }).map((s) => ({
              label: s.label,
              icon: <ImageDown />,
              onClick: () => void saveRender(viewport, s.width, s.height, transparent),
            })),
          );
        }}
      >
        <ImageDown />
        <span>{t("Save image")}</span>
      </button>
      <span className="bar-sep" aria-hidden />
      <button className="icon-btn" title={t("Back to the working view")} onClick={onExit}>
        <X />
      </button>
    </div>
  );
}
