/** Open projects as tabs: click to switch, double-click the active one to rename, drag to reorder. */
import { Plus, X } from "lucide-react";
import { useState } from "react";
import { closeTab, moveTab, newProject, openProject, renameProject, useApp } from "../store";

const DRAG_TYPE = "application/x-meercad-tab";

export function TabStrip() {
  const tabs = useApp((s) => s.tabs);
  const activeId = useApp((s) => (s.screen === "editor" ? s.project?.id : null));
  const saveState = useApp((s) => s.saveState);
  const [editing, setEditing] = useState(false);
  const [dropBefore, setDropBefore] = useState<string | null>(null);

  return (
    <div className="tabs" role="tablist" aria-label="Open projects">
      {tabs.map((t) => {
        const active = t.id === activeId;
        return (
          <div
            key={t.id}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            className={`tab ${active ? "active" : ""} ${dropBefore === t.id ? "drop-before" : ""}`}
            title={`${t.folder ? `${t.folder.split("/").join(" › ")} › ` : ""}${t.name}${active ? " — double-click to rename" : ""}`}
            draggable={!editing}
            onDragStart={(e) => {
              e.dataTransfer.setData(DRAG_TYPE, t.id);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
              e.preventDefault();
              setDropBefore(t.id);
            }}
            onDragLeave={() => setDropBefore(null)}
            onDrop={(e) => {
              e.preventDefault();
              setDropBefore(null);
              const id = e.dataTransfer.getData(DRAG_TYPE);
              if (id && id !== t.id) moveTab(id, t.id);
            }}
            onClick={() => void openProject(t.id)}
            onKeyDown={(e) => e.key === "Enter" && !editing && void openProject(t.id)}
            onAuxClick={(e) => e.button === 1 && closeTab(t.id)}
            onDoubleClick={() => active && setEditing(true)}
          >
            {active && editing ? (
              <input
                autoFocus
                className="tab-name-input"
                defaultValue={t.name}
                aria-label="Project name"
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
                    (e.target as HTMLInputElement).value = t.name;
                    (e.target as HTMLInputElement).blur();
                  }
                }}
              />
            ) : (
              <span className="tab-name">{t.name}</span>
            )}
            {active && saveState !== "saved" ? <i className="tab-dirty" title={saveState === "saving" ? "Saving…" : "Unsaved changes"} /> : null}
            <button
              className="tab-close"
              title="Close tab (⌘W)"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(t.id);
              }}
            >
              <X />
            </button>
          </div>
        );
      })}
      <button className="icon-btn sm tab-new" title="New part (⌘T)" onClick={() => void newProject()}>
        <Plus />
      </button>
    </div>
  );
}
