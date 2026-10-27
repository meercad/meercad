import { Box, ChevronRight, Ellipsis, FileUp, Folder, FolderInput, FolderOpen, FolderPlus, Pencil, Plus, Trash } from "lucide-react";
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

const DRAG_TYPE = "application/x-meercad-project";
const dragging = (e: DragEvent) => e.dataTransfer.types.includes(DRAG_TYPE);
const parentOf = (f: string) => (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "");
const fail = (what: string) => (e: unknown) => toast(`Could not ${what}: ${e instanceof Error ? e.message : String(e)}`, "error");

async function moveTo(id: string, folder: string): Promise<void> {
  await moveProject(id, folder).then(refreshProjects, fail("move the part"));
}

async function addFolder(): Promise<void> {
  const name = await askText({ title: "New folder", label: "Name", value: "New folder", confirmLabel: "Create" });
  if (!name?.trim()) return;
  const parent = useApp.getState().folder;
  await createFolder(parent, name.trim()).then(refreshProjects, fail("create the folder"));
}

function folderMenu(f: string, x: number, y: number): void {
  const name = f.slice(f.lastIndexOf("/") + 1);
  showMenu(x, y, [
    { label: "Open", icon: <FolderOpen />, onClick: () => useApp.setState({ folder: f }) },
    {
      label: "Rename…",
      icon: <Pencil />,
      onClick: async () => {
        const next = await askText({ title: "Rename folder", label: "Name", value: name, confirmLabel: "Rename" });
        if (next?.trim() && next.trim() !== name) await renameFolder(f, next.trim()).then(refreshProjects, fail("rename the folder"));
      },
    },
    ...(desktop ? [{ label: "Show in Finder", icon: <FolderOpen />, onClick: () => void desktop!.projects.reveal({ folder: f }) }] : []),
    "sep",
    {
      label: "Delete folder…",
      icon: <Trash />,
      danger: true,
      onClick: async () => {
        const count = useApp.getState().projects.filter((p) => p.folder === f || p.folder?.startsWith(`${f}/`)).length;
        const ok = await askConfirm({
          title: `Delete "${name}"?`,
          message: count
            ? `It contains ${count} part${count === 1 ? "" : "s"}, which will be deleted too.${desktop ? " Everything goes to the Trash." : " This cannot be undone."}`
            : "The folder is empty.",
          confirmLabel: "Delete folder",
          danger: true,
        });
        if (ok) await deleteFolder(f).then(refreshProjects, fail("delete the folder"));
      },
    },
  ]);
}

function projectMenu(p: ProjectMeta, x: number, y: number): void {
  const { folders } = useApp.getState();
  const current = p.folder ?? "";
  const targets = ["", ...folders].filter((f) => f !== current);
  showMenu(x, y, [
    { label: "Open", icon: <Box />, onClick: () => void openProject(p.id) },
    ...targets.map((f) => ({ label: `Move to ${f ? f.split("/").join(" › ") : "Your projects"}`, icon: <FolderInput />, onClick: () => void moveTo(p.id, f) })),
    ...(desktop ? [{ label: "Show in Finder", icon: <FolderOpen />, onClick: () => void desktop!.projects.reveal(p.id) }] : []),
    "sep",
    {
      label: "Delete…",
      icon: <Trash />,
      danger: true,
      onClick: async () => {
        const ok = await askConfirm({
          title: `Delete "${p.name}"?`,
          message: desktop ? "The project file goes to the Trash." : nativeApp ? "The project file is deleted. This cannot be undone." : "The project is removed from this browser. This cannot be undone.",
          confirmLabel: "Delete part",
          danger: true,
        });
        if (ok) await deleteProject(p.id).then(refreshProjects, fail("delete the part"));
      },
    },
  ]);
}

export function Home() {
  const projects = useApp((s) => s.projects);
  const folders = useApp((s) => s.folders);
  const folder = useApp((s) => s.folder);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  useEffect(() => void refreshProjects(), []);
  const subfolders = folders.filter((f) => parentOf(f) === folder);
  const here = projects.filter((p) => (p.folder ?? "") === folder);
  const crumbs = [{ path: "", label: "Your projects" }, ...folder.split("/").filter(Boolean).map((label, i, all) => ({ path: all.slice(0, i + 1).join("/"), label }))];
  const dropOn = async (e: DragEvent, target: string) => {
    e.preventDefault();
    setDropTarget(null);
    const id = e.dataTransfer.getData(DRAG_TYPE);
    if (id) await moveTo(id, target);
  };
  const ago = (t: number) => {
    const s = (Date.now() - t) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(t).toLocaleDateString();
  };
  return (
    <div className="home">
      <div className={`home-top ${desktop ? "desktop" : ""}`}>
        <span className="home-tab" aria-current="page">
          Projects
        </span>
        <TabStrip />
        <button className="btn" onClick={toggleTheme}>
          Theme
        </button>
        <button className="btn" onClick={() => void importFile()}>
          <FileUp /> Open file
        </button>
        <button className="btn primary" onClick={() => void newProject()}>
          <Plus /> New part
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
          <button className="btn" onClick={() => void addFolder()}>
            <FolderPlus /> New folder
          </button>
          {desktop ? (
            <button className="btn" onClick={() => void desktop!.projects.reveal({ folder })} title="Show this folder in Finder">
              <FolderOpen /> Show in Finder
            </button>
          ) : null}
        </div>
        <p className="sub">
          {desktop ? (
            <>
              Saved as open <span className="mono">.meercad</span> files; folders here are real folders on disk. Drag a part onto a folder to move it.
            </>
          ) : nativeApp ? (
            <>
              Saved as open <span className="mono">.meercad</span> files, in the Files app under On My iPad › meerCAD. Drag a part onto a folder to move it.
            </>
          ) : (
            "Stored only in this browser. Use Share or Export to move them elsewhere. Drag a part onto a folder to move it."
          )}
        </p>
        <div className="grid">
          <button className="card new" onClick={() => void newProject()}>
            <div className="thumb">
              <Plus />
            </div>
            <div className="meta">
              <b>New part</b>
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
                    <small>
                      {count} part{count === 1 ? "" : "s"}
                    </small>
                  </div>
                  <button className="icon-btn sm" title="Folder actions" onClick={(e) => (e.stopPropagation(), folderMenu(f, e.clientX, e.clientY))}>
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
                  <small>{ago(p.updatedAt)}</small>
                </div>
                <button className="icon-btn sm" title="Part actions" onClick={(e) => (e.stopPropagation(), projectMenu(p, e.clientX, e.clientY))}>
                  <Ellipsis />
                </button>
              </div>
            </div>
          ))}
        </div>
        <h1 style={{ marginTop: 36 }}>Start from an example</h1>
        <p className="sub">Fully parametric — open one and change its variables.</p>
        <div className="grid">
          {EXAMPLES.map((ex) => (
            <button className="card" key={ex.name} onClick={() => void newProject(structuredClone(ex.doc), ex.name)}>
              <div className="thumb">
                <img src={ex.thumbnail} alt="" />
              </div>
              <div className="meta">
                <div style={{ minWidth: 0 }}>
                  <b>{ex.name}</b>
                  <small>{ex.description}</small>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
