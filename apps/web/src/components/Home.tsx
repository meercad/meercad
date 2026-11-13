import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Box,
  Check,
  ChevronRight,
  Circle,
  CircleCheck,
  Ellipsis,
  FileUp,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  ListChecks,
  Lock,
  LockOpen,
  Pencil,
  Plus,
  Trash,
} from "lucide-react";
import { useEffect, useState, type DragEvent, type MouseEvent, type PointerEvent } from "react";
import { EMPTY_SELECTION, clickSelect, keepShown, toggleAll } from "../lib/multiSelect";
import { askConfirm, askText } from "./Ask";
import { showMenu, type MenuEntry } from "./Menu";
import {
  createFolder,
  deleteFolder,
  deleteProject,
  desktop,
  moveProject,
  renameFolder,
  type ProjectMeta,
} from "../lib/persistence";
import {
  handOverAssistantTab,
  newProject,
  openProject,
  refreshProjects,
  startTask,
  toast,
  useApp,
} from "../store";
import type { MeercadDocument } from "@meercad/schema";
import { EXAMPLES, examplePacks, type Example } from "../lib/examples";
import { hasPack, usePremium } from "../lib/premium";
import { importFile } from "./io";
import { AiOrb } from "./AiOrb";
import { McpButton } from "./McpButton";
import { nativeApp } from "../lib/native";
import { toggleTheme } from "./TopBar";
import { TabStrip } from "./Tabs";
import { exampleThumbnail, fillThumbnails } from "../lib/thumbnails";
import { t, tn } from "../lib/i18n";
import { setPrefs, usePrefs } from "../lib/keymap";
import { sureTap } from "../lib/gestures";
import { openGuard } from "../lib/opening";

const DRAG_TYPE = "application/x-meercad-project";

/** One per card, so a press and its lift reach the same one across re-renders. */
const cardTaps = new Map<string, ReturnType<typeof sureTap>>();

/**
 * A project card opens its project on the first tap (see sureTap): on the iPhone the overview
 * changes under the finger (pictures being made) and iOS then sometimes swallows the click. The
 * buttons on the card do their own thing; opening twice is harmless (openProject waits for the
 * opening running).
 */
function cardTap(id: string) {
  let tap = cardTaps.get(id);
  if (!tap) cardTaps.set(id, (tap = sureTap(() => void openProject(id))));

  const tapper = tap;
  const onCard = (event: PointerEvent) =>
    !(event.target instanceof Element && event.target.closest(".card button"));

  return {
    onClick: tapper.onClick,
    onPointerDown: (event: PointerEvent) =>
      onCard(event) ? tapper.onPointerDown(event) : tapper.onPointerCancel(),
    onPointerUp: (event: PointerEvent) => onCard(event) && tapper.onPointerUp(event),
    onPointerCancel: tapper.onPointerCancel,
  };
}

const dragging = (event: DragEvent) => event.dataTransfer.types.includes(DRAG_TYPE);
const parentOf = (f: string) => (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "");
/** `text` is a translated message with a {msg} placeholder for the error. */
const fail = (text: string) => (e: unknown) =>
  toast(text.replace("{msg}", e instanceof Error ? e.message : String(e)), "error");

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
const SORT_LABELS: Record<SortKey, string> = {
  edited: t("Last edited"),
  created: t("Created"),
  name: t("Name"),
};

function loadSort(): Sort {
  try {
    const s = JSON.parse(localStorage.getItem(SORT_KEY) ?? "null") as Sort | null;
    if (s && s.key in SORT_LABELS) return s;
  } catch {
    // default below
  }

  return { key: "edited", asc: false };
}

const byName = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

/** Projects in the chosen order; names break ties so the order never jumps. */
function sortProjects(list: ProjectMeta[], s: Sort): ProjectMeta[] {
  const value = (project: ProjectMeta) =>
    s.key === "created" ? (project.createdAt ?? project.updatedAt) : project.updatedAt;
  const cmp = (a: ProjectMeta, b: ProjectMeta) =>
    (s.key === "name" ? byName(a.name, b.name) : value(a) - value(b)) || byName(a.name, b.name);

  return [...list].sort((a, b) => (s.asc ? cmp(a, b) : -cmp(a, b)));
}

async function moveTo(id: string, folder: string): Promise<void> {
  await moveProject(id, folder).then(refreshProjects, fail(t("Could not move the part: {msg}")));
}

/** Moves several parts one after the other; reports the ones that failed together. */
async function moveMany(ids: readonly string[], folder: string): Promise<void> {
  let failed = 0;
  let last = "";

  for (const id of ids) {
    await moveProject(id, folder).catch(
      (e: unknown) => ((failed += 1), (last = e instanceof Error ? e.message : String(e))),
    );
  }

  await refreshProjects();

  const where = folder ? folder.split("/").join(" › ") : t("Your projects");

  if (failed) {
    toast(
      tn(failed, "Could not move {n} part: {msg}", "Could not move {n} parts: {msg}", { msg: last }),
      "error",
    );
  } else {
    toast(tn(ids.length, "Moved {n} part to {folder}", "Moved {n} parts to {folder}", { folder: where }));
  }
}

/** Asks once for all of them, then deletes them; true when the user agreed. */
async function deleteMany(ids: readonly string[]): Promise<boolean> {
  if (!ids.length) return false;

  const ok = await askConfirm({
    title: tn(ids.length, "Delete {n} part?", "Delete {n} parts?"),
    message: desktop
      ? t("The project files go to the Trash.")
      : t("The project files are deleted. This cannot be undone."),
    confirmLabel: tn(ids.length, "Delete {n} part", "Delete {n} parts"),
    danger: true,
  });
  if (!ok) return false;

  let failed = 0;
  let last = "";

  for (const id of ids) {
    await deleteProject(id).catch(
      (e: unknown) => ((failed += 1), (last = e instanceof Error ? e.message : String(e))),
    );
  }

  await refreshProjects();

  if (failed) {
    toast(
      tn(failed, "Could not delete {n} part: {msg}", "Could not delete {n} parts: {msg}", { msg: last }),
      "error",
    );
  }

  return true;
}

/** Folders the parts shown in `current` can move to. */
function moveTargets(current: string, pick: (folder: string) => void): MenuEntry[] {
  return ["", ...useApp.getState().folders]
    .filter((f) => f !== current)
    .map((f) => ({
      label: f ? f.split("/").join(" › ") : t("Your projects"),
      icon: f ? <Folder /> : <FolderInput />,
      onClick: () => pick(f),
    }));
}

/** The menu for several selected parts (right-click on one of them, or the Move button). */
function selectionMenu(
  ids: readonly string[],
  current: string,
  x: number,
  y: number,
  done: () => void,
  opts: { above?: boolean; moveOnly?: boolean } = {},
): void {
  const targets = moveTargets(current, (f) => void moveMany(ids, f).then(done));

  if (opts.moveOnly) {
    return showMenu(
      x,
      y,
      targets.length ? targets : [{ label: t("No other folder yet"), disabled: true }],
      opts,
    );
  }

  showMenu(
    x,
    y,
    [
      {
        label: tn(ids.length, "Move {n} part to", "Move {n} parts to"),
        icon: <FolderInput />,
        disabled: !targets.length,
        submenu: targets,
      },
      "sep",
      {
        label: tn(ids.length, "Delete {n} part…", "Delete {n} parts…"),
        icon: <Trash />,
        danger: true,
        onClick: () => void deleteMany(ids).then((ok) => ok && done()),
      },
    ],
    opts,
  );
}

async function addFolder(): Promise<void> {
  const name = await askText({
    title: t("New folder"),
    label: t("Name"),
    value: t("New folder"),
    confirmLabel: t("Create"),
  });
  if (!name?.trim()) return;

  const parent = useApp.getState().folder;
  await createFolder(parent, name.trim()).then(
    refreshProjects,
    fail(t("Could not create the folder: {msg}")),
  );
}

function folderMenu(f: string, x: number, y: number): void {
  const name = f.slice(f.lastIndexOf("/") + 1);
  showMenu(x, y, [
    { label: t("Open"), icon: <FolderOpen />, onClick: () => useApp.setState({ folder: f }) },
    {
      label: t("Rename…"),
      icon: <Pencil />,
      onClick: async () => {
        const next = await askText({
          title: t("Rename folder"),
          label: t("Name"),
          value: name,
          confirmLabel: t("Rename"),
        });

        if (next?.trim() && next.trim() !== name) {
          await renameFolder(f, next.trim()).then(
            refreshProjects,
            fail(t("Could not rename the folder: {msg}")),
          );
        }
      },
    },
    ...(desktop
      ? [
          {
            label: t("Show in Finder"),
            icon: <FolderOpen />,
            onClick: () => void desktop!.projects.reveal({ folder: f }),
          },
        ]
      : []),
    "sep",
    {
      label: t("Delete folder…"),
      icon: <Trash />,
      danger: true,
      onClick: async () => {
        const count = useApp
          .getState()
          .projects.filter((project) => project.folder === f || project.folder?.startsWith(`${f}/`)).length;
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

function projectMenu(project: ProjectMeta, x: number, y: number): void {
  const { folders } = useApp.getState();
  const current = project.folder ?? "";
  const targets = ["", ...folders].filter((f) => f !== current);
  showMenu(x, y, [
    { label: t("Open"), icon: <Box />, onClick: () => void openProject(project.id) },
    ...targets.map((f) => ({
      label: t("Move to {folder}", { folder: f ? f.split("/").join(" › ") : t("Your projects") }),
      icon: <FolderInput />,
      onClick: () => void moveTo(project.id, f),
    })),
    ...(desktop
      ? [
          {
            label: t("Show in Finder"),
            icon: <FolderOpen />,
            onClick: () => void desktop!.projects.reveal(project.id),
          },
        ]
      : []),
    "sep",
    {
      label: t("Delete…"),
      icon: <Trash />,
      danger: true,
      onClick: async () => {
        const ok = await askConfirm({
          title: t("Delete “{name}”?", { name: project.name }),
          message: desktop
            ? t("The project file goes to the Trash.")
            : t("The project file is deleted. This cannot be undone."),
          confirmLabel: t("Delete part"),
          danger: true,
        });

        if (ok) {
          await deleteProject(project.id).then(refreshProjects, fail(t("Could not delete the part: {msg}")));
        }
      },
    },
  ]);
}

export function Home() {
  const projects = useApp((state) => state.projects);
  const folders = useApp((state) => state.folders);
  // Only the examples this app can show and change with the packs it has.
  usePremium();

  const examples = EXAMPLES.filter((example) => examplePacks(example).every(hasPack));
  const folder = useApp((state) => state.folder);
  const prefs = usePrefs();
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

  const subfolders = folders
    .filter((f) => parentOf(f) === folder)
    .sort((a, b) => (sort.key === "name" && !sort.asc ? -byName(a, b) : byName(a, b)));
  const here = sortProjects(
    projects.filter((project) => (project.folder ?? "") === folder),
    sort,
  );
  // Selecting several parts: tap/click toggles while `selecting`; Cmd/Ctrl/Shift-click starts it.
  const [selecting, setSelecting] = useState(false);
  const [sel, setSel] = useState(EMPTY_SELECTION);
  // Projects an assistant works on in its tab: a click opens that tab.
  const assistantTabs = useApp((state) => state.assistantTabs);
  const order = here.map((project) => project.id);
  const orderKey = order.join("\n");
  const stopSelecting = () => (setSelecting(false), setSel(EMPTY_SELECTION));
  useEffect(stopSelecting, [folder]);
  useEffect(
    () => setSel((selection) => keepShown(selection, orderKey ? orderKey.split("\n") : [])),
    [orderKey],
  );
  useEffect(() => {
    if (!selecting) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector(".ask-backdrop, .modal-backdrop, .menu")) return;

      const typing =
        event.target instanceof HTMLElement &&
        (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName));
      if (typing) return;
      if (event.key === "Escape") return (event.preventDefault(), stopSelecting());

      if (event.key === "a" && (event.metaKey || event.ctrlKey)) {
        return (
          event.preventDefault(),
          setSel((selection) => ({ ids: orderKey ? orderKey.split("\n") : [], anchor: selection.anchor }))
        );
      }

      if ((event.key === "Delete" || event.key === "Backspace") && sel.ids.length) {
        return (event.preventDefault(), void deleteMany(sel.ids).then((ok) => ok && stopSelecting()));
      }
    };

    window.addEventListener("keydown", onKey);

    return () => window.removeEventListener("keydown", onKey);
  }, [selecting, orderKey, sel.ids]);

  const pickCard = (event: MouseEvent | null, id: string) => {
    setSelecting(true);
    setSel((selection) => clickSelect(selection, order, id, !!event?.shiftKey));
  };

  const allSelected = order.length > 0 && order.every((id) => sel.ids.includes(id));
  const dirLabel =
    sort.key === "name"
      ? sort.asc
        ? t("A to Z")
        : t("Z to A")
      : sort.asc
        ? t("Oldest first")
        : t("Newest first");
  const crumbs = [
    { path: "", label: t("Your projects") },
    ...folder
      .split("/")
      .filter(Boolean)
      .map((label, i, all) => ({ path: all.slice(0, i + 1).join("/"), label })),
  ];

  const dropOn = async (event: DragEvent, target: string) => {
    event.preventDefault();
    setDropTarget(null);

    const ids = event.dataTransfer.getData(DRAG_TYPE).split("\n").filter(Boolean);
    if (ids.length > 1) await moveMany(ids, target).then(stopSelecting);
    else if (ids[0]) await moveTo(ids[0], target);
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
        {/* Assistants can be switched on before a project is open; they open or create one themselves. */}
        {nativeApp ? null : (
          <span className="mcp-anchor">
            <McpButton />
          </span>
        )}
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
      <div className={`home-main ${selecting ? "selecting" : ""}`}>
        <div className="home-head">
          <h1 className="crumbs">
            {crumbs.map((c, i) => (
              <span key={c.path}>
                {i ? <ChevronRight className="crumb-sep" /> : null}
                <button
                  className={`crumb ${i === crumbs.length - 1 ? "current" : ""}`}
                  onClick={() => useApp.setState({ folder: c.path })}
                  onDragOver={(event) => dragging(event) && event.preventDefault()}
                  onDrop={(event) => void dropOn(event, c.path)}
                >
                  {c.label}
                </button>
              </span>
            ))}
          </h1>
          <span className="spacer" />
          {selecting ? (
            <>
              <button
                className="btn"
                onClick={() => setSel((selection) => toggleAll(selection, order))}
                disabled={!order.length}
              >
                {allSelected ? t("Select none") : t("Select all")}
              </button>
              <button className="btn primary" onClick={stopSelecting} title={t("Done (Esc)")}>
                {t("Done")}
              </button>
            </>
          ) : (
            <>
              <button
                className="btn"
                onClick={() => setSelecting(true)}
                disabled={!order.length}
                title={t("Select several parts to move or delete them together")}
              >
                <ListChecks /> {t("Select")}
              </button>
              <button
                className="btn"
                title={t("Sort parts")}
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  showMenu(
                    rect.left,
                    rect.bottom + 4,
                    (Object.keys(SORT_LABELS) as SortKey[]).map((k) => ({
                      label: SORT_LABELS[k],
                      icon: k === sort.key ? <Check /> : <span />,
                      onClick: () => changeSort({ key: k, asc: k === "name" }),
                    })),
                  );
                }}
              >
                <ArrowUpDown /> {SORT_LABELS[sort.key]}
              </button>
              <button
                className="btn"
                onClick={() => changeSort({ ...sort, asc: !sort.asc })}
                title={t("{order} — click to reverse", { order: dirLabel })}
                aria-label={t("Order: {order}", { order: dirLabel })}
              >
                {sort.asc ? <ArrowUp /> : <ArrowDown />} {dirLabel}
              </button>
              <button className="btn" onClick={() => void addFolder()}>
                <FolderPlus /> {t("New folder")}
              </button>
              {desktop ? (
                <button
                  className="btn"
                  onClick={() => void desktop!.projects.reveal({ folder })}
                  title={t("Show this folder in Finder")}
                >
                  <FolderOpen /> {t("Show in Finder")}
                </button>
              ) : null}
            </>
          )}
        </div>
        <p className="sub">
          {desktop
            ? withExt(
                t(
                  "Saved as open {ext} files; folders here are real folders on disk. Drag a part onto a folder to move it.",
                ),
              )
            : withExt(
                t(
                  "Saved as open {ext} files, in the Files app under On My {device} › meerCAD. Drag a part onto a folder to move it.",
                  { device: /iPhone/.test(navigator.userAgent) ? "iPhone" : "iPad" },
                ),
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
            const count = projects.filter(
              (project) => project.folder === f || project.folder?.startsWith(`${f}/`),
            ).length;
            const name = f.slice(f.lastIndexOf("/") + 1);

            return (
              <div
                key={f}
                className={`card folder ${dropTarget === f ? "drop" : ""}`}
                role="button"
                tabIndex={0}
                onClick={() => useApp.setState({ folder: f })}
                onKeyDown={(event) => event.key === "Enter" && useApp.setState({ folder: f })}
                onContextMenu={(event) => (
                  event.preventDefault(),
                  folderMenu(f, event.clientX, event.clientY)
                )}
                onDragOver={(event) => {
                  if (!dragging(event)) return;

                  event.preventDefault();
                  setDropTarget(f);
                }}
                onDragLeave={() => setDropTarget(null)}
                onDrop={(event) => void dropOn(event, f)}
              >
                <div className="thumb">
                  <Folder />
                </div>
                <div className="meta">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <b>{name}</b>
                    <small>{tn(count, "{n} part", "{n} parts")}</small>
                  </div>
                  <button
                    className="icon-btn sm"
                    title={t("Folder actions")}
                    onClick={(event) => (
                      event.stopPropagation(),
                      folderMenu(f, event.clientX, event.clientY)
                    )}
                  >
                    <Ellipsis />
                  </button>
                </div>
              </div>
            );
          })}
          {here.map((project) => {
            const picked = sel.ids.includes(project.id);
            const held = assistantTabs.find((a) => a.project === project.id);

            return (
              <div
                className={`card ${selecting ? "selecting" : ""} ${picked ? "selected" : ""}`}
                key={project.id}
                role={selecting ? "checkbox" : "button"}
                aria-checked={selecting ? picked : undefined}
                tabIndex={0}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData(
                    DRAG_TYPE,
                    picked && sel.ids.length > 1 ? sel.ids.join("\n") : project.id,
                  );
                  event.dataTransfer.effectAllowed = "move";
                }}
                // Shift-click would select the text on the page as well.
                onMouseDown={(event) => event.shiftKey && event.preventDefault()}
                {...(selecting ? {} : cardTap(project.id))}
                onClick={(event) =>
                  selecting || event.metaKey || event.ctrlKey || event.shiftKey
                    ? pickCard(event, project.id)
                    : cardTap(project.id).onClick()
                }
                onKeyDown={(event) => {
                  if (selecting && (event.key === " " || event.key === "Enter")) {
                    return (event.preventDefault(), pickCard(null, project.id));
                  }

                  if (event.key === "Enter") void openProject(project.id);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();

                  if (picked && sel.ids.length > 1) {
                    selectionMenu(sel.ids, folder, event.clientX, event.clientY, stopSelecting);
                  } else {
                    projectMenu(project, event.clientX, event.clientY);
                  }
                }}
              >
                <div className="thumb">
                  {project.thumbnail ? (
                    <img src={project.thumbnail} alt="" draggable={false} />
                  ) : (
                    <Box size={32} />
                  )}
                  {selecting ? (
                    <span className="pick-mark">{picked ? <CircleCheck /> : <Circle />}</span>
                  ) : null}
                  {held ? (
                    <span
                      className={`ai-badge ${held.busy ? "busy" : ""}`}
                      title={t("Locked while an assistant works on it: click to open its tab")}
                    >
                      {held.busy ? <AiOrb busy small /> : <Lock />}
                      {held.busy ? t("Being worked on") : t("Locked")}
                    </span>
                  ) : null}
                  {held && !selecting ? (
                    <button
                      className="btn sm ai-release"
                      title={t("{client} stops working on it; the project opens in a tab of yours", {
                        client: held.client,
                      })}
                      onClick={(event) => {
                        event.stopPropagation();
                        void handOverAssistantTab(held.session).then(() => openProject(project.id));
                      }}
                    >
                      <LockOpen />
                      {t("Take over")}
                    </button>
                  ) : null}
                </div>
                <div className="meta">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <b>{project.name}</b>
                    <small>
                      {sort.key === "created" && project.createdAt
                        ? t("Created {when}", { when: ago(project.createdAt) })
                        : ago(project.updatedAt)}
                    </small>
                  </div>
                  {selecting ? null : (
                    <button
                      className="icon-btn sm"
                      title={t("Part actions")}
                      onClick={(event) => (
                        event.stopPropagation(),
                        projectMenu(project, event.clientX, event.clientY)
                      )}
                    >
                      <Ellipsis />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {selecting ? (
          <div className="select-bar" role="toolbar" aria-label={t("Selected parts")}>
            <span className="select-count">
              {sel.ids.length
                ? tn(sel.ids.length, "{n} part selected", "{n} parts selected")
                : t("Choose the parts to move or delete")}
            </span>
            <button
              className="btn"
              disabled={!sel.ids.length}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                selectionMenu(sel.ids, folder, rect.left, rect.top - 4, stopSelecting, {
                  above: true,
                  moveOnly: true,
                });
              }}
            >
              <FolderInput /> {t("Move to…")}
            </button>
            <button
              className="btn danger"
              disabled={!sel.ids.length}
              onClick={() => void deleteMany(sel.ids).then((ok) => ok && stopSelecting())}
            >
              <Trash /> {t("Delete…")}
            </button>
            <button className="btn" onClick={stopSelecting}>
              {t("Done")}
            </button>
          </div>
        ) : null}
        {prefs.showExamples && examples.length ? (
          <>
            <button
              className="home-section-toggle"
              onClick={() => setPrefs({ examplesOpen: !prefs.examplesOpen })}
              aria-expanded={prefs.examplesOpen}
            >
              <ChevronRight className={prefs.examplesOpen ? "open" : ""} />
              <h1>{t("Examples")}</h1>
              {prefs.examplesOpen ? null : <span className="muted">{examples.length}</span>}
            </button>
            {prefs.examplesOpen ? (
              <>
                <p className="sub">
                  {t("Fully parametric — open one and change its variables. Hide this section in Settings.")}
                </p>
                <div className="grid">
                  {examples.map((example) => (
                    <button className="card" key={example.name} onClick={() => void openExample(example)}>
                      <div className="thumb">
                        {(example.thumbnail ?? exampleThumbnail(example.name, example.doc)) ? (
                          <img
                            src={example.thumbnail ?? exampleThumbnail(example.name, example.doc)!}
                            alt=""
                          />
                        ) : (
                          <Box size={32} />
                        )}
                      </div>
                      <div className="meta">
                        <div style={{ minWidth: 0 }}>
                          <b>{t(example.name)}</b>
                          <small>{t(example.description)}</small>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </>
            ) : null}
          </>
        ) : null}
        <footer className="home-footer">
          {(
            [
              ["about", t("About meerCAD")],
              ["terms", t("Terms of use")],
              ["privacy", t("Privacy")],
              ["licenses", t("Licences")],
            ] as const
          ).map(([tab, label], i) => (
            <span key={tab}>
              {i ? " · " : null}
              <button
                className="link"
                onClick={() => window.dispatchEvent(new CustomEvent("meercad:about", { detail: tab }))}
              >
                {label}
              </button>
            </span>
          ))}
        </footer>
      </div>
    </div>
  );
}

/** Examples being opened: tapping one again meanwhile makes no second copy. */
const openingExamples = openGuard();

/** A new project from an example; a large one is fetched first. */
function openExample(example: Example): Promise<void> {
  return openingExamples.run(example.name, () => openExampleNow(example));
}

async function openExampleNow(example: Example): Promise<void> {
  if (!example.url) return newProject(structuredClone(example.doc), t(example.name), true);

  const task = startTask(t("Opening {name}", { name: t(example.name) }), null, { untilEditor: true });

  try {
    const doc = (await (await fetch(example.url)).json()) as MeercadDocument;
    await newProject(doc, t(example.name));
  } catch (error) {
    toast(
      t("Could not open {name}: {error}", { name: t(example.name), error: (error as Error).message }),
      "error",
    );
  } finally {
    task.done();
  }
}
