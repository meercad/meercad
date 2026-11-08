/**
 * Builds the terrain test model (tests/fixtures/terrain-drone-park.meercad, not shipped) from a
 * terrain GLB made by the photo helper: OpenDroneMap's Aukerman photos, CC0. Adds a few marks and a
 * small cabin standing on the ground, so every terrain tool has something to show.
 * Usage: node scripts/make-terrain-demo.mjs <terrain.glb> <geo JSON from the helper>
 */
import { readFileSync, writeFileSync } from "node:fs";

const [glbPath, geoJson] = process.argv.slice(2);
const glb = readFileSync(glbPath);
const geo = JSON.parse(geoJson);

// Ground heights from the GLB's triangles: the highest surface over a point.
const jsonLength = glb.readUInt32LE(12);
const gltf = JSON.parse(glb.subarray(20, 20 + jsonLength).toString("utf8"));
const bin = glb.subarray(20 + jsonLength + 8);
const view = (accessor) => {
  const a = gltf.accessors[accessor];
  const v = gltf.bufferViews[a.bufferView];
  const Type = a.componentType === 5126 ? Float32Array : Uint32Array;
  return new Type(bin.buffer.slice(bin.byteOffset + (v.byteOffset ?? 0), bin.byteOffset + (v.byteOffset ?? 0) + v.byteLength));
};
const tris = [];
for (const p of gltf.meshes[0].primitives) tris.push([view(p.attributes.POSITION), view(p.indices)]);
function height(x, y) {
  let best = -Infinity;
  for (const [pos, idx] of tris)
    for (let t = 0; t < idx.length; t += 3) {
      const [a, b, c] = [idx[t] * 3, idx[t + 1] * 3, idx[t + 2] * 3];
      const det = (pos[b + 1] - pos[c + 1]) * (pos[a] - pos[c]) + (pos[c] - pos[b]) * (pos[a + 1] - pos[c + 1]);
      if (Math.abs(det) < 1e-9) continue;
      const l1 = ((pos[b + 1] - pos[c + 1]) * (x - pos[c]) + (pos[c] - pos[b]) * (y - pos[c + 1])) / det;
      const l2 = ((pos[c + 1] - pos[a + 1]) * (x - pos[c]) + (pos[a] - pos[c]) * (y - pos[c + 1])) / det;
      const l3 = 1 - l1 - l2;
      if (l1 < 0 || l2 < 0 || l3 < 0) continue;
      best = Math.max(best, l1 * pos[a + 2] + l2 * pos[b + 2] + l3 * pos[c + 2]);
    }
  return best;
}
const at = (x, y) => [x, y, Math.round(height(x, y))];

// The cabin: 4 × 3 m, 2.5 m high, on the highest ground under it.
const [cx, cy, w, d] = [-8000, 4000, 4000, 3000];
const ground = Math.max(...[[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0]].map(([i, j]) => height(cx + (i * w) / 2, cy + (j * d) / 2)));
const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j], k) => ({ id: `p${k + 1}`, type: "point", x: cx + (i * w) / 2, y: cy + (j * d) / 2 }));
const doc = {
  format: "meercad/1",
  params: { height: "2.5 m" },
  units: "mm",
  features: [
    { id: "pl1", op: "plane", name: "Ground at the cabin", base: { ref: "origin.XY" }, offset: Math.round(ground) },
    {
      id: "sk1",
      op: "sketch",
      name: "Cabin footprint",
      plane: { ref: "pl1" },
      entities: [...corners, ...[0, 1, 2, 3].map((k) => ({ id: `l${k + 1}`, type: "line", p1: `p${k + 1}`, p2: `p${((k + 1) % 4) + 1}` }))],
      constraints: [],
    },
    { id: "ex1", op: "extrude", name: "Cabin", profile: { sketch: "sk1" }, extent: "blind", distance: "height", mode: "new_body" },
  ],
  references: [
    {
      id: "rf1",
      name: "Aukerman Park (OpenDroneMap, CC0)",
      format: "glb",
      data: glb.toString("base64"),
      geo: { lat: geo.lat, lon: geo.lon, alt: geo.alt },
      marks: [
        { id: "m1", kind: "area", points: [at(-60000, -20000), at(-20000, -25000), at(-15000, 5000), at(-55000, 10000)], color: "#2f9e44", text: "Meadow" },
        { id: "m2", kind: "line", points: [at(-30000, 30000), at(0, 15000), at(40000, 10000), at(80000, -20000)], color: "#e8590c", text: "Path" },
        { id: "m3", kind: "note", points: [at(cx, cy - 6000)], color: "#f2c94c", text: "The cabin stands here. Right-click it (hold it on the iPad): Place on the terrain…" },
        { id: "m4", kind: "point", points: [at(20000, -10000)], color: "#1c7ed6", text: "P1" },
      ],
    },
  ],
  rollback: null,
};
writeFileSync("tests/fixtures/terrain-drone-park.meercad", JSON.stringify(doc));
console.log("written", (JSON.stringify(doc).length / 1e6).toFixed(1), "MB; cabin ground", (ground / 1000).toFixed(2), "m");
