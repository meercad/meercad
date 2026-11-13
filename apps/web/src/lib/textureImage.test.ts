/**
 * A photo made into a lithophane's heights (textureImage.ts): the size is cut to `max` pixels on
 * the long side keeping the proportions, brightness is the eye's weighting of red, green and blue
 * (0.2126 / 0.7152 / 0.0722), and stretching spreads a dull photo over the whole range. The heights
 * shown again as a picture come back as they were, or inverted.
 */
import { afterEach, describe, expect, it } from "vitest";
import { heightImageFromFile, heightImageUrl } from "./textureImage";

const original = HTMLCanvasElement.prototype.getContext;
afterEach(() => {
  HTMLCanvasElement.prototype.getContext = original;
  delete (globalThis as { createImageBitmap?: unknown }).createImageBitmap;
});

/** A photo of `w` × `h` whose pixels the canvas then reads as `rgba` (drawn already at the cut size). */
function photo(w: number, h: number, rgba: (i: number) => [number, number, number, number]) {
  (globalThis as { createImageBitmap?: unknown }).createImageBitmap = async () => ({
    width: w,
    height: h,
    close() {},
  });

  const drawn: unknown[] = [];
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
    const canvas = this;

    return {
      fillRect() {},
      drawImage: (...a: unknown[]) => void drawn.push(a.slice(1)),
      getImageData: (_x: number, _y: number, cw: number, ch: number) => ({
        data: Uint8ClampedArray.from({ length: cw * ch * 4 }, (_, k) => rgba(Math.floor(k / 4))[k % 4]!),
      }),
      set fillStyle(_v: string) {},
      set imageSmoothingQuality(_v: string) {},
      canvas,
    } as never;
  } as typeof original;

  return drawn;
}

const heights = (pixels: string) => Array.from(atob(pixels), (c) => c.charCodeAt(0));

describe("a photo as heights", () => {
  it("weighs red, green and blue as the eye does: bright is high", async () => {
    const colours: [number, number, number, number][] = [
      [0, 0, 0, 255],
      [255, 255, 255, 255],
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [0, 0, 255, 255],
      [128, 128, 128, 255],
    ];
    photo(6, 1, (i) => colours[i]!);

    const img = await heightImageFromFile(new Blob());
    expect([img.width, img.height]).toEqual([6, 1]);
    expect(heights(img.pixels)).toEqual([0, 255, 54, 182, 18, 128]);
  });

  it("cuts a large photo to 256 pixels on its long side, keeping its proportions", async () => {
    const drawn = photo(1000, 500, () => [10, 10, 10, 255]);
    const img = await heightImageFromFile(new Blob());
    expect([img.width, img.height]).toEqual([256, 128]);
    expect(drawn).toEqual([[0, 0, 256, 128]]);
    photo(30, 3000, () => [0, 0, 0, 255]);

    const tall = await heightImageFromFile(new Blob(), { max: 100 });
    expect([tall.width, tall.height]).toEqual([1, 100]);
    // A small one stays as it is.
    photo(10, 5, () => [0, 0, 0, 255]);
    expect((await heightImageFromFile(new Blob())).width).toBe(10);
  });

  it("stretches a dull photo over the whole range", async () => {
    // Greys from 100 to 150: stretched, 100 is black and 150 white.
    photo(51, 1, (i) => [100 + i, 100 + i, 100 + i, 255]);

    const img = await heightImageFromFile(new Blob(), { stretch: true });
    const h = heights(img.pixels);
    expect(h[0]).toBe(0);
    expect(h[50]).toBe(255);
    expect(h[25]).toBe(Math.round((25 / 50) * 255));
    // Nearly flat (less than 8 apart): left as it is rather than blown up.
    photo(4, 1, (i) => [120 + i, 120 + i, 120 + i, 255]);
    expect(heights((await heightImageFromFile(new Blob(), { stretch: true })).pixels)).toEqual([
      120, 121, 122, 123,
    ]);
  });

  it("shows the heights as a picture, inverted when asked", () => {
    const put: Uint8ClampedArray[] = [];
    HTMLCanvasElement.prototype.getContext = function () {
      return {
        createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: (d: { data: Uint8ClampedArray }) => void put.push(d.data),
      } as never;
    } as typeof original;

    const img = { width: 2, height: 1, pixels: btoa(String.fromCharCode(0, 200)) };
    expect(heightImageUrl(img)).toMatch(/^data:image\/png/);
    heightImageUrl(img, true);
    expect(Array.from(put[0]!)).toEqual([0, 0, 0, 255, 200, 200, 200, 255]);
    expect(Array.from(put[1]!)).toEqual([255, 255, 255, 255, 55, 55, 55, 255]);
  });
});
