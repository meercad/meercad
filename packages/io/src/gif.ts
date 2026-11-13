/**
 * Animated GIF from RGBA frames (for videos of moving parts). One palette for the whole
 * animation, from the most frequent colours (5 bits per channel), so smooth renders stay smooth;
 * LZW-compressed as the format wants. Plays in a loop.
 */

export interface GifFrame {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row by row. */
  rgba: Uint8ClampedArray | Uint8Array;
}

export function encodeGif(frames: readonly GifFrame[], delayMs = 70): Uint8Array {
  if (!frames.length) throw new Error("no frames");

  const { width, height } = frames[0]!;
  const palette = buildPalette(frames);
  const out = new ByteWriter();
  out.text("GIF89a");
  out.u16(width);
  out.u16(height);
  out.byte(0xf7); // global colour table, 8 bits, 256 entries
  out.byte(0);
  out.byte(0);

  for (let i = 0; i < 256; i++) {
    const c = palette.colors[i] ?? 0;
    out.byte((c >> 16) & 255);
    out.byte((c >> 8) & 255);
    out.byte(c & 255);
  }

  // Loop forever (NETSCAPE2.0).
  out.bytes([0x21, 0xff, 0x0b]);
  out.text("NETSCAPE2.0");
  out.bytes([0x03, 0x01, 0x00, 0x00, 0x00]);

  const delay = Math.max(2, Math.round(delayMs / 10));

  for (const f of frames) {
    if (f.width !== width || f.height !== height) throw new Error("all frames must have the same size");

    out.bytes([0x21, 0xf9, 0x04, 0x00]);
    out.u16(delay);
    out.bytes([0x00, 0x00]);
    out.byte(0x2c);
    out.u16(0);
    out.u16(0);
    out.u16(width);
    out.u16(height);
    out.byte(0);

    const indices = new Uint8Array(width * height);

    for (let p = 0; p < indices.length; p++) {
      indices[p] = palette.index(f.rgba[p * 4]!, f.rgba[p * 4 + 1]!, f.rgba[p * 4 + 2]!);
    }

    lzw(indices, 8, out);
  }

  out.byte(0x3b);

  return out.result();
}

/** The 256 most used colours (5 bits per channel), and the nearest one for any colour. */
function buildPalette(frames: readonly GifFrame[]): {
  colors: number[];
  index(r: number, g: number, b: number): number;
} {
  const counts = new Map<number, number>();

  for (const f of frames) {
    const step = Math.max(1, Math.floor(f.rgba.length / 4 / 200000));

    for (let p = 0; p < f.rgba.length / 4; p += step) {
      const k = ((f.rgba[p * 4]! >> 3) << 10) | ((f.rgba[p * 4 + 1]! >> 3) << 5) | (f.rgba[p * 4 + 2]! >> 3);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }

  const keys = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 256)
    .map(([k]) => k);
  const colors = keys.map(
    (k) => ((((k >> 10) & 31) * 8 + 4) << 16) | ((((k >> 5) & 31) * 8 + 4) << 8) | ((k & 31) * 8 + 4),
  );
  const cache = new Map<number, number>();

  return {
    colors,
    index(r, g, b) {
      const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      let i = cache.get(k);

      if (i === undefined) {
        let best = Infinity;
        i = 0;

        for (let j = 0; j < colors.length; j++) {
          const c = colors[j]!;
          const d = (((c >> 16) & 255) - r) ** 2 + (((c >> 8) & 255) - g) ** 2 + ((c & 255) - b) ** 2;

          if (d < best) {
            best = d;
            i = j;
          }
        }

        cache.set(k, i);
      }

      return i;
    },
  };
}

/** GIF's LZW: variable code size, clear code at the start and when the table is full. */
function lzw(indices: Uint8Array, minCodeSize: number, out: ByteWriter): void {
  out.byte(minCodeSize);

  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const block: number[] = [];
  let acc = 0;
  let bits = 0;

  const emit = (code: number, size: number) => {
    acc |= code << bits;
    bits += size;

    while (bits >= 8) {
      block.push(acc & 255);
      acc >>= 8;
      bits -= 8;

      if (block.length === 255) {
        out.byte(255);
        out.bytes(block);
        block.length = 0;
      }
    }
  };

  let dict = new Map<number, number>();
  let next = end + 1;
  let size = minCodeSize + 1;
  emit(clear, size);

  let prefix = indices[0]!;

  for (let i = 1; i < indices.length; i++) {
    const c = indices[i]!;
    const key = (prefix << 8) | c;
    const found = dict.get(key);

    if (found !== undefined) {
      prefix = found;
      continue;
    }

    emit(prefix, size);

    if (next < 4096) {
      dict.set(key, next++);
      if (next > 1 << size && size < 12) size++;
    } else {
      emit(clear, size);
      dict = new Map();
      next = end + 1;
      size = minCodeSize + 1;
    }

    prefix = c;
  }

  emit(prefix, size);
  emit(end, size);
  if (bits > 0) block.push(acc & 255);

  if (block.length) {
    out.byte(block.length);
    out.bytes(block);
  }

  out.byte(0);
}

class ByteWriter {
  private buf = new Uint8Array(1 << 16);
  private n = 0;
  private grow(k: number) {
    if (this.n + k <= this.buf.length) return;

    const b = new Uint8Array(Math.max(this.buf.length * 2, this.n + k));
    b.set(this.buf.subarray(0, this.n));
    this.buf = b;
  }

  byte(v: number) {
    this.grow(1);
    this.buf[this.n++] = v;
  }

  bytes(v: ArrayLike<number>) {
    this.grow(v.length);
    for (let i = 0; i < v.length; i++) this.buf[this.n++] = v[i]!;
  }

  u16(v: number) {
    this.byte(v & 255);
    this.byte((v >> 8) & 255);
  }

  text(s: string) {
    for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i));
  }

  result() {
    return this.buf.slice(0, this.n);
  }
}
