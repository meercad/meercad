/**
 * File formats read back by an independent reader: GIF frames decoded with a plain LZW decoder
 * and compared pixel by pixel, DXF in its older POLYLINE form, and broken STL files refused.
 */
import { describe, expect, it } from "vitest";
import { encodeGif, parseStl, readDxf, readStl, writeStl, writeSvg } from "./index.js";

/** A straightforward GIF decoder (89a, global palette, no interlace), written from the spec. */
function decodeGif(data: Uint8Array): { width: number; height: number; frames: number[][]; palette: number[][]; delays: number[]; loops: boolean } {
  let p = 0;
  const u8 = () => data[p++]!;
  const u16 = () => data[p++]! | (data[p++]! << 8);
  const sig = String.fromCharCode(...data.subarray(0, 6));
  if (sig !== "GIF89a") throw new Error(`not a GIF89a: ${sig}`);
  p = 6;
  const width = u16(), height = u16();
  const flags = u8();
  u8();
  u8();
  const palette: number[][] = [];
  if (flags & 0x80) for (let i = 0; i < 1 << ((flags & 7) + 1); i++) palette.push([u8(), u8(), u8()]);
  const frames: number[][] = [], delays: number[] = [];
  let loops = false;
  for (;;) {
    const b = u8();
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = u8();
      const blocks: number[][] = [];
      for (let n = u8(); n; n = u8()) blocks.push([...data.subarray(p, (p += n))]);
      if (label === 0xf9) delays.push(blocks[0]![1]! | (blocks[0]![2]! << 8));
      if (label === 0xff && String.fromCharCode(...blocks[0]!) === "NETSCAPE2.0") loops = true;
      continue;
    }
    if (b !== 0x2c) throw new Error(`unexpected block ${b}`);
    p += 8;
    if (u8() & 0x80) throw new Error("local palettes not expected");
    const minSize = u8();
    const bytes: number[] = [];
    for (let n = u8(); n; n = u8()) bytes.push(...data.subarray(p, (p += n)));
    // LZW decode.
    const clear = 1 << minSize, end = clear + 1;
    let size = minSize + 1, dict: number[][] = [], prev: number[] | null = null;
    const reset = () => {
      dict = Array.from({ length: end + 1 }, (_, i) => (i < clear ? [i] : []));
      size = minSize + 1;
      prev = null;
    };
    reset();
    const out: number[] = [];
    let acc = 0, bits = 0, i = 0;
    for (;;) {
      while (bits < size) {
        if (i >= bytes.length) throw new Error("ran out of data before the end code");
        acc |= bytes[i++]! << bits;
        bits += 8;
      }
      const code = acc & ((1 << size) - 1);
      acc >>>= size;
      bits -= size;
      if (code === clear) {
        reset();
        continue;
      }
      if (code === end) break;
      let entry: number[];
      if (code < dict.length) entry = dict[code]!;
      else if (code === dict.length && prev) entry = [...prev, prev[0]!];
      else throw new Error(`bad code ${code} with ${dict.length} entries`);
      out.push(...entry);
      if (prev && dict.length < 4096) dict.push([...prev, entry[0]!]);
      prev = entry;
      if (dict.length === 1 << size && size < 12) size++;
    }
    frames.push(out);
  }
  return { width, height, frames, palette, delays, loops };
}

describe("GIF", () => {
  const frame = (w: number, h: number, px: (x: number, y: number) => [number, number, number]) => {
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set([...px(x, y), 255], (y * w + x) * 4);
    return { width: w, height: h, rgba };
  };

  it("decodes back to the same picture, frame by frame, looping, with the delay", () => {
    const a = frame(40, 30, (x, y) => (x < 20 ? [255, 0, 0] : y < 15 ? [0, 255, 0] : [0, 0, 255]));
    const b = frame(40, 30, (x) => (x % 2 ? [255, 255, 255] : [0, 0, 0]));
    const gif = decodeGif(encodeGif([a, b], 100));
    expect([gif.width, gif.height, gif.frames.length, gif.loops]).toEqual([40, 30, 2, true]);
    expect(gif.delays).toEqual([10, 10]);
    for (const [k, f] of [a, b].entries()) {
      const got = gif.frames[k]!;
      expect(got).toHaveLength(40 * 30);
      for (let p = 0; p < got.length; p++) {
        const c = gif.palette[got[p]!]!;
        // Colours are kept to 5 bits per channel: within 8 of the original.
        for (let ch = 0; ch < 3; ch++) expect(Math.abs(c[ch]! - f.rgba[p * 4 + ch]!), `frame ${k} pixel ${p}`).toBeLessThanOrEqual(8);
      }
    }
  });

  it("stays exact when the code table fills up and starts again (a large noisy frame)", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 6) * 50;
    const f = frame(256, 256, () => [rnd(), rnd(), rnd()]);
    const gif = decodeGif(encodeGif([f]));
    const got = gif.frames[0]!;
    expect(got).toHaveLength(256 * 256);
    let worst = 0;
    for (let p = 0; p < got.length; p++) for (let ch = 0; ch < 3; ch++) worst = Math.max(worst, Math.abs(gif.palette[got[p]!]![ch]! - f.rgba[p * 4 + ch]!));
    expect(worst).toBeLessThanOrEqual(8);
  });

  it("refuses no frames and frames of different sizes", () => {
    expect(() => encodeGif([])).toThrow(/no frames/);
    expect(() => encodeGif([frame(4, 4, () => [0, 0, 0]), frame(5, 4, () => [0, 0, 0])])).toThrow(/same size/);
  });
});

describe("DXF and SVG", () => {
  it("reads the older POLYLINE / VERTEX / SEQEND form, closed and with a bulge", () => {
    const dxf = [
      "0", "SECTION", "2", "ENTITIES",
      "0", "POLYLINE", "70", "1",
      "0", "VERTEX", "10", "0", "20", "0", "42", "0",
      "0", "VERTEX", "10", "10", "20", "0", "42", "1",
      "0", "VERTEX", "10", "10", "20", "4", "42", "0",
      "0", "VERTEX", "10", "0", "20", "4", "42", "1",
      "0", "SEQEND",
      "0", "LINE", "10", "0", "20", "10", "11", "5", "21", "10",
      "0", "ENDSEC", "0", "EOF",
    ].join("\n");
    const c = readDxf(dxf);
    expect(c.map((x) => x.kind)).toEqual(["line", "arc", "line", "arc", "line"]);
    expect((c[1] as { radius: number }).radius).toBeCloseTo(2, 9);
    expect(c[4]).toMatchObject({ kind: "line", a: [0, 10], b: [5, 10] });
  });

  it("reads entities in a file without an ENTITIES section header", () => {
    expect(readDxf(["0", "CIRCLE", "10", "1", "20", "2", "40", "3", "0", "EOF"].join("\n"))).toEqual([{ kind: "circle", center: [1, 2], radius: 3 }]);
  });

  it("writes an empty drawing as a valid SVG of a small size", () => {
    const svg = writeSvg([]);
    expect(svg).toMatch(/<svg[^>]+width="2mm" height="2mm"/);
  });
});

describe("STL", () => {
  it("refuses a binary file whose size does not match its triangle count", () => {
    const good = writeStl([{ positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) }]);
    expect(() => readStl(good.subarray(0, good.length - 1))).toThrow(/size mismatch/);
  });
  it("reads ASCII STL and refuses a broken one", () => {
    const ascii = "solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n";
    const m = parseStl(new TextEncoder().encode(ascii));
    expect([...m.positions]).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(() => parseStl(new TextEncoder().encode("solid t\nvertex 0 0 0\nvertex 1 x 0\nendsolid\n"))).toThrow(/malformed ASCII STL/);
  });
});
