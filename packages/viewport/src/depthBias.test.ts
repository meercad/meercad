import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { biasTowardCamera, DEPTH_SHARE, HIDDEN_OPACITY, hiddenCopy } from "./depthBias";

describe("drawing lying on a face", () => {
  it("is depth tested a little nearer to the camera, the picture unmoved", () => {
    const material = biasTowardCamera(new THREE.LineBasicMaterial({ depthTest: false }));
    expect(material.depthTest).toBe(true);

    const shader = {
      vertexShader: "a\n#include <project_vertex>\nb",
    } as THREE.WebGLProgramParametersWithUniforms;
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.vertexShader).toContain(`mvPosition.xyz * ${(1 - DEPTH_SHARE).toFixed(6)}`);
    // Only the depth changes.
    expect(shader.vertexShader).toContain("gl_Position.z = nearer.z / nearer.w * gl_Position.w;");
    expect(material.customProgramCacheKey()).toBe(`bias-${DEPTH_SHARE}`);
  });

  it("is drawn faint over everything where it is hidden", () => {
    const material = new THREE.MeshBasicMaterial({ opacity: 1 });
    const faint = hiddenCopy(material);
    expect(faint).not.toBe(material);
    expect(faint.depthTest).toBe(false);
    expect(faint.depthWrite).toBe(false);
    expect(faint.transparent).toBe(true);
    expect(faint.opacity).toBeCloseTo(HIDDEN_OPACITY, 9);
  });
});
