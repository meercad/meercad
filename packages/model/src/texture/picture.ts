/**
 * A greyscale height picture laid on faces (a lithophane's picture): heights from 0 (the face
 * itself) to 1 (the full depth), read from the picture's brightness.
 */

/** A greyscale height picture, decoded: `pixels` row by row from the top, 0–255. */
export interface HeightImage {
  width: number;
  height: number;
  pixels: Uint8Array;
}

const fract = (x: number) => x - Math.floor(x);
const mod = (i: number, n: number) => ((i % n) + n) % n;

/**
 * The picture repeated: one repeat is 1 across (`a`) and keeps the picture's proportions along
 * (`b`); `invert` swaps high and low.
 */
export function imageTiled(img: HeightImage, invert = false): (a: number, b: number) => number {
  return invert ? (a, b) => 1 - sampleImage(img, a, b) : (a, b) => sampleImage(img, a, b);
}

function sampleImage(img: HeightImage, a: number, b: number): number {
  // The picture spans one pitch across and keeps its proportions along; row 0 is its top.
  const aspect = img.height / img.width;
  const x = fract(a) * img.width - 0.5;
  const y = (1 - fract(b / aspect)) * img.height - 0.5;
  const x0 = Math.floor(x),
    y0 = Math.floor(y);
  const tx = x - x0,
    ty = y - y0;
  const px = (i: number, j: number) => img.pixels[mod(j, img.height) * img.width + mod(i, img.width)]! / 255;
  const top = px(x0, y0) * (1 - tx) + px(x0 + 1, y0) * tx;
  const bottom = px(x0, y0 + 1) * (1 - tx) + px(x0 + 1, y0 + 1) * tx;

  return top * (1 - ty) + bottom * ty;
}

/**
 * A picture stretched once over the unit square, for a texture that fits its faces: `s` from the
 * left (0) to the right (1), `t` from the top (0) to the bottom (1). Outside the square the border
 * pixels go on; when `wrap` is set the left and right sides join (a picture round a closed tube).
 */
export function imageFit(img: HeightImage, invert = false, wrap = false): (s: number, t: number) => number {
  const W = img.width,
    H = img.height;

  const px = (i: number, j: number) => {
    const x = wrap ? mod(i, W) : i < 0 ? 0 : i >= W ? W - 1 : i;
    const y = j < 0 ? 0 : j >= H ? H - 1 : j;

    return img.pixels[y * W + x]! / 255;
  };

  return (s, t) => {
    const x = (wrap ? fract(s) : s) * W - 0.5,
      y = t * H - 0.5;
    const x0 = Math.floor(x),
      y0 = Math.floor(y);
    const tx = x - x0,
      ty = y - y0;
    const top = px(x0, y0) * (1 - tx) + px(x0 + 1, y0) * tx;
    const bottom = px(x0, y0 + 1) * (1 - tx) + px(x0 + 1, y0 + 1) * tx;
    const v = top * (1 - ty) + bottom * ty;

    return invert ? 1 - v : v;
  };
}

/** Decodes a base64 height picture (see TextureImage). */
export function decodeHeightImage(img: { width: number; height: number; pixels: string }): HeightImage {
  const bin = atob(img.pixels);
  const pixels = new Uint8Array(img.width * img.height);
  for (let i = 0; i < pixels.length && i < bin.length; i++) pixels[i] = bin.charCodeAt(i);

  return { width: img.width, height: img.height, pixels };
}
