import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  biasTowardCamera,
  DEPTH_MAX,
  DEPTH_SHARE,
  DEPTH_SLOPE,
  HIDDEN_OPACITY,
  hiddenCopy,
  triangleNormal,
} from "./depthBias";

const compiled = (material: THREE.Material) => {
  const shader = {
    vertexShader: "a\n#include <project_vertex>\nb",
    uniforms: {},
  } as unknown as THREE.WebGLProgramParametersWithUniforms;
  material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);

  return shader;
};

describe("drawing lying on a face", () => {
  it("is depth tested nearer to the camera, more the flatter its face is seen, the picture unmoved", () => {
    const material = biasTowardCamera(new THREE.LineBasicMaterial({ depthTest: false }), [0, 0, 2]);
    expect(material.depthTest).toBe(true);

    const shader = compiled(material);
    expect(shader.vertexShader.startsWith("uniform vec3 biasNormal;")).toBe(true);
    expect((shader.uniforms["biasNormal"]!.value as THREE.Vector3).toArray()).toEqual([0, 0, 1]);
    expect(shader.vertexShader).toContain(`${DEPTH_SHARE.toFixed(6)} + ${DEPTH_SLOPE.toFixed(6)} * slope`);
    expect(shader.vertexShader).toContain(`${DEPTH_MAX.toFixed(6)}`);
    expect(shader.vertexShader).toContain("slope = sqrt(");
    // Towards the eye in perspective, along the view in an orthographic view; only the depth changes.
    expect(shader.vertexShader).toContain("mvPosition.xyz * (1.0 - share)");
    expect(shader.vertexShader).toContain("mvPosition.z + share * 2.0 / projectionMatrix[1][1]");
    expect(shader.vertexShader).toContain("gl_Position.z = nearer.z / nearer.w * gl_Position.w;");
    expect(material.customProgramCacheKey()).toBe("bias-true");
  });

  it("without its face's normal, by the share for a face seen straight on", () => {
    const material = biasTowardCamera(new THREE.MeshBasicMaterial());
    const shader = compiled(material);
    expect(shader.vertexShader).not.toContain("slope = sqrt(");
    expect(material.customProgramCacheKey()).toBe("bias-false");
  });

  it("knows the normal of a triangle's plane", () => {
    expect(triangleNormal([0, 0, 0], [1, 0, 0], [0, 1, 0])).toEqual([0, 0, 1]);
    expect(triangleNormal([0, 0, 0], [1, 0, 0], [2, 0, 0])).toBeUndefined();
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
