/**
 * Drawing lying on a face (a dimension on the face its sketch is on) is depth tested like the part, so
 * it hides behind other parts, but a little nearer to the camera than it is, so it never flickers
 * against the face it lies on. Only the depth moves: the picture stays where it is.
 */
import * as THREE from "three";

/** How much nearer, as a share of the distance to the camera (the depth buffer resolves ~1/8 of it). */
export const DEPTH_SHARE = 1e-3;

/** `material`, its depth nearer to the camera by `share` of the distance; depth tested. */
export function biasTowardCamera<M extends THREE.Material>(material: M, share = DEPTH_SHARE): M {
  material.depthTest = true;

  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      "#include <project_vertex>",
      `#include <project_vertex>
      {
        vec4 nearer = projectionMatrix * vec4(mvPosition.xyz * ${(1 - share).toFixed(6)}, 1.0);
        gl_Position.z = nearer.z / nearer.w * gl_Position.w;
      }`,
    );
  };

  material.customProgramCacheKey = () => `bias-${share}`;

  return material;
}

/** Hidden parts are drawn this faint over what hides them. */
export const HIDDEN_OPACITY = 0.28;

/** A faint copy of `material` for where the drawing is hidden: over everything, see-through. */
export function hiddenCopy<M extends THREE.Material>(material: M): M {
  const faint = material.clone() as M;
  faint.depthTest = false;
  faint.depthWrite = false;
  faint.transparent = true;
  faint.opacity = material.opacity * HIDDEN_OPACITY;

  return faint;
}
