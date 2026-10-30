import { ArrowDown, ArrowUp, ArrowUpDown, Box, Check, ChevronRight, Ellipsis, FileUp, Folder, FolderInput, FolderOpen, FolderPlus, Pencil, Plus, Trash } from "lucide-react";
import { useEffect, useState, type DragEvent } from "react";
import { askConfirm, askText } from "./Ask";
import { showMenu } from "./Menu";
import { nativeApp } from "../lib/native";
import { createFolder, deleteFolder, deleteProject, desktop, moveProject, renameFolder, type ProjectMeta } from "../lib/persistence";
import { newProject, openProject, refreshProjects, toast, useApp } from "../store";
import { EXAMPLES } from "../lib/examples";
import { importFile } from "./io";
import { toggleTheme } from "./TopBar";
import { TabStrip } from "./Tabs";
import { exampleThumbnail, fillThumbnails } from "../lib/thumbnails";
import { t, tn } from "../lib/i18n";

const DRAG_TYPE = "application/x-meercad-project";
const dragging = (e: DragEvent) => e.dataTransfer.types.includes(DRAG_TYPE);
const parentOf = (f: string) => (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "");
/** `text` is a translated message with a {msg} placeholder for the error. */
const fail = (text: string) => (e: unknown) => toast(text.replace("{msg}", e instanceof Error ? e.message : String(e)), "error");
/** A translated text with {ext} shown as the file extension. */
const withExt = (s: string) => {
  const [a, b] = s.split("{ext}");
  return (
    <>
      {a}
      <span className="mono">.meercad</span>
      {b}
    </>
  );
};

type SortKey = "edited" | "created" | "name";
interface Sort {
  key: SortKey;
  /** Newest or A first. */
  asc: boolean;
}
const SORT_KEY = "meercad.sort";
const SORT_LABELS: Record<SortKey, string> = { edited: t("Last edited"), created: t("Created"), name: t("Name") };
function loadSort(): Sort {
  try {
    const s = JSON.parse(localStorage.getItem(SORT_KEY) ?? "null") as Sort | null;
    if (s && s.key in SORT_LABELS) return s;
  } catch {
    // default below
  }
  return { key: "edited", asc: false };
}
const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
/** Projects in the chosen order; names break ties so the order never jumps. */
function sortProjects(list: ProjectMeta[], s: Sort): ProjectMeta[] {
  const value = (p: ProjectMeta) => (s.key === "created" ? (p.createdAt ?? p.updatedAt) : p.updatedAt);
  const cmp = (a: ProjectMeta, b: ProjectMeta) => (s.key === "name" ? byName(a.name, b.name) : value(a) - value(b)) || byName(a.name, b.name);
  return [...list].sort((a, b) => (s.asc ? cmp(a, b) : -cmp(a, b)));
}

async function moveTo(id: string, folder: string): Promise<void> {
  await moveProject(id, folder).then(refreshProjects, fail(t("Could not move the part: {msg}")));
}

async function addFolder(): Promise<void> {
  const name = await askText({ title: t("New folder"), label: t("Name"), value: t("New folder"), confirmLabel: t("Create") });
  if (!name?.trim()) return;
  const parent = useApp.getState().folder;
  await createFolder(parent, name.trim()).then(refreshProjects, fail(t("Could not create the folder: {msg}")));
}

function folderMenu(f: string, x: number, y: number): void {
  const name = f.slice(f.lastIndexOf("/") + 1);
  showMenu(x, y, [
    { label: t("Open"), icon: <FolderOpen />, onClick: () => useApp.setState({ folder: f }) },
    {
      label: t("Rename…"),
      icon: <Pencil />,
      onClick: async () => {
        const next = await askText({ title: t("Rename folder"), label: t("Name"), value: name, confirmLabel: t("Rename") });
        if (next?.trim() && next.trim() !== name) await renameFolder(f, next.trim()).then(refreshProjects, fail(t("Could not rename the folder: {msg}")));
      },
    },
    ...(desktop ? [{ label: t("Show in Finder"), icon: <FolderOpen />, onClick: () => void desktop!.projects.reveal({ folder: f }) }] : []),
    "sep",
    {
      label: t("Delete folder…"),
      icon: <Trash />,
      danger: true,
      onClick: async () => {
        const count = useApp.getState().projects.filter((p) => p.folder === f || p.folder?.startsWith(`${f}/`)).length;
        const ok = await askConfirm({
          title: t("Delete “{name}”?", { name }),
          message: count
            ? `${tn(count, "It contains {n} part, which will be deleted too.", "It contains {n} parts, which will be deleted too.")} ${desktop ? t("Everything goes to the Trash.") : t("This cannot be undone.")}`
            : t("The folder is empty."),
          confirmLabel: t("Delete folder"),
          danger: true,
        });
        if (ok) await deleteFolder(f).then(refreshProjects, fail(t("Could not delete the folder: {msg}")));
      },
    },
  ]);
}

function projectMenu(p: ProjectMeta, x: number, y: number): void {
  const { folders } = useApp.getState();
  const current = p.folder ?? "";
  const targets = ["", ...folders].filter((f) => f !== current);
  showMenu(x, y, [
    { label: t("Open"), icon: <Box />, onClick: () => void openProject(p.id) },
    ...targets.map((f) => ({ label: t("Move to {folder}", { folder: f ? f.split("/").join(" › ") : t("Your projects") }), icon: <FolderInput />, onClick: () => void moveTo(p.id, f) })),
    ...(desktop ? [{ label: t("Show in Finder"), icon: <FolderOpen />, onClick: () => void desktop!.projects.reveal(p.id) }] : []),
    "sep",
    {
      label: t("Delete…"),
      icon: <Trash />,
      danger: true,
      onClick: async () => {
        const ok = await askConfirm({
          title: t("Delete “{name}”?", { name: p.name }),
          message: desktop ? t("The project file goes to the Trash.") : nativeApp ? t("The project file is deleted. This cannot be undone.") : t("The project is removed from this browser. This cannot be undone."),
          confirmLabel: t("Delete part"),
          danger: true,
        });
        if (ok) await deleteProject(p.id).then(refreshProjects, fail(t("Could not delete the part: {msg}")));
      },
    },
  ]);
}

export function Home() {
  const projects = useApp((s) => s.projects);
  const folders = useApp((s) => s.folders);
  const folder = useApp((s) => s.folder);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [sort, setSort] = useState(loadSort);
  useEffect(() => void refreshProjects(), []);
  // Files added from outside (or never opened here) get their picture while the overview is open.
  const [, setShots] = useState(0);
  useEffect(() => void fillThumbnails(EXAMPLES, () => setShots((n) => n + 1)), [projects]);
  const changeSort = (s: Sort) => {
    setSort(s);
    try {
      localStorage.setItem(SORT_KEY, JSON.stringify(s));
    } catch {
      // the order just isn't remembered
    }
  };
  const subfolders = folders.filter((f) => parentOf(f) === folder).sort((a, b) => (sort.key === "name" && !sort.asc ? -byName(a, b) : byName(a, b)));
  const here = sortProjects(
    projects.filter((p) => (p.folder ?? "") === folder),
    sort,
  );
  const dirLabel = sort.key === "name" ? (sort.asc ? t("A to Z") : t("Z to A")) : sort.asc ? t("Oldest first") : t("Newest first");
  const crumbs = [{ path: "", label: t("Your projects") }, ...folder.split("/").filter(Boolean).map((label, i, all) => ({ path: all.slice(0, i + 1).join("/"), label }))];
  const dropOn = async (e: DragEvent, target: string) => {
    e.preventDefault();
    setDropTarget(null);
    const id = e.dataTransfer.getData(DRAG_TYPE);
    if (id) await moveTo(id, target);
  };
  const ago = (time: number) => {
    const s = (Date.now() - time) / 1000;
    if (s < 60) return t("just now");
    if (s < 3600) return t("{n} min ago", { n: Math.round(s / 60) });
    if (s < 86400) return t("{n} h ago", { n: Math.round(s / 3600) });
    return new Date(time).toLocaleDateString();
  };
  return (
    <div className="home">
      <div className={`home-top ${desktop ? "desktop" : ""}`}>
        <span className="home-tab" aria-current="page">
          {t("Projects")}
        </span>
        <TabStrip />
        <button className="btn" onClick={toggleTheme}>
          {t("Theme")}
        </button>
        <button className="btn" onClick={() => void importFile()}>
          <FileUp /> {t("Open file")}
        </button>
        <button className="btn primary" onClick={() => void newProject()}>
          <Plus /> {t("New part")}
        </button>
      </div>
      <div className="home-main">
        <div className="home-head">
          <h1 className="crumbs">
            {crumbs.map((c, i) => (
              <span key={c.path}>
                {i ? <ChevronRight className="crumb-sep" /> : null}
                <button
                  className={`crumb ${i === crumbs.length - 1 ? "current" : ""}`}
                  onClick={() => useApp.setState({ folder: c.path })}
                  onDragOver={(e) => dragging(e) && e.preventDefault()}
                  onDrop={(e) => void dropOn(e, c.path)}
                >
                  {c.label}
                </button>
              </span>
            ))}
          </h1>
          <span className="spacer" />
          <button
            className="btn"
            title={t("Sort parts")}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              showMenu(
                r.left,
                r.bottom + 4,
                (Object.keys(SORT_LABELS) as SortKey[]).map((k) => ({ label: SORT_LABELS[k], icon: k === sort.key ? <Check /> : <span />, onClick: () => changeSort({ key: k, asc: k === "name" }) })),
              );
            }}
          >
            <ArrowUpDown /> {SORT_LABELS[sort.key]}
          </button>
          <button className="btn" onClick={() => changeSort({ ...sort, asc: !sort.asc })} title={t("{order} — click to reverse", { order: dirLabel })} aria-label={t("Order: {order}", { order: dirLabel })}>
            {sort.asc ? <ArrowUp /> : <ArrowDown />} {dirLabel}
          </button>
          <button className="btn" onClick={() => void addFolder()}>
            <FolderPlus /> {t("New folder")}
          </button>
          {desktop ? (
            <button className="btn" onClick={() => void desktop!.projects.reveal({ folder })} title={t("Show this folder in Finder")}>
              <FolderOpen /> {t("Show in Finder")}
            </button>
          ) : null}
        </div>
        <p className="sub">
          {desktop ? (
            withExt(t("Saved as open {ext} files; folders here are real folders on disk. Drag a part onto a folder to move it."))
          ) : nativeApp ? (
            withExt(t("Saved as open {ext} files, in the Files app under On My {device} › meerCAD. Drag a part onto a folder to move it.", { device: /iPhone/.test(navigator.userAgent) ? "iPhone" : "iPad" }))
          ) : (
            t("Stored only in this browser. Use Share or Export to move them elsewhere. Drag a part onto a folder to move it.")
          )}
        </p>
        <div className="grid">
          <button className="card new" onClick={() => void newProject()}>
            <div className="thumb">
              <Plus />
            </div>
            <div className="meta">
              <b>{t("New part")}</b>
            </div>
          </button>
          {subfolders.map((f) => {
            const count = projects.filter((p) => p.folder === f || p.folder?.startsWith(`${f}/`)).length;
            const name = f.slice(f.lastIndexOf("/") + 1);
            return (
              <div
                key={f}
                className={`card folder ${dropTarget === f ? "drop" : ""}`}
                role="button"
                tabIndex={0}
                onClick={() => useApp.setState({ folder: f })}
                onKeyDown={(e) => e.key === "Enter" && useApp.setState({ folder: f })}
                onContextMenu={(e) => (e.preventDefault(), folderMenu(f, e.clientX, e.clientY))}
                onDragOver={(e) => {
                  if (!dragging(e)) return;
                  e.preventDefault();
                  setDropTarget(f);
                }}
                onDragLeave={() => setDropTarget(null)}
                onDrop={(e) => void dropOn(e, f)}
              >
                <div className="thumb">
                  <Folder />
                </div>
                <div className="meta">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <b>{name}</b>
                    <small>{tn(count, "{n} part", "{n} parts")}</small>
                  </div>
                  <button className="icon-btn sm" title={t("Folder actions")} onClick={(e) => (e.stopPropagation(), folderMenu(f, e.clientX, e.clientY))}>
                    <Ellipsis />
                  </button>
                </div>
              </div>
            );
          })}
          {here.map((p) => (
            <div
              className="card"
              key={p.id}
              role="button"
              tabIndex={0}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_TYPE, p.id);
                e.dataTransfer.effectAllowed = "move";
              }}
              onClick={() => void openProject(p.id)}
              onKeyDown={(e) => e.key === "Enter" && void openProject(p.id)}
              onContextMenu={(e) => (e.preventDefault(), projectMenu(p, e.clientX, e.clientY))}
            >
              <div className="thumb">{p.thumbnail ? <img src={p.thumbnail} alt="" draggable={false} /> : <Box size={32} />}</div>
              <div className="meta">
                <div style={{ minWidth: 0, flex: 1 }}>
                  <b>{p.name}</b>
                  <small>{sort.key === "created" && p.createdAt ? t("Created {when}", { when: ago(p.createdAt) }) : ago(p.updatedAt)}</small>
                </div>
                <button className="icon-btn sm" title={t("Part actions")} onClick={(e) => (e.stopPropagation(), projectMenu(p, e.clientX, e.clientY))}>
                  <Ellipsis />
                </button>
              </div>
            </div>
          ))}
        </div>
        <h1 style={{ marginTop: 36 }}>{t("Start from an example")}</h1>
        <p className="sub">{t("Fully parametric — open one and change its variables.")}</p>
        <div className="grid">
          {EXAMPLES.map((ex) => (
            <button className="card" key={ex.name} onClick={() => void newProject(structuredClone(ex.doc), t(ex.name))}>
              <div className="thumb">
                {ex.thumbnail ?? exampleThumbnail(ex.name, ex.doc) ? <img src={ex.thumbnail ?? exampleThumbnail(ex.name, ex.doc)!} alt="" /> : <Box size={32} />}
              </div>
              <div className="meta">
                <div style={{ minWidth: 0 }}>
                  <b>{t(ex.name)}</b>
                  <small>{t(ex.description)}</small>
                </div>
              </div>
            </button>
          ))}
        </div>
        <footer className="home-footer">
          {(
            [
              ["about", t("About meerCAD")],
              ["privacy", t("Privacy")],
              ["licenses", t("Licences")],
            ] as const
          ).map(([tab, label], i) => (
            <span key={tab}>
              {i ? " · " : null}
              <button className="link" onClick={() => window.dispatchEvent(new CustomEvent("meercad:about", { detail: tab }))}>
                {label}
              </button>
            </span>
          ))}
        </footer>
      </div>
    </div>
  );
}
