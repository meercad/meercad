/** Reading .meercad files on the MCP server's side. */

/**
 * The design in a .meercad file: the file holds the document itself; a document wrapped as
 * {name, document} (as some scripts write it) is read too, and missing params and rollback
 * are those of an empty design. A .json file may also hold just a list of features.
 */
export function meercadDocument(
  bytes: Uint8Array,
  file: string,
): { doc: Record<string, unknown>; name?: string } {
  let json: unknown;

  try {
    json = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (e) {
    throw new Error(`"${file}" is not a meerCAD file: ${e instanceof Error ? e.message : String(e)}`);
  }

  // A plain list of features (as add_features takes them) is a design of just those.
  if (Array.isArray(json)) json = { features: json };

  const o = json && typeof json === "object" ? (json as Record<string, unknown>) : null;
  const wrapped =
    o && !("format" in o) && o["document"] && typeof o["document"] === "object"
      ? (o["document"] as Record<string, unknown>)
      : null;
  const doc = wrapped ?? o;

  if (!doc || !Array.isArray(doc["features"])) {
    throw new Error(`"${file}" is not a meerCAD file (no features)`);
  }

  // Files written by scripts may leave out what an empty design has.
  const full = {
    ...doc,
    format: doc["format"] ?? "meercad/1",
    params: doc["params"] ?? {},
    rollback: doc["rollback"] ?? null,
  };

  return { doc: full, ...(wrapped && typeof o!["name"] === "string" ? { name: o!["name"] } : {}) };
}
