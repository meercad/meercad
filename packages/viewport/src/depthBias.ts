/**
 * Drawing lying on a face (a dimension on the face its sketch is on) is depth tested like the part, so
 * it hides behind other parts, but nearer to the camera than it is, so the face it lies on never hides
 * it. How much nearer grows with how flat the face is seen: across a slanted face the depth changes
 * from pixel to pixel, and the depth buffer is coarser far away. Only the depth moves: the picture
 * stays where it is.
 */
import * as THREE from "three";

/** Nearer by this share of the distance to the camera, seen straight on. */
export const DEPTH_SHARE = 4e-3;
/** And by this share per unit of the slope (tangent of the angle between view and face normal). */
export const DEPTH_SLOPE = 3e-3;
/** Never more than this share (seen along the face, where it cannot be read anyway). */
export const DEPTH_MAX = 0.08;

/**
 * `material`, depth tested, its depth nearer to the camera as above. `normal` is the face's (world);
 * without it the share for a face seen straight on.
 */
export function biasTowardCamera<M extends THREE.Material>(material: M, normal?: readonly number[]): M {
  material.depthTest = true;

  const n = new THREE.Vector3(...(normal ?? [0, 0, 1])).normalize();
  const sloped = !!normal && n.lengthSq() > 0;

  material.onBeforeCompile = (shader) => {
    shader.uniforms["biasNormal"] = { value: n };
    shader.vertexShader = `uniform vec3 biasNormal;\n${shader.vertexShader}`.replace(
      "#include <project_vertex>",
      `#include <project_vertex>
      {
        float slope = 0.0;
        ${
          sloped
            ? `vec3 toPoint = isPerspectiveMatrix(projectionMatrix) ? normalize(mvPosition.xyz) : vec3(0.0, 0.0, -1.0);
        vec3 facing = normalize((viewMatrix * vec4(biasNormal, 0.0)).xyz);
        float c = max(abs(dot(toPoint, facing)), 0.05);
        slope = sqrt(max(1.0 - c * c, 0.0)) / c;`
            : ""
        }
        float share = min(${glsl(DEPTH_SHARE)} + ${glsl(DEPTH_SLOPE)} * slope, ${glsl(DEPTH_MAX)});
        // Perspective: towards the eye by that share of the distance. Orthographic (no eye): towards
        // the camera by that share of the height of the view.
        vec4 nearer = isPerspectiveMatrix(projectionMatrix)
          ? projectionMatrix * vec4(mvPosition.xyz * (1.0 - share), 1.0)
          : projectionMatrix * vec4(mvPosition.xy, mvPosition.z + share * 2.0 / projectionMatrix[1][1], 1.0);
        gl_Position.z = nearer.z / nearer.w * gl_Position.w;
      }`,
    );
  };

  material.customProgramCacheKey = () => `bias-${sloped}`;

  return material;
}

const glsl = (x: number) => x.toFixed(6);

/** The normal of the plane a triangle lies in, or undefined for none. */
export function triangleNormal(
  a: readonly number[],
  b: readonly number[],
  c: readonly number[],
): number[] | undefined {
  const u = new THREE.Vector3(b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!);
  const v = new THREE.Vector3(c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!);
  const n = u.cross(v);

  return n.lengthSq() > 1e-18 ? n.normalize().toArray() : undefined;
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
