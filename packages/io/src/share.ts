/**
 * Share links (§5.6): the document is deflated and base64url-encoded into the URL *fragment*,
 * which browsers never send to the server.
 */

const PREFIX = "m1.";

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([data as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function encodeShareFragment(doc: unknown): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(doc));
  return PREFIX + toBase64Url(await pipe(json, new CompressionStream("deflate-raw")));
}

/** Returns the parsed (still unvalidated) JSON, or throws if the fragment is not a share link. */
export async function decodeShareFragment(fragment: string): Promise<unknown> {
  const s = fragment.replace(/^#/, "");
  if (!s.startsWith(PREFIX)) throw new Error("not a meerCAD share link");
  const raw = await pipe(fromBase64Url(s.slice(PREFIX.length)), new DecompressionStream("deflate-raw"));
  if (raw.byteLength > 16 * 1024 * 1024) throw new Error("share link too large");
  return JSON.parse(new TextDecoder().decode(raw)) as unknown;
}
