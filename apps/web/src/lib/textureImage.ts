/**
 * A photo chosen for a lithophane, made into the greyscale heights the document keeps (see
 * TextureImage): at most `max` pixels on its long side (default 256), bright = high. `stretch` spreads the brightness over the whole
 * range (the darkest percent black, the brightest white), which photos usually need.
 */
import type { TextureImage } from "@meercad/schema";

export async function heightImageFromFile(file: Blob, opts: { max?: number; stretch?: boolean } = {}): Promise<TextureImage> {
  const max = opts.max ?? 256;
  const bitmap = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * k));
  const height = Math.max(1, Math.round(bitmap.height * k));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  // Transparent parts count as low (black).
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const luma = new Float32Array(width * height);
  for (let i = 0; i < luma.length; i++) luma[i] = 0.2126 * rgba[i * 4]! + 0.7152 * rgba[i * 4 + 1]! + 0.0722 * rgba[i * 4 + 2]!;
  let lo = 0, hi = 255;
  if (opts.stretch) [lo, hi] = percentiles(luma, 0.01, 0.99);
  const span = hi - lo > 8 ? hi - lo : 255;
  if (span === 255) lo = 0;
  let bin = "";
  for (let i = 0; i < luma.length; i++) bin += String.fromCharCode(Math.max(0, Math.min(255, Math.round(((luma[i]! - lo) / span) * 255))));
  return { width, height, pixels: btoa(bin) };
}

/** The brightness below which `a` and `b` of the pixels lie. */
function percentiles(luma: Float32Array, a: number, b: number): [number, number] {
  const hist = new Uint32Array(256);
  for (const v of luma) hist[Math.max(0, Math.min(255, Math.round(v)))]!++;
  const at = (q: number) => {
    let sum = 0;
    for (let i = 0; i < 256; i++) {
      sum += hist[i]!;
      if (sum >= q * luma.length) return i;
    }
    return 255;
  };
  return [at(a), at(b)];
}

/** A picture as a PNG data URL, to show it (greyscale, `invert` dark for bright). */
export function heightImageUrl(img: TextureImage, invert = false): string {
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d")!;
  const data = ctx.createImageData(img.width, img.height);
  const bin = atob(img.pixels);
  for (let i = 0; i < img.width * img.height; i++) {
    const v = invert ? 255 - bin.charCodeAt(i) : bin.charCodeAt(i);
    data.data[i * 4] = data.data[i * 4 + 1] = data.data[i * 4 + 2] = v;
    data.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(data, 0, 0);
  return canvas.toDataURL("image/png");
}
