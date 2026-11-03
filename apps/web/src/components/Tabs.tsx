/** Open projects as tabs: click to switch, double-click the active one to rename, drag to reorder. */
import { Plus, X } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { closeTab, moveTab, newProject, openProject, renameProject, useApp } from "../store";
import { t } from "../lib/i18n";

const DRAG_TYPE = "application/x-meercad-tab";

export function TabStrip() {
  const tabs = useApp((s) => s.tabs);
  const activeId = useApp((s) => (s.screen === "editor" ? s.project?.id : null));
  const saveState = useApp((s) => s.saveState);
  const tasks = useApp((s) => s.tasks);
  const [editing, setEditing] = useState(false);
  const [dropBefore, setDropBefore] = useState<string | null>(null);
  const strip = useRef<HTMLDivElement>(null);
  // With more tabs than fit, the strip scrolls: keep the open one in view.
  useEffect(() => {
    strip.current?.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, tabs.length]);

  return (
    <div className="tabs" role="tablist" aria-label={t("Open projects")} ref={strip}>
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            className={`tab ${active ? "active" : ""} ${dropBefore === tab.id ? "drop-before" : ""}`}
            title={((name) => (active ? t("{name} — double-click to rename", { name }) : name))(`${tab.folder ? `${tab.folder.split("/").join(" › ")} › ` : ""}${tab.name}`)}
            draggable={!editing}
            onDragStart={(e) => {
              e.dataTransfer.setData(DRAG_TYPE, tab.id);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
              e.preventDefault();
              setDropBefore(tab.id);
            }}
            onDragLeave={() => setDropBefore(null)}
            onDrop={(e) => {
              e.preventDefault();
              setDropBefore(null);
              const id = e.dataTransfer.getData(DRAG_TYPE);
              if (id && id !== tab.id) moveTab(id, tab.id);
            }}
            onClick={() => void openProject(tab.id)}
            onKeyDown={(e) => e.key === "Enter" && !editing && void openProject(tab.id)}
            onAuxClick={(e) => e.button === 1 && closeTab(tab.id)}
            onDoubleClick={() => active && setEditing(true)}
          >
            {active && editing ? (
              <input
                autoFocus
                className="tab-name-input"
                defaultValue={tab.name}
                aria-label={t("Project name")}
                onFocus={(e) => e.target.select()}
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => {
                  setEditing(false);
                  void renameProject(e.target.value);
                }}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") {
                    (e.target as HTMLInputElement).value = tab.name;
                    (e.target as HTMLInputElement).blur();
                  }
                }}
              />
            ) : (
              <span className="tab-name">{tab.name}</span>
            )}
            {((work) =>
              work ? (
                <i
                  className={`tab-progress ${work.progress === null ? "indeterminate" : ""}`}
                  title={`${work.label}${work.progress !== null ? ` · ${Math.round(work.progress * 100)} %` : ""}`}
                  style={{ "--p": `${Math.round((work.progress ?? 0.25) * 360)}deg` } as CSSProperties}
                />
              ) : null)(tasks.find((x) => x.project === tab.id))}
            {active && saveState !== "saved" ? <i className="tab-dirty" title={saveState === "saving" ? t("Saving…") : t("Unsaved changes")} /> : null}
            <button
              className="tab-close"
              title={t("Close tab (⌘W)")}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.id);
              }}
            >
              <X />
            </button>
          </div>
        );
      })}
      <button className="icon-btn sm tab-new" title={t("New part (⌘T)")} onClick={() => void newProject()}>
        <Plus />
      </button>
    </div>
  );
}
