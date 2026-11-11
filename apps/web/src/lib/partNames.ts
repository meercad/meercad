/** Parts named in a tool call (no app state: usable in tests). */

/**
 * Part ids from names a call gives: a part id, or a folder of the parts list (its name, any case)
 * for all its parts. An unknown name fails at once and names what comes close (a call that waited
 * minutes for a picture of "kopf" should learn the part is "kopf_schale").
 */
export function partsNamed(names: readonly string[], ids: readonly string[], groups: readonly { name: string; parts: readonly string[] }[] = []): string[] {
  const known = new Set(ids);
  const out: string[] = [];
  for (const name of names) {
    if (known.has(name)) {
      out.push(name);
      continue;
    }
    const group = groups.find((g) => g.name.toLowerCase() === name.toLowerCase());
    if (group) {
      out.push(...group.parts.filter((p) => known.has(p)));
      continue;
    }
    const low = name.toLowerCase();
    const close = ids.filter((id) => id.toLowerCase().includes(low));
    const folders = groups.filter((g) => g.name.toLowerCase().includes(low)).map((g) => `folder "${g.name}"`);
    const hint = [...folders, ...close.slice(0, 12)];
    throw new Error(`no part "${name}"${hint.length ? `; close: ${hint.join(", ")}${close.length > 12 ? `, … (${close.length} parts)` : ""}` : ""}`);
  }
  return [...new Set(out)];
}
