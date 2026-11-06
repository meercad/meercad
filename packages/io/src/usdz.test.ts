import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { writeUsda, writeUsdz } from "./index.js";

/** A 20 × 10 × 5 mm box from (100, 50, 30): 8 corners, 12 triangles facing out. */
function box() {
  const [x0, y0, z0, x1, y1, z1] = [100, 50, 30, 120, 60, 35];
  const positions = new Float32Array([x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1]);
  const indices = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]);
  return { positions, indices };
}

const points = (usda: string, mesh: string) => {
  const block = usda.slice(usda.indexOf(`def Mesh "${mesh}"`));
  const list = /point3f\[\] points = \[(.*?)\]\n/.exec(block)![1]!;
  return [...list.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]!.split(", ").map(Number));
};

describe("USDZ", () => {
  it("stands the part on the table in real size: metres, Y up, centred, lowest point at 0", () => {
    const usda = writeUsda([{ ...box(), name: "Halter (oben)", color: "#ff0000" }]);
    expect(usda).toContain("metersPerUnit = 1");
    expect(usda).toContain('upAxis = "Y"');
    expect(usda).toContain('def Mesh "Halter_oben"');
    const p = points(usda, "Halter_oben");
    const ext = (k: number) => [Math.min(...p.map((v) => v[k]!)), Math.max(...p.map((v) => v[k]!))];
    expect(ext(0)).toEqual([-0.01, 0.01]); // 20 mm wide, centred
    expect(ext(1)).toEqual([0, 0.005]); // 5 mm high, standing on y = 0
    expect(ext(2)).toEqual([-0.005, 0.005]); // 10 mm deep
    // Design +Y (away) becomes USD −Z (away from the viewer).
    expect(p[3]![2]).toBeCloseTo(-0.005);
    // Red in linear light.
    expect(usda).toContain("color3f inputs:diffuseColor = (1, 0, 0)");
  });

  it("keeps part names apart and valid", () => {
    const usda = writeUsda([
      { ...box(), name: "Teil" },
      { ...box(), name: "Teil" },
      { ...box(), name: "3D-Druck Größe" },
    ]);
    expect(usda).toContain('def Mesh "Teil"');
    expect(usda).toContain('def Mesh "Teil_2"');
    expect(usda).toContain('def Mesh "_3D_Druck_Groesse"');
  });

  it("packs a stored zip with the scene's data on a 64-byte boundary", () => {
    const usdz = writeUsdz([{ ...box(), color: "#336699", metalness: 1, roughness: 0.3 }]);
    const files = unzipSync(usdz);
    expect(Object.keys(files)).toEqual(["model.usda"]);
    expect(strFromU8(files["model.usda"]!)).toContain("float inputs:metallic = 1");
    const view = new DataView(usdz.buffer, usdz.byteOffset);
    expect(view.getUint16(8, true)).toBe(0); // stored
    const dataStart = 30 + view.getUint16(26, true) + view.getUint16(28, true);
    expect(dataStart % 64).toBe(0);
  });

  it.skipIf(!existsSync("/usr/bin/usdchecker"))("passes Pixar's checker with the ARKit rules", () => {
    const dir = mkdtempSync(join(tmpdir(), "usdz-"));
    const file = join(dir, "box.usdz");
    const b = box();
    writeFileSync(file, writeUsdz([{ ...b, normals: new Float32Array(b.positions.length).fill(0.577), name: "Box", color: "#c4cfdc" }]));
    const out = execFileSync("/usr/bin/usdchecker", ["--arkit", file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(out).toContain("Success");
  });

  it("refuses an empty model", () => {
    expect(() => writeUsdz([])).toThrow();
  });
});
