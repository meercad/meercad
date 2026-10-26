import { readFileSync } from "node:fs";
import { loadOcct, type OC } from "@opencad/kernel";
import type { OpencadDocument } from "@opencad/schema";

let occt: Promise<OC> | null = null;
export const getOcct = () => (occt ??= loadOcct());

export function corpus(name: string): OpencadDocument {
  return JSON.parse(readFileSync(new URL(`../corpus/${name}`, import.meta.url), "utf8")) as OpencadDocument;
}

export function withParams(doc: OpencadDocument, params: Record<string, string | number>): OpencadDocument {
  return { ...doc, params: { ...doc.params, ...params } };
}
