// @vitest-environment happy-dom
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { drawLook, grownQuad, MARGIN_PX, pixelAt, SceneTexts, screenQuad, type Quad } from "./sceneText";

const close = (a: readonly number[], b: readonly number[]) =>
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 9));

/** A 2D context that records what is drawn. */
function recorder() {
  const calls: string[] = [];
  const g = new Proxy({} as Record<string, unknown>, {
    get: (target, key: string) =>
      key in target ? target[key] : (...a: unknown[]) => calls.push(`${key}:${a.join(",")}`),
    set: (target, key: string, value) => ((target[key] = value), calls.push(`${key}=${value}`), true),
  });
  const canvas = { width: 0, height: 0, getContext: () => g } as unknown as HTMLCanvasElement;

  return { canvas, calls };
}

const look = { text: "70 mm", font: "600 12px monospace", color: "rgb(0, 0, 0)" };

describe("quads", () => {
  it("grows a box by a margin of pixels each side", () => {
    // 10 × 4 pixels, one unit per pixel, lying in the x-y plane (top at y = 4).
    const box: Quad = [
      [0, 4, 0],
      [10, 4, 0],
      [10, 0, 0],
      [0, 0, 0],
    ];
    const grown = grownQuad(box, [10, 4], 2);
    close(grown[0], [-2, 6, 0]);
    close(grown[1], [12, 6, 0]);
    close(grown[2], [12, -2, 0]);
    close(grown[3], [-2, -2, 0]);
  });

  it("faces the screen, centred off its point by pixels", () => {
    const q = screenQuad([0, 0, 0], [10, -4], [20, 10], [1, 0, 0], [0, 1, 0], 0.5);
    // Centre 5 right, 2 up; half sizes 5 and 2.5.
    close(q[0], [0, 4.5, 0]);
    close(q[1], [10, 4.5, 0]);
    close(q[2], [10, -0.5, 0]);
    close(q[3], [0, -0.5, 0]);
  });

  it("knows the size of a pixel at a depth", () => {
    const persp = new THREE.PerspectiveCamera(90, 1, 0.1, 100);
    expect(pixelAt(persp, 200, 100)).toBeCloseTo(1, 9);
    expect(pixelAt(persp, 200, -1)).toBe(0);

    const ortho = new THREE.OrthographicCamera(-50, 50, 50, -50);
    ortho.zoom = 2;
    expect(pixelAt(ortho, 100, 5)).toBeCloseTo(0.5, 9);
    expect(pixelAt(new THREE.Camera(), 100, 5)).toBe(0);
  });
});

describe("drawLook", () => {
  it("draws plain text with a halo, oversampled, with room round it", () => {
    const { canvas, calls } = recorder();
    drawLook(canvas, { ...look, halo: "rgb(255, 255, 255)" }, [40, 18], 2);
    expect(canvas.width).toBe((40 + 2 * MARGIN_PX) * 2);
    expect(canvas.height).toBe((18 + 2 * MARGIN_PX) * 2);
    expect(calls).toContain("strokeStyle=rgb(255, 255, 255)");
    expect(calls.some((c) => c.startsWith("strokeText:70 mm"))).toBe(true);
    expect(calls.some((c) => c.startsWith("fillText:70 mm"))).toBe(true);
    expect(calls.some((c) => c.startsWith("roundRect"))).toBe(false);
  });

  it("draws a chip behind the text, dashed if asked", () => {
    const { canvas, calls } = recorder();
    drawLook(
      canvas,
      { ...look, chip: { fill: "white", border: "grey", radius: 99, dashed: true } },
      [40, 24],
      1,
    );
    expect(calls.some((c) => c.startsWith("roundRect") && c.endsWith(",12"))).toBe(true);
    expect(calls).toContain("setLineDash:3,2");
    expect(calls.some((c) => c.startsWith("strokeText"))).toBe(false);

    const solid = recorder();
    drawLook(solid.canvas, { ...look, chip: { fill: "white", border: "grey", radius: 4 } }, [40, 24], 1);
    expect(solid.calls).toContain("setLineDash:");
  });

  it("does nothing without a 2D context", () => {
    const canvas = { width: 0, height: 0, getContext: () => null } as unknown as HTMLCanvasElement;
    expect(() => drawLook(canvas, look, [10, 10], 1)).not.toThrow();
  });
});

describe("SceneTexts", () => {
  const texts = () =>
    new SceneTexts(
      () => 2,
      () => 8,
    );
  const box: Quad = [
    [0, 4, 0],
    [10, 4, 0],
    [10, 0, 0],
    [0, 0, 0],
  ];

  const positions = (t: SceneTexts, id: string) => {
    const mesh = t.group.getObjectByName(id) as THREE.Mesh;

    return Array.from((mesh.geometry.getAttribute("position") as THREE.BufferAttribute).array);
  };

  it("lays a value in its plane on its corners, grown by the margin", () => {
    const t = texts();
    t.set("a", { look, size: [10, 4], corners: box });
    expect(t.ids()).toEqual(["a"]);
    expect(t.has("a")).toBe(true);
    close(positions(t, "a").slice(0, 3), [-MARGIN_PX, 4 + MARGIN_PX, 0]);

    const mesh = t.group.getObjectByName("a") as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
    expect(mesh.material.depthTest).toBe(false);
    expect(mesh.material.map!.anisotropy).toBe(8);

    // Moved: the same mesh, new corners.
    t.set("a", { look, size: [10, 4], corners: box.map((p) => [p[0], p[1], 1]) as unknown as Quad });
    expect(t.group.children).toHaveLength(1);
    expect(positions(t, "a")[2]).toBeCloseTo(1, 9);
  });

  it("hides a value lying on a face behind parts, a faint copy showing through", () => {
    const t = texts();
    t.set("h", { look, size: [10, 4], corners: box, hides: true });

    const mesh = t.group.getObjectByName("h") as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
    expect(mesh.material.depthTest).toBe(true);

    const ghost = mesh.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
    expect(ghost.material.depthTest).toBe(false);
    expect(ghost.geometry).toBe(mesh.geometry);

    // A new texture reaches the copy too; removed with it.
    t.set("h", { look, size: [40, 4], corners: box, hides: true });
    expect(ghost.material.map).toBe(mesh.material.map);
    t.set("h", null);
    expect(t.group.children).toHaveLength(0);
  });

  it("turns values facing the screen to the camera", () => {
    const t = texts();
    t.set("b", { look, size: [10, 4], at: [0, 0, -10], offset: [5, 0] });

    const camera = new THREE.PerspectiveCamera(90, 1, 0.1, 100);
    camera.updateMatrixWorld();
    t.update(camera, 20); // one unit per pixel at depth 10

    const p = positions(t, "b");
    close(p.slice(0, 3), [5 - 5 - MARGIN_PX, 2 + MARGIN_PX, -10]);

    // Without an offset: centred on its point.
    t.set("d", { look, size: [10, 4], at: [0, 0, -10] });
    t.update(camera, 20);
    close(positions(t, "d").slice(0, 3), [-5 - MARGIN_PX, 2 + MARGIN_PX, -10]);

    // Behind the camera: hidden.
    t.set("b", { look, size: [10, 4], at: [0, 0, 10] });
    t.update(camera, 20);
    expect(t.group.getObjectByName("b")!.visible).toBe(false);

    // Lying in a plane: left alone.
    t.set("c", { look, size: [10, 4], corners: box });

    const before = positions(t, "c");
    t.update(camera, 20);
    expect(positions(t, "c")).toEqual(before);
  });

  it("draws the texture again only when the look or size changes", () => {
    const t = texts();
    t.set("a", { look, size: [10, 4], corners: box });

    const mesh = () =>
      t.group.getObjectByName("a") as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
    const first = mesh().material.map;
    const version = first!.version;
    t.set("a", { look, size: [10, 4], corners: box });
    expect(mesh().material.map!.version).toBe(version);

    // Another colour, the same size: the same texture, drawn again.
    t.set("a", { look: { ...look, color: "red" }, size: [10, 4], corners: box });
    expect(mesh().material.map).toBe(first);
    expect(mesh().material.map!.version).toBeGreaterThan(version);

    // Another size: a new texture.
    t.set("a", { look, size: [30, 4], corners: box });
    expect(mesh().material.map).not.toBe(first);
  });

  it("draws everything again once web fonts arrive, removes and disposes", () => {
    const listeners: (() => void)[] = [];
    const fonts = { addEventListener: (_: string, fn: () => void) => listeners.push(fn) };
    const had = Object.getOwnPropertyDescriptor(document, "fonts");
    Object.defineProperty(document, "fonts", { value: fonts, configurable: true });

    try {
      const t = texts();
      t.set("a", { look, size: [10, 4], corners: box });

      const map = (t.group.getObjectByName("a") as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>)
        .material.map!;
      const version = map.version;
      listeners.forEach((fn) => fn());
      expect(map.version).toBeGreaterThan(version);

      const dispose = vi.spyOn(map, "dispose");
      t.set("a", null);
      t.set("missing", null);
      expect(dispose).toHaveBeenCalled();
      expect(t.ids()).toEqual([]);

      t.set("x", { look, size: [10, 4], corners: box });
      t.set("y", { look, size: [10, 4], corners: box });
      t.dispose();
      expect(t.group.children).toHaveLength(0);
    } finally {
      if (had) Object.defineProperty(document, "fonts", had);
      else delete (document as { fonts?: unknown }).fonts;
    }
  });
});
