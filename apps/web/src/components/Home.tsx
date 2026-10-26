import { Box, FileUp, Plus, Trash } from "lucide-react";
import { useEffect } from "react";
import { askConfirm } from "./Ask";
import { deleteProject, desktop } from "../lib/persistence";
import { newProject, openProject, refreshProjects, useApp } from "../store";
import { EXAMPLES } from "../lib/examples";
import { importFile } from "./io";
import { Logo, toggleTheme } from "./TopBar";

export function Home() {
  const projects = useApp((s) => s.projects);
  useEffect(() => void refreshProjects(), []);
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
        <span className="logo">
          <Logo /> leocad
        </span>
        <span className="muted">Parametric CAD for makers — free, open source, works offline.</span>
        <span className="spacer" />
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
        <h1>Your projects</h1>
        <p className="sub">
          {desktop ? (
            <>
              Saved as open <span className="mono">.leocad</span> files in your Documents/leocad folder.{" "}
              <button className="btn" style={{ height: 24, marginLeft: 6 }} onClick={() => void desktop!.projects.reveal()}>
                Show folder
              </button>
            </>
          ) : (
            "Stored only in this browser. Use Share or Export to move them elsewhere."
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
          {projects.map((p) => (
            <div className="card" key={p.id} role="button" tabIndex={0} onClick={() => void openProject(p.id)} onKeyDown={(e) => e.key === "Enter" && void openProject(p.id)}>
              <div className="thumb">{p.thumbnail ? <img src={p.thumbnail} alt="" /> : <Box size={32} />}</div>
              <div className="meta">
                <div style={{ minWidth: 0, flex: 1 }}>
                  <b>{p.name}</b>
                  <small>{ago(p.updatedAt)}</small>
                </div>
                <button
                  className="icon-btn sm"
                  title="Delete project"
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (await askConfirm({ title: `Delete "${p.name}"?`, message: "The project file is removed. This cannot be undone.", confirmLabel: "Delete project", danger: true })) void deleteProject(p.id).then(refreshProjects);
                  }}
                >
                  <Trash />
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
