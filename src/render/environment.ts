import { RawCubeTexture } from '@babylonjs/core/Materials/Textures/rawCubeTexture.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { Constants } from '@babylonjs/core/Engines/constants.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import type { Scene } from '@babylonjs/core/scene.js';

/**
 * The sky, as something surfaces can reflect.
 *
 * Physically-based materials need an environment to be based on. Metal is not
 * a colour — it is a mirror with a tint, and a mirror with nothing to reflect
 * renders as a flat black shape. That is the single most common way a PBR
 * scene comes out looking worse than the unlit one it replaced.
 *
 * Normally this is a captured HDR panorama shipped as a file. This kit forbids
 * that — `docs/ASSETS.md`: procedural first, and the game must run with no art
 * at all — so the environment is *drawn*, here, from the same three colours the
 * sky itself is painted with. Six small faces, generated once at startup, no
 * network, no licence, deterministic.
 *
 * It is not a real captured sky and it will not fool anyone looking for one.
 * What it does do is the job that actually matters at this scale: give car
 * paint a bright horizon to catch, a dark ground to sit against, and a gradient
 * in between that moves as the car turns. That is what reads as "polished
 * metal" rather than "coloured plastic", and none of it needs a photograph.
 *
 * ## Why a cube and not a sphere
 *
 * A cube texture is what the GPU samples a reflection with. Generating it
 * directly avoids a conversion pass at startup and lets each face be filled
 * with a couple of loops over a small buffer.
 */

/** Texels per cube face for the reflection probe. Small — see the mip note. */
const FACE = 64;

/**
 * Texels per face for the sky you actually LOOK at.
 *
 * Bigger than the reflection, because the two are asked completely different
 * questions. A reflection wants to be blurry and is read through a mip chain;
 * the dome fills the screen, and a gradient across 64 texels magnified to a
 * thousand pixels bands into visible steps.
 */
const DOME_FACE = 192;

/** The six faces, in the order Babylon expects: +X -X +Y -Y +Z -Z. */
const FACE_COUNT = 6;

/** Colours of the generated sky. Chosen to match what `renderer.ts` paints. */
export interface SkyColours {
  /** Straight up. */
  readonly zenith: Color3;
  /** The band the sky meets the ground at, and the brightest thing reflected. */
  readonly horizon: Color3;
  /**
   * Straight down: the light bouncing back off whatever the scene stands on.
   *
   * Deliberately NEUTRAL, and that is a correction rather than a simplification.
   * It was grass-green, on the reasoning that a circuit stands on grass — but
   * this cube is what every surface in the scene is lit and mirrored by, and a
   * green lower hemisphere puts a green cast on everything facing even
   * slightly downward or lit by ambient at all. The most obvious victim was
   * the tarmac, which came out sage. A circuit is mostly its own asphalt
   * anyway, so neutral is closer to the truth as well as to the intent.
   */
  readonly ground: Color3;
}

export const DAYLIGHT: SkyColours = {
  zenith: new Color3(0.34, 0.48, 0.72),
  horizon: new Color3(0.78, 0.85, 0.94),
  ground: new Color3(0.15, 0.15, 0.145),
};

/**
 * Colour of the sky looking along `y`, where +1 is straight up and -1 down.
 *
 * Exported because it is the whole visual decision and a pure function of one
 * number, so it can be checked without a GPU — which is the only place this
 * can be checked at all, since nothing in CI renders.
 */
export function skyColourAt(y: number, colours: SkyColours = DAYLIGHT): Color3 {
  if (y >= 0) {
    // Above the horizon. Eased so the bright band hugs the horizon rather than
    // washing halfway up the sky, which is what a real one does and what makes
    // a reflection look like it has a horizon in it at all.
    const t = Math.min(1, Math.sqrt(y));
    return Color3.Lerp(colours.horizon, colours.zenith, t);
  }
  // Below. Falls off fast: the ground is close, so it darkens quickly.
  const t = Math.min(1, -y * 2.2);
  return Color3.Lerp(colours.horizon, colours.ground, t);
}

/**
 * Direction a texel on cube face `face` points, as a unit vector's y component.
 *
 * The cube faces are laid out in Babylon's order, and for a gradient sky the
 * only component that matters is which way is up.
 */
function upwardAt(face: number, u: number, v: number): number {
  // u, v run -1..1 across the face.
  switch (face) {
    case 2:
      return 1 / Math.hypot(u, 1, v); // +Y
    case 3:
      return -1 / Math.hypot(u, 1, v); // -Y
    default:
      // The four side faces. On all of them the vertical texel axis is world
      // -Y, so the up component is -v scaled into the unit direction.
      return -v / Math.hypot(u, v, 1);
  }
}

/**
 * Builds the environment and hands it to the scene.
 *
 * Returned so the caller owns disposal; a cube texture that outlives its scene
 * is a leak that only shows up after a few mode changes.
 */
/** The six faces of a sky cube at a given resolution. */
function skyFaces(size: number, colours: SkyColours): ArrayBufferView[] {
  const faces: ArrayBufferView[] = [];
  for (let face = 0; face < FACE_COUNT; face++) {
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        // Texel centres, so the gradient is symmetric across the face.
        const u = ((x + 0.5) / size) * 2 - 1;
        const v = ((y + 0.5) / size) * 2 - 1;
        const colour = skyColourAt(upwardAt(face, u, v), colours);
        const at = (y * size + x) * 4;
        data[at] = Math.round(colour.r * 255);
        data[at + 1] = Math.round(colour.g * 255);
        data[at + 2] = Math.round(colour.b * 255);
        data[at + 3] = 255;
      }
    }
    faces.push(data);
  }
  return faces;
}

export function createSkyEnvironment(scene: Scene, colours: SkyColours = DAYLIGHT): RawCubeTexture {
  const faces = skyFaces(FACE, colours);

  const texture = new RawCubeTexture(
    scene,
    faces,
    FACE,
    Constants.TEXTUREFORMAT_RGBA,
    Constants.TEXTURETYPE_UNSIGNED_BYTE,
    // Mips, because roughness samples them: a matte surface reads a blurred
    // version of the environment and a polished one reads a sharp one. Without
    // a mip chain every surface reflects the same crisp gradient and the whole
    // scene looks like it is made of chrome. 64px is small precisely so the
    // blurrier levels are genuinely blurry.
    true,
    false,
    Constants.TEXTURE_TRILINEAR_SAMPLINGMODE,
  );
  texture.name = 'env:sky';
  // Gamma-space data going into a linear pipeline: say so, or the reflections
  // come out washed out and the whole scene reads as fogged.
  texture.gammaSpace = true;

  scene.environmentTexture = texture;
  return texture;
}

/**
 * The sky as scenery: a box around the camera, painted with the same gradient.
 *
 * The scene used to end at a flat `clearColor`, and a flat colour behind a
 * circuit is the thing that reads as "unfinished demo" before any individual
 * object does. A real sky is darker overhead than at the horizon, and that
 * single gradient is what gives the picture a top and a bottom — everything
 * below it then looks like it is standing under something rather than pasted
 * onto a backdrop.
 *
 * It shares its colours with the reflection probe on purpose. A car that
 * mirrors a sky the player cannot see is a car reflecting a different world,
 * and the mismatch is obvious long before anyone can say why.
 *
 * Unlit, unfogged, and pinned to the camera, so it is genuinely infinitely far
 * away: it never clips, never has to fit inside the far plane, and costs one
 * cube lookup per background pixel.
 */
export function createSkyDome(scene: Scene, colours: SkyColours = DAYLIGHT): Mesh {
  const texture = new RawCubeTexture(
    scene,
    skyFaces(DOME_FACE, colours),
    DOME_FACE,
    Constants.TEXTUREFORMAT_RGBA,
    Constants.TEXTURETYPE_UNSIGNED_BYTE,
    // No mips: the dome is only ever magnified, so a mip chain would be memory
    // spent on levels nothing samples.
    false,
    false,
    Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
  );
  texture.name = 'sky:dome';
  texture.coordinatesMode = Texture.SKYBOX_MODE;
  texture.gammaSpace = true;

  const material = new StandardMaterial('sky:dome:mat', scene);
  material.backFaceCulling = false;
  material.disableLighting = true;
  material.reflectionTexture = texture;
  material.diffuseColor = Color3.Black();
  material.specularColor = Color3.Black();

  const mesh = CreateBox('sky:dome', { size: 100 }, scene);
  mesh.material = material;
  // Follows the camera and is drawn first, at the far plane. The size above is
  // therefore arbitrary — what matters is that nothing can get between the
  // camera and it.
  mesh.infiniteDistance = true;
  mesh.applyFog = false;
  mesh.isPickable = false;
  mesh.receiveShadows = false;
  return mesh;
}
