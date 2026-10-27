# meerCAD — Projektplan

> Name: **meerCAD** (vorher Arbeitstitel `leocad`)
> Stand: 26.10.2026 · Status: Planung → Phase 0

---

## 1. Vision

Ein kostenloser, quelloffener, parametrischer CAD-Dienst im Browser — für Maker, Laser- und 3D-Druck-Nutzer. Ohne Installation, ohne Account, ohne Abo. Mit eingebautem AI-Copilot.

**Abgrenzung:** Wir bauen keine Profi-Suite mit tausend Funktionen. Wir bauen den Teil, den 80 % der Maker täglich nutzen — mit einer UX, die Spaß macht, und ohne Lock-in.

### Leitprinzipien

1. **Alles rechnet im Browser.** Server liefert nur statische Dateien. Betriebskosten ≈ 0, unabhängig von Nutzerzahl.
2. **Local-first.** Daten gehören dem Nutzer, liegen bei ihm. Kein Login nötig.
3. **Feature-Log ist die Wahrheit.** Geometrie ist eine reine Funktion eines append-only Operations-Logs.
4. **Eine API für alle.** UI, AI, Scripting und MCP nutzen dieselbe Operations-API. Kein Sonderweg.
5. **Robustheit vor Features.** Ein Modell, das nach einer Parameteränderung kaputtgeht, ist schlimmer als ein fehlendes Feature.

---

## 2. Scope

### In Scope (Ziel v1.0)

- Skizzen mit geometrischen + Maß-Constraints (Linie, Bogen, Kreis, Rechteck, Spline-light, Konstruktionsgeometrie)
- Skizze auf Ebene oder Fläche, Projektion von Kanten
- Extrude (inkl. Cut, Symmetrisch, Bis-Fläche), Revolve
- Fillet, Chamfer, Shell
- Lineares/zirkulares Pattern, Mirror
- Boolesche Operationen zwischen Bodies (mehrere Bodies pro Dokument)
- Parametrische Timeline mit Rollback-Marker, Unterdrücken, Umsortieren
- Benutzerparameter / Ausdrücke (`wall = 2 mm`, `width = wall * 10`)
- Messwerkzeug
- Export: STL, 3MF, STEP, DXF (Skizzen/Flächenprojektion für Laser), SVG
- Import: STEP, STL (als Referenz-Mesh), DXF/SVG (in Skizze)
- AI-Copilot (BYOK + MCP)
- Teilen per Link

### Später (nach v1.0)

- Assemblies & Joints
- Sheet Metal
- Laser-CAM (Pfade, Reihenfolge, Ausgabe für gängige Laser-Software/G-Code)
- 2.5D-Fräs-CAM
- Optionaler Cloud-Sync
- Technische Zeichnungen

### Nie

- FEM/Simulation, Rendering, Surface/T-Splines, Elektronik, Echtzeit-Mehrbenutzer-Bearbeitung (vorerst)

---

## 3. Die harten Probleme (Risikoliste)

| # | Problem | Warum hart | Strategie |
|---|---|---|---|
| R1 | **Topological Naming** | Ändert sich ein frühes Feature, verlieren spätere Features ihre Kanten-/Flächenreferenzen | Persistente, historienbasierte Referenzen + semantische Selektoren von Tag 1 (siehe §5.4) |
| R2 | **Kernel-Robustheit (v. a. Fillets)** | OCCT-Fillets scheitern bei Grenzfällen | Klare Fehlermeldungen, Fallbacks (kleinerer Radius vorschlagen), Testkorpus |
| R3 | **Constraint-Solver** | Numerische Stabilität, Über-/Unterbestimmung erkennen, gutes Drag-Verhalten | PlaneGCS (LGPL) wrappen; eigener Solver nur, wenn nötig |
| R4 | **Browser-Performance** | WASM-Speicherlimit, OCCT weitgehend single-threaded, große Downloads | Worker-Isolation, inkrementeller Rebuild, Caching, schlanker OCCT-Build |
| R5 | **Ladezeit** | OCCT-WASM ist groß | Custom-Build, Lazy Loading, Service-Worker-Cache, sofort nutzbarer Skizzierer vor Kernel-Load |
| R6 | **STEP-Qualität** | Entscheidet über Vertrauen | Roundtrip-Tests gegen Referenzdateien |
| R7 | **AI-Kosten** | Inferenz kostet pro Nutzer | BYOK + MCP, keine gehostete AI ohne Finanzierung |

**Kill-Kriterium:** Wenn R1 oder R4 in Phase 0/2 nicht beherrschbar sind → Projekt neu bewerten (Plan B: neue Web-UX auf FreeCAD-Backend o. ä.).

---

## 4. Tech-Stack

| Bereich | Wahl | Begründung |
|---|---|---|
| Sprache | TypeScript (strict) | Ein Stack, Web-native |
| Build | Vite, pnpm Workspaces | Schnell, Monorepo-tauglich |
| UI | Framework TBD (Solid oder React) | Entscheidung in Phase 0; Viewport ist ohnehin eigenständig |
| 3D-Viewport | Three.js | Reif, große Community |
| Geometriekern | OpenCASCADE (OCCT) als WASM (opencascade.js bzw. Custom-Build) | Einziger realistisch verfügbarer offener B-Rep-Kernel |
| Mesh-Booleans (optional) | Manifold | Schnell, robust für Mesh-Operationen |
| Sketch-Solver | PlaneGCS (aus FreeCAD) als WASM | LGPL, erprobt |
| Persistenz | OPFS / IndexedDB, File System Access API | Local-first |
| Kompression (Share-Links) | Brotli/Deflate + Base64url | Feature-Log passt in URL |
| Desktop (optional, später) | Tauri | Gleicher Code, native Dateizugriffe |
| Tests | Vitest, Playwright, Geometrie-Snapshot-Tests | |
| Hosting | Statisch (Cloudflare Pages o. ä.) | Mit COOP/COEP-Headern |

### Prior Art zum Studieren

- **replicad, CascadeStudio, Chili3D** — OCCT im Browser
- **build123d, CadQuery** — Feature-API und Selektor-Design
- **SolveSpace, Dune 3D** — Skizzier-UX und Constraint-Handling
- **FreeCAD (TNP-Lösung ab 1.0)** — Lehrstück zu persistenten Referenzen

---

## 5. Architektur

### 5.1 Überblick

```
┌──────────────────────── Main Thread ────────────────────────┐
│  UI (Panels, Timeline, Parameter)    Viewport (Three.js)    │
│  Command-Bar / AI-Copilot            Selektion → Selektoren │
│                  │                            ▲              │
│                  ▼                            │ Meshes/Edges │
│        Operations-API (validiert gegen JSON-Schema)          │
│                  │                                           │
│        Document Store (Feature-Log, append-only)             │
└──────────────────┼───────────────────────────────────────────┘
                   │ postMessage (Ops / Rebuild-Request)
┌──────────────────▼──────── Kernel Worker ───────────────────┐
│  Rebuild-Engine (inkrementell, Cache je Feature)            │
│  Reference Resolver (persistente Namen → aktuelle Topologie)│
│  OCCT (WASM)            PlaneGCS (WASM)                     │
│  Tessellierung → transferable Buffers                       │
└──────────────────────────────────────────────────────────────┘
```

### 5.2 Repo-Struktur

```
/apps/web            Haupt-App (Vite), COOP/COEP-Header, Service Worker
/packages/schema     JSON-Schema + TS-Typen aller Operationen (Single Source of Truth)
/packages/model      Document Store, Feature-Log, Parameter/Ausdrücke, Rebuild-Orchestrierung
/packages/kernel     OCCT-Wrapper, Kernel-Interface, Worker-Protokoll
/packages/naming     Persistente Referenzen, Selektor-Auflösung
/packages/sketch     Skizzen-Modell + PlaneGCS-Anbindung
/packages/io         STL / 3MF / STEP / DXF / SVG Import & Export
/packages/ai         Tool-Definitionen, Agent-Loop, Provider-Adapter (BYOK)
/packages/mcp        MCP-Server-Modus (Bridge zur laufenden Web-App)
/packages/viewport   Three.js-Rendering, Picking, Highlighting
/tests/corpus        Referenzmodelle für Regressions- und Robustheitstests
```

### 5.3 Datenmodell: Feature-Log

Ein Dokument ist eine geordnete Liste von Operationen. Jede Operation hat eine stabile ID und referenziert Geometrie ausschließlich über Selektoren — nie über flüchtige Indizes.

```json
{
  "format": "meercad/1",
  "params": { "wall": "2 mm", "w": "40 mm", "d": "20 mm", "h": "10 mm" },
  "features": [
    {
      "id": "sk1",
      "op": "sketch",
      "plane": { "ref": "origin.XY" },
      "entities": [
        { "id": "r1", "type": "rectangle", "corner": [0, 0], "size": ["w", "d"] }
      ],
      "constraints": [
        { "type": "coincident", "a": "r1.p0", "b": "origin" }
      ]
    },
    {
      "id": "ex1",
      "op": "extrude",
      "profile": { "ref": "sk1.r1.region" },
      "distance": "h",
      "mode": "new_body"
    },
    {
      "id": "fi1",
      "op": "fillet",
      "edges": { "select": "edges", "of": "ex1", "where": { "face": "end_cap" } },
      "radius": "wall"
    }
  ],
  "rollback": null
}
```

Eigenschaften:
- **Diffbar und git-freundlich** (stabile Reihenfolge, stabile IDs)
- **Undo/Redo** = Position im Log
- **Share-Link** = komprimiertes Log
- **AI-Änderungen** = vorgeschlagene Log-Einträge, als Diff prüfbar

### 5.4 Persistente Referenzen (Lösung für R1)

Kernidee: Topologie wird über ihre **Entstehungsgeschichte** identifiziert.

1. Jede erzeugende Operation vergibt **Generierungs-Tags** an die von ihr erzeugten Flächen/Kanten. Beispiel: Extrude aus `sk1.r1` erzeugt `ex1.start_cap`, `ex1.end_cap`, `ex1.side[sk1.r1.edge_top]`.
2. Modifizierende Operationen (Fillet, Boolean) **propagieren** Tags über die OCCT-History-API (generated/modified/deleted) weiter.
3. Referenzen in späteren Features sind **Selektoren** auf diesen Tags, ergänzt um geometrische Filter:
   - `{ "face": "ex1.end_cap" }`
   - `{ "select": "edges", "of": "ex1", "where": { "face": "end_cap" } }`
   - `{ "select": "faces", "where": { "planar": true, "normal": "+Z" }, "pick": "largest" }`
4. Kann ein Selektor nach Rebuild nicht eindeutig aufgelöst werden → **sichtbarer Fehler am Feature** mit Reparatur-Dialog, nie stilles Falschzuordnen.

Diese Selektoren sind gleichzeitig die Sprache, in der die AI Geometrie adressiert (§6).

### 5.5 Rebuild-Engine

- Inkrementell: Ab der ersten geänderten Operation neu bauen, davor aus Cache.
- Cache-Key je Feature = Hash(Operation + aufgelöste Parameter + Hash Vorgänger-Zustand).
- Rebuild ist abbrechbar (neue Eingabe während Drag verwirft laufenden Rebuild).
- Ergebnis je Feature: Erfolg | Warnung | Fehler (mit menschenlesbarer Ursache).

### 5.6 Persistenz & Teilen

| Weg | Inhalt | Kosten |
|---|---|---|
| Browser-Speicher (OPFS) | Projekte, Autosave, Versionen | 0 |
| Lokaler Ordner (File System Access API) | `.meercad`-Dateien (JSON) | 0 |
| Share-Link | komprimiertes Feature-Log in URL-Fragment (geht nie an Server) | 0 |
| Export/Import | Datei | 0 |
| Cloud-Sync (später, optional) | — | einziger Kostentreiber |

URL-**Fragment** (`#...`) statt Query → Modelle verlassen den Browser nicht, auch nicht in Server-Logs.

---

## 6. AI-Copilot

### 6.1 Betriebsmodelle

| Modell | Kosten für Betreiber | Status |
|---|---|---|
| **BYOK** — Nutzer hinterlegt eigenen API-Key, Calls gehen direkt vom Browser zum Anbieter | 0 € | v1 |
| **MCP** — externer Assistent des Nutzers steuert die laufende App | 0 € | v1 |
| **Lokal** (WebGPU-Modell) | 0 € | Experiment, nur einfache Befehle |
| **Gehostet** mit Limit | variabel | nur mit Finanzierung |

Key wird ausschließlich lokal gespeichert. Kein eigener Proxy → keine Auftragsverarbeitung durch den Betreiber.

### 6.2 Tools

**Lesen**
- `describe_model` — Feature-Baum, Parameter, Bodies, Bounding Boxes, benannte Flächen/Kanten
- `measure(a, b)` — Abstände, Winkel, Flächen
- `render_view(view, highlight?)` — PNG (iso/top/front/right) für Vision-Feedback

**Schreiben** (erzeugen *Vorschläge*, keine direkten Commits)
- `add_features([...])` — Operationen gemäß Schema
- `edit_feature(id, patch)`
- `set_param(name, expr)`
- `delete_feature(id)`

### 6.3 Ablauf

1. Nutzer-Prompt (+ optional aktuelle Selektion als Selektoren)
2. Agent-Loop: lesen → vorschlagen → Rebuild im **Sandbox-Dokument** → bei Fehler Fehlermeldung zurück an Modell → korrigieren (max. N Iterationen)
3. Diff-Vorschau in UI (neue/geänderte Features, Vorher/Nachher-Ansicht)
4. Nutzer übernimmt oder verwirft. Übernommen = normale Log-Einträge, normal undo-bar.

### 6.4 Ehrliche Erwartung

- **Gut:** parametrische Edits, Varianten, einfache Teile aus Beschreibung, Fehler erklären, Skizzen automatisch constrainen
- **Mittel:** Teil aus Foto + Maßen
- **Schlecht:** komplexe Freiform, Passungen über Assemblies, Teile ohne Maßangaben

Positionierung: **Copilot für Edits und einfache Teile.** Nicht als „Text-to-CAD“ vermarkten.

---

## 7. Phasen & Abnahmekriterien

### Phase 0 — Spike (1–2 Wochen)

Ziel: Beweisen, dass der Stack im Browser trägt.

- [ ] Monorepo-Gerüst, CI, COOP/COEP-Header, Deploy auf Preview-URL
- [ ] OCCT-WASM im Worker, minimales Kernel-Interface
- [ ] `packages/schema`: erste Ops (sketch-rectangle, extrude, fillet) als JSON-Schema
- [ ] Rebuild-Engine minimal
- [ ] Viewport zeigt Ergebnis, STL-Download

**Abnahme**
1. Rechteck → Extrude → Fillet einer Kante → STL, komplett im Browser
2. Extrude-Höhe ändern → Rebuild → Fillet sitzt weiterhin auf der richtigen Kante
3. Kaltstart < 5 s (normaler Laptop), Rebuild dieses Teils < 200 ms
4. Feature-Log im URL-Fragment → Öffnen baut identisch wieder auf
5. LLM (BYOK) erzeugt aus „Box 40×20×10, 2 mm Fillet an den oberen Kanten“ ein gültiges Log, das fehlerfrei rebuildet

### Phase 1 — Skizzierer & Kernfeatures (2–3 Monate)

- [ ] Skizzen-Editor: Entities, Constraints, Drag, Über-/Unterbestimmung farbig
- [ ] PlaneGCS-Integration
- [ ] Extrude (alle Modi), Revolve, Cut
- [ ] Timeline-UI: Rollback, Unterdrücken, Bearbeiten
- [ ] Parameter & Ausdrücke mit Einheiten
- [ ] Autosave in OPFS, Projektliste

**Abnahme:** Ein realistisches Maker-Teil (z. B. Wandhalter mit Bohrungen und Senkungen) lässt sich ohne Workaround modellieren und parametrisch ändern.

### Phase 1.5 — AI-Copilot (3–4 Wochen)

- [ ] Command-Bar, Key-Verwaltung (lokal)
- [ ] Tool-Loop mit Sandbox-Rebuild und Render-Feedback
- [ ] Diff-Vorschau, Übernehmen/Verwerfen
- [ ] MCP-Server-Modus

**Abnahme:** 20 Referenz-Prompts (Edits + einfache Teile), Erfolgsquote dokumentiert; Ziel ≥ 70 % bei Edits.

### Phase 2 — Robustheit & Features (2–3 Monate)

- [ ] Vollständige persistente Referenzen inkl. Boolean-/Fillet-Propagation
- [ ] Reparatur-Dialog für verlorene Referenzen
- [ ] Fillet, Chamfer, Shell, Pattern, Mirror
- [ ] Skizze auf Fläche, Kantenprojektion
- [ ] Mehrere Bodies, Booleans

**Abnahme:** Testkorpus von ≥ 30 Modellen übersteht zufällige Parameteränderungen ohne falsche Referenzen (nur explizite Fehler erlaubt).

### Phase 3 — I/O & Härtung (≈ 2 Monate)

- [ ] STEP Import/Export mit Roundtrip-Tests
- [ ] 3MF, DXF, SVG
- [ ] Performance-Tuning, schlanker OCCT-Build
- [ ] Onboarding, Tastaturkürzel, Accessibility-Grundlagen
- [ ] Öffentlicher Launch (Beta)

### Phase 4+ — Erweiterungen

Assemblies & Joints → Laser-CAM → Sheet Metal → optionaler Sync → Zeichnungen

**Gesamt bis Beta: ca. 7–10 Monate** bei einer Person mit AI-Unterstützung.

---

## 8. Qualitätssicherung

- **Geometrie-Snapshot-Tests:** Volumen, Fläche, Bounding Box, Topologie-Zählung je Referenzmodell
- **Fuzzing:** Zufällige Parameteränderungen auf Korpusmodellen, Prüfung auf stille Fehlzuordnungen
- **Roundtrip-Tests:** STEP raus → rein → Volumenvergleich
- **E2E:** Playwright-Flows für Kernabläufe
- **AI-Eval:** Fester Prompt-Satz, Erfolgsquote pro Release

---

## 9. Lizenz & Recht

### Lizenz

- **App:** FSL-1.1-ALv2 (seit 27.10.2026; vorher AGPL-3.0): frei nutzbar, auch kommerziell, aber keine Konkurrenzprodukte; jede Version wird nach 2 Jahren Apache-2.0
- **Wiederverwendbare Libraries** (`schema`, `io`, `naming`): MIT — für maximale Nutzung durch andere
- Abhängigkeiten prüfen: OCCT (LGPL) ✓, PlaneGCS (LGPL) ✓, Three.js (MIT) ✓. GPL-Bibliotheken (z. B. libslvs) nur bewusst.
- Contributor-Regel: Beiträge unter denselben Bedingungen (FSL); für einen späteren Lizenzwechsel bräuchte es eine Rechteeinräumung (CLA)

### Betrieb in Deutschland

- Impressum, Datenschutzerklärung
- Kein Tracking, oder datensparsame Lösung ohne Cookies
- Keine Accounts, keine Nutzerdaten auf Servern → minimaler DSGVO-Aufwand
- BYOK-AI: Daten gehen vom Nutzer direkt zum Anbieter; Hinweis im UI
- AI-Interaktion als solche kennzeichnen
- Kein Hosting fremder Dateien bis zur bewussten Entscheidung (Moderation/DSA)
- Betreibende Rechtsperson vor Launch festlegen

---

## 10. Finanzierung & Kosten

| Posten | Kosten |
|---|---|
| Statisches Hosting + CDN | ~0–50 €/Monat auch bei Erfolg |
| Domain | ~gering |
| AI | 0 € (BYOK/MCP) |
| Cloud-Sync (falls je) | einziger relevanter Posten → dann optional bezahlt |

Spenden: GitHub Sponsors / Open Collective. Planungsannahme: **Projekt muss nichts kosten, nicht sich tragen.**

---

## 11. Offene Entscheidungen

- [ ] Projektname + Domain
- [ ] UI-Framework (Solid vs. React) — Entscheidung Ende Phase 0
- [ ] opencascade.js fertig vs. eigener schlanker OCCT-WASM-Build
- [ ] Dateiendung/Format-Name
- [ ] Einheitensystem-Default (mm) und Umschaltung
- [ ] Erster AI-Provider-Adapter (Reihenfolge der Anbieter)
- [ ] Ab wann öffentliches Repo (sofort vs. ab Phase 1)

---

## 12. Nächste Schritte

1. Repo anlegen, Gerüst gemäß §5.2
2. `packages/schema`: Ops für Phase 0 definieren
3. OCCT-Worker: Box/Extrude/Fillet + Tessellierung
4. Minimaler Viewport + STL-Export
5. Abnahmekriterien Phase 0 als automatisierte Tests
