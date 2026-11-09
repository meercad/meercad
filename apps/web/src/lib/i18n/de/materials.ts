/** German texts: materials, the material picker, the rendered view. See ../GLOSSARY.md (material = Material). */
export default {
  // Material names new in the library (packages/model MATERIALS; the older ones are in workspace.ts)
  "PLA matte": "PLA matt",
  "PLA silk": "PLA Seide",
  "Wood fill": "Holzfilament",
  "Metal fill": "Metallfilament",
  "Resin (clear)": "Harz (klar)",

  // Notes on the materials
  "Easy to print and stiff; softens from about 55 °C.": "Leicht zu drucken und steif; wird ab etwa 55 °C weich.",
  "PLA without shine: hides layer lines, looks moulded.": "PLA ohne Glanz: verbirgt Schichtlinien, wirkt wie gegossen.",
  "Glossy, pearly sheen for decorative prints; a little weaker between layers.": "Glänzend mit Perlschimmer für Deko-Drucke; zwischen den Schichten etwas schwächer.",
  "Tough, glossy and food-safe grades exist; stands up to about 70 °C.": "Zäh und glänzend, lebensmittelechte Sorten gibt es; hält bis etwa 70 °C.",
  "Heat resistant to about 95 °C; warps, print enclosed.": "Hitzebeständig bis etwa 95 °C; verzieht sich, geschlossen drucken.",
  "Like ABS, but stays colourfast outdoors in sun and rain.": "Wie ABS, bleibt aber draußen in Sonne und Regen farbecht.",
  "Flexible and grippy: grips, bumpers, seals. Print slowly.": "Flexibel und griffig: Griffe, Puffer, Dichtungen. Langsam drucken.",
  "Very soft, rubber-like; needs a direct drive extruder.": "Sehr weich, gummiartig; braucht einen Direktextruder.",
  "Tough and slippery: gears, hinges, wear parts. Keep it dry.": "Zäh und gleitfähig: Zahnräder, Scharniere, Verschleißteile. Trocken lagern.",
  "Very strong and heat resistant to about 115 °C; print enclosed.": "Sehr fest und hitzebeständig bis etwa 115 °C; geschlossen drucken.",
  "Carbon fibre filled: stiff, matte, light. Needs a hardened nozzle.": "Mit Kohlefasern: steif, matt, leicht. Braucht eine gehärtete Düse.",
  "Carbon fibre filled PETG: stiff and tough. Needs a hardened nozzle.": "PETG mit Kohlefasern: steif und zäh. Braucht eine gehärtete Düse.",
  "PLA with wood fibres: looks and sands like wood. Use a 0.6 mm nozzle.": "PLA mit Holzfasern: sieht aus wie Holz und lässt sich so schleifen. Mit 0,6-mm-Düse drucken.",
  "PLA with metal powder (bronze, copper): heavy, can be polished. Needs a hardened nozzle.": "PLA mit Metallpulver (Bronze, Kupfer): schwer, lässt sich polieren. Braucht eine gehärtete Düse.",
  "Photopolymer for fine detail on resin printers; brittle.": "Fotopolymer für feine Details auf Harzdruckern; spröde.",
  "See-through photopolymer; clear after sanding and coating.": "Durchsichtiges Fotopolymer; klar nach Schleifen und Lackieren.",
  "Light and easy to machine.": "Leicht und gut zu bearbeiten.",
  "Strong and stiff; rusts unless coated.": "Fest und steif; rostet ohne Beschichtung.",
  "Corrosion resistant steel (A2/A4).": "Rostfreier Stahl (A2/A4).",
  "Machines cleanly; inserts and fittings.": "Lässt sich sauber zerspanen; Gewindeeinsätze und Fittings.",
  "Conducts heat and electricity best.": "Leitet Wärme und Strom am besten.",
  "Hard, fine-grained wood.": "Hartes, feinporiges Holz.",
  "Layered sheet wood for laser cutting and boxes.": "Schichtholz für Laserschnitt und Kisten.",
  "Clear sheet for laser cutting and covers.": "Klare Platten für Laserschnitt und Abdeckungen.",

  // Facts (lib/materials.ts)
  "{d} g/cm³": "{d} g/cm³",
  "Nozzle {a}–{b} °C": "Düse {a}–{b} °C",
  "Bed {a}–{b} °C": "Druckbett {a}–{b} °C",
  "Shore {s}": "Shore {s}",
  "Resin printer": "Harzdrucker",

  // MaterialPicker.tsx
  "Your materials": "Deine Materialien",
  Filament: "Filament",
  Resin: "Harz",
  "Metal, wood and more": "Metall, Holz und mehr",
  "My {material}": "Mein {material}",
  "Search materials": "Materialien suchen",
  "New material": "Neues Material",
  "own name and colour": "eigener Name und Farbe",
  "Edit material": "Material bearbeiten",
  "Based on": "Basiert auf",
  "Density (g/cm³)": "Dichte (g/cm³)",
  Save: "Speichern",
  "Create and use": "Anlegen und verwenden",
  "Based on {material}": "Basiert auf {material}",
  "{mass} for {parts} (solid)": "{mass} für {parts} (massiv)",
  "Own material from this": "Eigenes Material daraus",
  "The parts have different materials. Pick one to give them all the same.": "Die Teile haben verschiedene Materialien. Wähl eines, um allen dasselbe zu geben.",
  "Pick a material: the parts get its look, their mass, and the right filament in 3MF exports.": "Wähl ein Material: Die Teile bekommen sein Aussehen, ihre Masse und im 3MF-Export das passende Filament.",

  // RenderBar.tsx, ViewportView.tsx
  Rendered: "Gerendert",
  "Rendered view": "Gerenderte Ansicht",
  "As on screen, sharp ({size})": "Wie am Bildschirm, scharf ({size})",
  "Full HD ({size})": "Full HD ({size})",
  "4K ({size})": "4K ({size})",
  "Square ({size})": "Quadratisch ({size})",
  "the picture could not be encoded": "das Bild ließ sich nicht kodieren",
  "Could not save the picture: {error}": "Das Bild ließ sich nicht speichern: {error}",
  "Stop turning": "Drehen anhalten",
  "Turntable: turn the model slowly": "Drehteller: Modell langsam drehen",
  Turntable: "Drehteller",
  "Save pictures without a background (transparent)": "Bilder ohne Hintergrund speichern (transparent)",
  Transparent: "Transparent",
  "Save a high-resolution picture of this view": "Ein hochaufgelöstes Bild dieser Ansicht speichern",
  "Save image": "Bild speichern",
  "Back to the working view": "Zurück zur Arbeitsansicht",

  // ViewportView.tsx (measure)
  "{v} cm³": "{v} cm³",
  "no material, so no mass": "kein Material, daher keine Masse",

  // io.ts
  "PNG picture": "PNG-Bild",
  "Filament {n}: {material} {color}": "Filament {n}: {material} {color}",
  "any material": "beliebiges Material",
  "{n} filaments assigned": "{n} Filamente zugeordnet",
  "Load these filaments in the slicer in this order; each part is already assigned to its filament.": "Leg diese Filamente im Slicer in dieser Reihenfolge ein; jedes Teil ist seinem Filament schon zugeordnet.",

  // Help.tsx
  "Materials and rendered pictures": "Materialien und gerenderte Bilder",
  "Give parts a material: right-click (or long-press) a part in the view or the parts list → **Material…**. Select several parts first to give them all the same one. Search by name, or browse filaments, resins, metals and wood.":
    "Teilen ein Material geben: Rechtsklick (oder lang drücken) auf ein Teil in der Ansicht oder der Teileliste → **Material …**. Wähl vorher mehrere Teile aus, um allen dasselbe zu geben. Such nach dem Namen oder stöbere in Filamenten, Harzen, Metallen und Holz.",
  "A material sets the part's finish (matte, glossy, silk, rubbery, metal), its mass (shown in the parts list, solid at 100 % infill) and its print data: nozzle and bed temperature, hardness of flexible ones. Carbon, wood and metal bring their own colour; plastics keep the part's colour.":
    "Ein Material bestimmt die Oberfläche des Teils (matt, glänzend, Seide, gummiartig, Metall), seine Masse (in der Teileliste, massiv bei 100 % Füllung) und seine Druckdaten: Düsen- und Betttemperatur, bei flexiblen die Härte. Kohlefaser, Holz und Metall bringen ihre eigene Farbe mit; Kunststoffe behalten die Farbe des Teils.",
  "Your own materials: in the picker, **Own material from this** makes one with your name and colour (say, your black PETG), based on a library material. Edit or delete it there; its parts then go back to the base material.":
    "Eigene Materialien: Im Auswahlfenster legt **Eigenes Material daraus** eines mit deinem Namen und deiner Farbe an (etwa dein schwarzes PETG), auf Basis eines Materials aus der Bibliothek. Dort kannst du es bearbeiten oder löschen; seine Teile bekommen dann wieder das Basismaterial.",
  "Multi-material printing: export **3MF**. Parts with different materials or colours go to different filaments (a PETG body and a TPU grip, for instance), and meerCAD tells you which filament number gets which material, so you load them in that order in the slicer.":
    "Mehrmaterialdruck: Exportier als **3MF**. Teile mit verschiedenen Materialien oder Farben kommen auf verschiedene Filamente (etwa ein PETG-Gehäuse und ein TPU-Griff), und meerCAD sagt dir, welche Filamentnummer welches Material bekommt, damit du sie im Slicer in dieser Reihenfolge einlegst.",
  "Pictures: Display mode → **Rendered** shows the materials in studio light with a soft shadow. **Turntable** turns the model slowly; **Save image** saves a sharp picture up to 4K, also with a transparent background.":
    "Bilder: Darstellung → **Gerendert** zeigt die Materialien im Studiolicht mit weichem Schatten. **Drehteller** dreht das Modell langsam; **Bild speichern** speichert ein scharfes Bild bis 4K, auch mit transparentem Hintergrund.",
  "Two-material grip": "Griff aus zwei Materialien",
  "A PLA handle with a grooved TPU sleeve: two filaments in one 3MF": "Ein PLA-Griff mit gerillter TPU-Hülle: zwei Filamente in einem 3MF",
} as Record<string, string>;
