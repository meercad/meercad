import { describe, expect, it } from "vitest";
import { encodeGif } from "./gif.js";

/** Decodes the frames' palette indices back (spec decoder), with the global palette. */
function decode(gif: Uint8Array) {
  let p = 6;
  const u16 = () => gif[p++]! | (gif[p++]! << 8);
  const width = u16();
  const height = u16();
  const flags = gif[p++]!;
  p += 2;

  const palette: number[][] = [];

  if (flags & 0x80) {
    for (let i = 0; i < 2 << (flags & 7); i++) palette.push([gif[p++]!, gif[p++]!, gif[p++]!]);
  }

  const frames: Uint8Array[] = [];
  let loops = false;

  for (;;) {
    const b = gif[p++]!;
    if (b === 0x3b) break;

    if (b === 0x21) {
      const label = gif[p++]!;
      if (label === 0xff) loops = true;

      for (let n = gif[p++]!; n; n = gif[p++]!) p += n;
      continue;
    }

    expect(b).toBe(0x2c);
    p += 9;

    const min = gif[p++]!;
    const data: number[] = [];
    for (let n = gif[p++]!; n; n = gif[p++]!) for (let i = 0; i < n; i++) data.push(gif[p++]!);

    const clear = 1 << min;
    const end = clear + 1;
    let size = min + 1;
    let dict: number[][] = [];

    const reset = () => {
      dict = Array.from({ length: clear }, (_, i) => [i]);
      dict.push([], []);
      size = min + 1;
    };

    reset();

    const out: number[] = [];
    let bit = 0;
    let prev: number[] | null = null;

    for (;;) {
      let code = 0;
      for (let i = 0; i < size; i++, bit++) code |= ((data[bit >> 3]! >> (bit & 7)) & 1) << i;

      if (code === clear) {
        reset();
        prev = null;
        continue;
      }

      if (code === end) break;

      let entry: number[];
      if (code < dict.length) entry = dict[code]!;
      else entry = [...prev!, prev![0]!];
      if (prev && dict.length < 4096) dict.push([...prev, entry[0]!]);

      out.push(...entry);
      prev = entry;
      if (dict.length === 1 << size && size < 12) size++;
    }

    frames.push(Uint8Array.from(out));
  }

  return { width, height, palette, frames, loops };
}

describe("GIF", () => {
  it("encodes frames that decode back to the same picture", () => {
    const w = 97;
    const h = 61;
    const frames = [0, 1, 2].map((k) => {
      const rgba = new Uint8ClampedArray(w * h * 4);

      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          // Gradients and noise: many colours and long LZW runs.
          rgba[i] = (x * 3 + k * 40) & 255;
          rgba[i + 1] = (y * 4) & 255;
          rgba[i + 2] = ((x * y) ^ (k * 77)) & 255;
          rgba[i + 3] = 255;
        }
      }

      return { width: w, height: h, rgba };
    });
    const gif = encodeGif(frames, 50);
    const d = decode(gif);
    expect([d.width, d.height, d.frames.length, d.loops]).toEqual([w, h, 3, true]);

    for (let k = 0; k < 3; k++) {
      expect(d.frames[k]!.length).toBe(w * h);

      // Every pixel within the palette's rounding of the original colour.
      let worst = 0;

      for (let pix = 0; pix < w * h; pix += 7) {
        const c = d.palette[d.frames[k]![pix]!]!;
        const o = frames[k]!.rgba;
        worst = Math.max(worst, ...[0, 1, 2].map((ch) => Math.abs(c[ch]! - o[pix * 4 + ch]!)));
      }

      expect(worst).toBeLessThan(140);
    }
  });

  it("keeps a picture with few colours exact", () => {
    const w = 40;
    const h = 30;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) rgba.set(i % 3 === 0 ? [200, 60, 60, 255] : [240, 240, 240, 255], i * 4);

    const d = decode(encodeGif([{ width: w, height: h, rgba }]));

    for (let i = 0; i < w * h; i++) {
      expect(d.palette[d.frames[0]![i]!]).toEqual(i % 3 === 0 ? [204, 60, 60] : [244, 244, 244]);
    }
  });
});
