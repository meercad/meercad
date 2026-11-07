/**
 * What someone sees when a design uses a premium pack they do not have (a design shared with
 * them): once per design and session a short note, and a clear hint instead of a dialog when they
 * try to change a part only the pack changes.
 */
import type { Feature, MeercadDocument } from "@meercad/schema";
import { showNotice } from "../components/Ask";
import { t } from "./i18n";
import { lockedBy, missingPacks, PACKS, premiumReady } from "./premium";
import type { PackId } from "./packUse";

/** What the design keeps doing without the pack, and what only the pack does. */
const without = (id: PackId): string =>
  ({
    mechanics: t("Gears, springs and joints are shown and can be moved; changing them needs the Mechanics pack."),
    scan: t("Terrain models are shown; the scan and mesh tools need the Scan and mesh pack."),
    drawings: t("Technical drawings need the Technical drawings pack."),
    versions: t("Variants can be switched; the saved versions stay in the file and are shown with the Versions and variants pack."),
  })[id];

const packName = (id: PackId) => t(PACKS.find((p) => p.id === id)!.name);

/** The note for a design, or null when every pack it uses is on here. */
export function packNote(doc: MeercadDocument): { title: string; message: string } | null {
  const missing = missingPacks(doc);
  if (!missing.length) return null;
  const title = missing.length === 1 ? t("This design uses the {pack} pack", { pack: packName(missing[0]!.pack) }) : t("This design uses the packs {packs}", { packs: missing.map((m) => packName(m.pack)).join(", ") });
  const message = [t("You can look at it, print it and export it, and change everything else as usual. Saving keeps all of it."), ...missing.map((m) => without(m.pack))].join("\n\n");
  return { title, message };
}

const told = new Set<string>();

/** Tells once per design and session which packs it uses that are not on here. */
export async function notePacks(projectId: string, doc: MeercadDocument): Promise<void> {
  if (told.has(projectId)) return;
  // Which packs are on is only known once the shell has answered.
  await premiumReady;
  const note = packNote(doc);
  if (!note || told.has(projectId)) return;
  told.add(projectId);
  await showNotice(note);
}

/** True (after saying why) when the feature can only be changed with a pack that is not on here. */
export function refuseLocked(f: Pick<Feature, "op">, name: string): boolean {
  const pack = lockedBy(f);
  if (!pack) return false;
  void showNotice({
    title: t("{name} needs the {pack} pack", { name, pack: t(pack.name) }),
    message: t("This design came with it, so it stays, builds and exports as it is. Changing it needs the {pack} pack; you can still delete it or change the rest of the design.", { pack: t(pack.name) }),
  });
  return true;
}
