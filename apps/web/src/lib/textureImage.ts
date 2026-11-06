/**
 * A picture chosen for a custom surface texture, made into the greyscale heights the document keeps
 * (see TextureImage): at most 256 pixels on its long side, bright = high.
 */
import type { TextureImage } from "@meercad/schema";

const MAX = 256;

export async function heightImageFromFile(file: Blob): Promise<TextureImage> {
  const bitmap = await createImageBitmap(file);
  const k = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * k));
  const height = Math.max(1, Math.round(bitmap.height * k));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  // Transparent parts count as low (black).
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const rgba = ctx.getImageData(0, 0, width, height).data;
  let bin = "";
  for (let i = 0; i < width * height; i++) {
    const luma = 0.2126 * rgba[i * 4]! + 0.7152 * rgba[i * 4 + 1]! + 0.0722 * rgba[i * 4 + 2]!;
    bin += String.fromCharCode(Math.round(luma));
  }
  return { width, height, pixels: btoa(bin) };
}
