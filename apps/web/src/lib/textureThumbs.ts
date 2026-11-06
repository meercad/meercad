/**
 * Little rendered previews of the surface texture patterns for the dialog: the pattern's heights
 * lit from the top left, as a picture (data URL), made once per pattern and kept.
 */
import { patternHeight, type HeightImage } from "@meercad/model";
import type { TexturePattern } from "@meercad/schema";

const cache = new Map<string, string>();

export function patternThumb(pattern: TexturePattern, opts: { ratio?: number; image?: HeightImage; invert?: boolean; size?: number } = {}): string {
  const size = opts.size ?? 64;
  const key = `${pattern}|${opts.ratio ?? ""}|${opts.invert ? 1 : 0}|${size}|${opts.image ? `${opts.image.width}x${opts.image.height}:${opts.image.pixels.length}:${opts.image.pixels[0]}` : ""}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const h = patternHeight(pattern, { ...(opts.ratio !== undefined ? { ratio: opts.ratio } : {}), ...(opts.image ? { image: opts.image } : {}), ...(opts.invert ? { invert: true } : {}), seed: 1 });
  // Two and a half repeats across; noisy patterns (wood, leather) look better with a little more.
  const span = pattern === "wood" || pattern === "leather" ? 4 : pattern === "image" ? 1 : 2.5;
  const step = span / size;
  const heights = new Float32Array((size + 2) * (size + 2));
  for (let y = 0; y < size + 2; y++)
    for (let x = 0; x < size + 2; x++) heights[y * (size + 2) + x] = h((x - 1) * step, (size - y) * step);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  const relief = 0.35 / step;
  const light = [-0.5, 0.6, 0.62];
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const at = (dx: number, dy: number) => heights[(y + 1 + dy) * (size + 2) + x + 1 + dx]!;
      const nx = -(at(1, 0) - at(-1, 0)) * relief * 0.5, ny = (at(0, 1) - at(0, -1)) * relief * 0.5;
      const len = Math.hypot(nx, ny, 1);
      const lambert = Math.max(0, (nx * light[0]! + ny * light[1]! + light[2]!) / len);
      const v = Math.round(60 + 150 * lambert + 40 * at(0, 0));
      const i = (y * size + x) * 4;
      img.data[i] = v;
      img.data[i + 1] = Math.min(255, v + 6);
      img.data[i + 2] = Math.min(255, v + 14);
      img.data[i + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  const url = canvas.toDataURL("image/png");
  cache.set(key, url);
  return url;
}
