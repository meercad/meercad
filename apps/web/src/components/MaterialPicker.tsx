/**
 * The material picker: sphere swatches of the library and the user's own materials, a search, and
 * the chosen material's data (density, print temperatures, hardness, a note, the parts' mass).
 * A tap or click gives the material to all parts it was opened for, at once; the picker stays
 * open to compare. Own materials are made from any material with an own name and colour.
 * Works with mouse and keys on the Mac and by touch on the iPad (no keyboard needed: the search
 * only takes the focus where there is a keyboard).
 */
import { Check, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatMass, massOf, MATERIALS, partMaterial, type Material } from "@meercad/model";
import { useApp } from "../store";
import { t, tn } from "../lib/i18n";
import { usePrefs } from "../lib/keymap";
import {
  assignMaterial,
  deleteOwnMaterial,
  materialFacts,
  materialName,
  materialSwatches,
  pickerMaterials,
  saveOwnMaterial,
  sharedMaterial,
} from "../lib/materials";
import { PART_PALETTE, partColors } from "../lib/partColors";
import { partName } from "../lib/features";
import "../materials.css";

/** Opens the picker for parts (body ids), from menus, the command palette and assistants. */
export const openMaterialPicker = (parts: readonly string[]) =>
  window.dispatchEvent(new CustomEvent("meercad:materials", { detail: [...parts] }));

const GROUPS: { key: string; label: string; test: (material: Material) => boolean }[] = [
  { key: "own", label: t("Your materials"), test: (material) => !!material.base },
  {
    key: "filament",
    label: t("Filament"),
    test: (material) => !material.base && material.kind === "print" && !!material.filament,
  },
  {
    key: "resin",
    label: t("Resin"),
    test: (material) => !material.base && material.kind === "print" && !material.filament,
  },
  {
    key: "other",
    label: t("Metal, wood and more"),
    test: (material) => !material.base && material.kind !== "print",
  },
];

interface Draft {
  id?: string;
  name: string;
  base: string;
  color: string;
  density: string;
}

export function MaterialPicker() {
  const [parts, setParts] = useState<string[] | null>(null);
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const doc = useApp((state) => state.doc);
  const bodies = useApp((state) => state.output?.report.bodies);
  const colorParts = usePrefs((prefs) => prefs.colorParts);

  useEffect(() => {
    const show = (event: Event) => {
      setParts((event as CustomEvent<string[]>).detail);
      setQuery("");
      setDraft(null);
      setFocus(null);
    };

    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setParts(null);
    window.addEventListener("meercad:materials", show);
    window.addEventListener("keydown", onKey);

    return () => {
      window.removeEventListener("meercad:materials", show);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const all = useMemo(() => pickerMaterials(doc), [doc]);
  const ids = bodies?.map((b) => b.id) ?? [];
  // Materials without a colour of their own are shown in the part's colour.
  const partColor = parts?.length
    ? (doc.partColors?.[parts[0]!] ??
      partColors({ ...doc, partMaterials: {} }, ids, colorParts).get(parts[0]!) ??
      PART_PALETTE[0])
    : PART_PALETTE[0];
  const swatches = useMemo(
    () => (parts ? materialSwatches(all, partColor) : new Map<string, string>()),
    [parts, all, partColor],
  );
  if (!parts) return null;

  const current = sharedMaterial(doc, parts);
  const shown = focus ? (all.find((material) => material.id === focus) ?? current) : current;
  const q = query.trim().toLowerCase();
  const matches = (material: Material) =>
    !q ||
    [materialName(material), material.name, material.filament ?? "", material.notes, t(material.notes)].some(
      (s) => s.toLowerCase().includes(q),
    );
  const volume = parts.reduce((sum, id) => sum + (bodies?.find((b) => b.id === id)?.volume ?? 0), 0);
  const title =
    parts.length === 1 ? partName(parts[0]!, doc.features) : tn(parts.length, "{n} part", "{n} parts");
  const mixed = !current && parts.some((p) => partMaterial(doc, p));

  const choose = (material: Material) => {
    setFocus(material.id);
    if (current?.id !== material.id || mixed) assignMaterial(parts, material.id);
  };

  const startOwn = (from: Material) =>
    setDraft({
      name: from.base ? from.name : t("My {material}", { material: materialName(from) }),
      base: from.base ?? from.id,
      color: from.look.color ?? partColor,
      density: "",
    });

  const editOwn = (material: Material) => {
    const own = doc.materials?.find((x) => x.id === material.id);

    if (own) {
      setDraft({
        id: own.id,
        name: own.name,
        base: own.base,
        color: own.color ?? partColor,
        density: own.density ? String(own.density) : "",
      });
    }
  };

  const saveDraft = () => {
    if (!draft || !draft.name.trim()) return;

    const density = Number(draft.density.replace(",", "."));
    const id = saveOwnMaterial(
      doc,
      {
        ...(draft.id ? { id: draft.id } : {}),
        name: draft.name.trim(),
        base: draft.base,
        color: draft.color,
        ...(draft.density.trim() && density > 0 ? { density } : {}),
      },
      draft.id ? [] : parts,
    );

    if (id) {
      setFocus(id);
      setDraft(null);
    }
  };

  const fineKeys = matchMedia("(pointer: fine)").matches;

  return (
    <div className="modal-backdrop" onPointerDown={() => setParts(null)}>
      <div
        className="modal settings material-picker"
        role="dialog"
        aria-label={t("Material")}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="settings-head">
          <h2>
            {t("Material")} <span className="muted">· {title}</span>
          </h2>
          <button className="icon-btn" onClick={() => setParts(null)} title={t("Close (Esc)")}>
            <X />
          </button>
        </header>
        <div className="mat-search">
          <Search />
          <input
            className="field"
            type="search"
            value={query}
            autoFocus={fineKeys}
            placeholder={t("Search materials")}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="mat-body">
          <div className="mat-groups">
            {GROUPS.map((g) => {
              const list = all.filter((material) => g.test(material) && matches(material));
              if (!list.length && g.key !== "own") return null;
              if (!list.length && q) return null;

              return (
                <section key={g.key}>
                  <h3>{g.label}</h3>
                  <div className="mat-grid">
                    {list.map((material) => (
                      <button
                        key={material.id}
                        className={`mat-tile ${current?.id === material.id ? "chosen" : ""} ${shown?.id === material.id ? "focus" : ""}`}
                        onClick={() => choose(material)}
                        title={t(material.notes)}
                      >
                        {swatches.get(material.id) ? (
                          <img src={swatches.get(material.id)} alt="" draggable={false} />
                        ) : (
                          <span
                            className="mat-dot"
                            style={{ background: material.look.color ?? partColor }}
                          />
                        )}
                        <span className="mat-name">{materialName(material)}</span>
                        <span className="mat-sub">{material.density} g/cm³</span>
                        {current?.id === material.id ? <Check className="mat-check" /> : null}
                      </button>
                    ))}
                    {g.key === "own" && !q ? (
                      <button className="mat-tile mat-new" onClick={() => startOwn(shown ?? MATERIALS[0]!)}>
                        <Plus />
                        <span className="mat-name">{t("New material")}</span>
                        <span className="mat-sub">{t("own name and colour")}</span>
                      </button>
                    ) : null}
                  </div>
                </section>
              );
            })}
            {q && !all.some(matches) ? <p className="muted">{t("No match")}</p> : null}
          </div>
          <aside className="mat-detail">
            {draft ? (
              <div className="mat-form">
                <h3>{draft.id ? t("Edit material") : t("New material")}</h3>
                <label>
                  <span className="fld-label">{t("Name")}</span>
                  <input
                    className="field"
                    value={draft.name}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                    onKeyDown={(event) => event.key === "Enter" && saveDraft()}
                  />
                </label>
                <label>
                  <span className="fld-label">{t("Based on")}</span>
                  <select
                    className="field"
                    value={draft.base}
                    onChange={(event) => setDraft({ ...draft, base: event.target.value })}
                  >
                    {MATERIALS.map((material) => (
                      <option key={material.id} value={material.id}>
                        {t(material.name)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="mat-color">
                  <span className="fld-label">{t("Colour")}</span>
                  <input
                    type="color"
                    value={draft.color}
                    onChange={(event) => setDraft({ ...draft, color: event.target.value })}
                  />
                  <code>{draft.color.toUpperCase()}</code>
                </label>
                <label>
                  <span className="fld-label">{t("Density (g/cm³)")}</span>
                  <input
                    className="field"
                    inputMode="decimal"
                    value={draft.density}
                    placeholder={String(
                      MATERIALS.find((material) => material.id === draft.base)?.density ?? "",
                    )}
                    onChange={(event) => setDraft({ ...draft, density: event.target.value })}
                  />
                </label>
                <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                  <button className="btn primary" disabled={!draft.name.trim()} onClick={saveDraft}>
                    <Check /> {draft.id ? t("Save") : t("Create and use")}
                  </button>
                  <button className="btn" onClick={() => setDraft(null)}>
                    {t("Cancel")}
                  </button>
                </div>
              </div>
            ) : shown ? (
              <div className="mat-info">
                {swatches.get(shown.id) ? (
                  <img className="mat-big" src={swatches.get(shown.id)} alt="" draggable={false} />
                ) : null}
                <h3>{materialName(shown)}</h3>
                {shown.base ? (
                  <p className="muted small">
                    {t("Based on {material}", {
                      material: t(
                        MATERIALS.find((material) => material.id === shown.base)?.name ?? shown.base,
                      ),
                    })}
                  </p>
                ) : null}
                <ul className="mat-facts">
                  {materialFacts(shown).map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                  {volume > 0 ? (
                    <li>
                      {t("{mass} for {parts} (solid)", {
                        mass: formatMass(massOf(volume, shown)),
                        parts: title,
                      })}
                    </li>
                  ) : null}
                </ul>
                <p className="small">{shown.base ? shown.notes : t(shown.notes)}</p>
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  {current?.id !== shown.id ? (
                    <button className="btn primary" onClick={() => choose(shown)}>
                      <Check /> {t("Use")}
                    </button>
                  ) : null}
                  <button className="btn" onClick={() => startOwn(shown)}>
                    <Plus /> {t("Own material from this")}
                  </button>
                  {shown.base ? (
                    <>
                      <button className="btn" onClick={() => editOwn(shown)}>
                        <Pencil /> {t("Edit")}
                      </button>
                      <button className="btn" onClick={() => deleteOwnMaterial(shown.id) && setFocus(null)}>
                        <Trash2 /> {t("Delete")}
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
            ) : (
              <p className="muted small">
                {mixed
                  ? t("The parts have different materials. Pick one to give them all the same.")
                  : t(
                      "Pick a material: the parts get its look, their mass, and the right filament in 3MF exports.",
                    )}
              </p>
            )}
            {current || mixed ? (
              <button className="btn mat-none" onClick={() => (assignMaterial(parts, null), setFocus(null))}>
                <X /> {t("No material")}
              </button>
            ) : null}
          </aside>
        </div>
      </div>
    </div>
  );
}
