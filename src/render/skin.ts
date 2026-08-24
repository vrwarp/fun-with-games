import type { Color3 } from '@babylonjs/core/Maths/math.color.js';
import type { Material } from '@babylonjs/core/Materials/material.js';
import type { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import type { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';

/**
 * The three things a status effect ever changes about a player's body.
 *
 * Status is drawn on the body itself rather than as extra meshes — "it" burns,
 * frozen is icy, knocked out fades — so it has to reach into whatever the body
 * happens to be made of. That used to be one class, `StandardMaterial`, and
 * `#applyStatus` could simply set `diffuseColor`.
 *
 * It is no longer one class. A car is `PBRMaterial` (its whole appearance is
 * an answer to "what does this reflect?"), a sprite is a `StandardMaterial`
 * with lighting switched off, and the two spell the base colour differently:
 * `albedoColor` against `diffuseColor`. They are not related by inheritance
 * and there is no common ancestor that has either.
 *
 * So this is the seam. Three setters, one disposal, and the effects code stops
 * caring what kind of surface it is painting — which is what lets the car
 * become properly physical without the tag rules, the freeze effect and the
 * knockout fade all growing a branch.
 */
export interface PlayerSkin {
  /** The material itself, for assigning to a mesh. */
  readonly material: Material;
  /** The surface's own colour. */
  setBase(color: Color3): void;
  /** Light the surface emits regardless of the scene. */
  setGlow(color: Color3): void;
  /** 1 is solid. */
  setAlpha(alpha: number): void;
  dispose(): void;
}

/** A skin over the classic Blinn-Phong material. Sprites and people. */
export function standardSkin(material: StandardMaterial): PlayerSkin {
  return {
    material,
    setBase: (color) => {
      material.diffuseColor = color;
    },
    setGlow: (color) => {
      material.emissiveColor = color;
    },
    setAlpha: (alpha) => {
      material.alpha = alpha;
    },
    dispose: () => material.dispose(),
  };
}

/**
 * A skin over a physically-based material. Cars.
 *
 * The base colour is converted to linear space on the way in, and that is not
 * a detail: PBR does its arithmetic in linear light, so a hex colour handed
 * over untouched is a colour that has been gamma-encoded twice. The symptom is
 * a car that is washed out and too bright rather than obviously wrong, which
 * is the kind of thing that gets tuned around for an hour instead of fixed.
 */
export function pbrSkin(material: PBRMaterial): PlayerSkin {
  return {
    material,
    setBase: (color) => {
      material.albedoColor = color.toLinearSpace();
    },
    setGlow: (color) => {
      material.emissiveColor = color.toLinearSpace();
    },
    setAlpha: (alpha) => {
      material.alpha = alpha;
    },
    dispose: () => material.dispose(),
  };
}
