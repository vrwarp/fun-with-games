import { RawCubeTexture } from '@babylonjs/core/Materials/Textures/rawCubeTexture.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { Constants } from '@babylonjs/core/Engines/constants.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import type { Scene } from '@babylonjs/core/scene.js';
import { fbm } from './surfaces.js';

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
const DOME_FACE = 256;

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
  /** Unit vector pointing AT the sun. Must agree with the key light — see below. */
  readonly sunX: number;
  readonly sunY: number;
  readonly sunZ: number;
  /** The disc itself. Brighter than white on purpose; the tone curve rolls it off. */
  readonly sunColour: Color3;
  /** A cloud's lit top. */
  readonly cloud: Color3;
  /** A cloud's shaded underside. Without one, clouds read as paper cut-outs. */
  readonly cloudShade: Color3;
  /** 0 is a clear sky, 1 is overcast. */
  readonly cloudCover: number;
}

export const DAYLIGHT: SkyColours = {
  zenith: new Color3(0.34, 0.48, 0.72),
  horizon: new Color3(0.78, 0.85, 0.94),
  ground: new Color3(0.15, 0.15, 0.145),
  // Normalised from (0.5, 1, -0.4) — the negation of the key light's travel
  // direction. `SUN_TRAVEL` below is what the renderer hands the light, so the
  // two cannot drift apart.
  sunX: 0.4211,
  sunY: 0.8422,
  sunZ: -0.3369,
  sunColour: new Color3(1, 0.97, 0.9),
  cloud: new Color3(1, 0.99, 0.97),
  cloudShade: new Color3(0.62, 0.66, 0.74),
  cloudCover: 0.45,
};

/**
 * The direction sunlight TRAVELS, which is what a `DirectionalLight` wants.
 *
 * Exported so the visible sun and the light that casts the shadows are the
 * same fact stated once. They were two independent constants, and a sky whose
 * sun is in a different place from the one lighting the cars is the kind of
 * wrongness everybody feels and nobody can name.
 */
export const SUN_TRAVEL = { x: -DAYLIGHT.sunX, y: -DAYLIGHT.sunY, z: -DAYLIGHT.sunZ };

/** Smooth 0..1 ramp between two edges. */
function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Lattice size for the cloud field. Large, because a sky does not tile — it is
 * sampled once over a bounded range and any repetition would read as wallpaper.
 */
const CLOUD_PERIOD = 64;
/** How big the cloud clumps are. Lower is bigger. */
const CLOUD_SCALE = 1.15;

/**
 * How much cloud is in the way, looking along a unit direction.
 *
 * A cloud deck is a flat layer at a height, so the honest projection is where
 * the view ray crosses that layer: `p = dir.xz / dir.y`. It depends only on the
 * direction, which means every cube face agrees at its edges for free — the
 * alternative, sampling per-face 2D noise, puts a visible seam down all twelve.
 *
 * Straight up the projection is tight and the clouds are small overhead; near
 * the horizon it stretches toward infinity, which is exactly what a cloud layer
 * seen edge-on does. It is also where the detail compresses below one texel, so
 * the last few degrees fade into the horizon haze rather than aliasing into it.
 */
export function cloudAt(x: number, y: number, z: number, colours: SkyColours = DAYLIGHT): number {
  if (y <= 0.03 || colours.cloudCover <= 0) return 0;
  const reach = 1 / y;
  const density = fbm(x * reach * CLOUD_SCALE, z * reach * CLOUD_SCALE, CLOUD_PERIOD, 4);
  // `cover` moves the threshold rather than scaling the result: at low cover
  // you get a few separate clouds in a clear sky, which is what "scattered"
  // means. Scaling would give you a uniform grey veil instead.
  const threshold = 1 - colours.cloudCover;
  return smoothstep(threshold, threshold + 0.2, density) * smoothstep(0.03, 0.18, y);
}

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
 * Everything the sky sends back along one direction: gradient, sun, cloud.
 *
 * Ordered the way the light actually arrives. The gradient is the air itself;
 * the sun is added to it, because a disc that far outshines its surroundings
 * is a source rather than a surface; and the cloud is composited LAST, over
 * both, because a cloud is in front of the sky and in front of the sun. Adding
 * the sun after the cloud would put a bright disc through an overcast, which
 * is the single most obvious way to get a procedural sky wrong.
 *
 * `x, y, z` must be a unit vector.
 */
export function skyRadianceAt(
  x: number,
  y: number,
  z: number,
  colours: SkyColours = DAYLIGHT,
): Color3 {
  const colour = skyColourAt(y, colours);

  // The sun, as two lobes. A single one cannot be both: tight enough to read
  // as a disc AND wide enough to give the sky the glare that surrounds a real
  // one, which is most of what says "bright day" rather than "blue paint".
  const towardSun = Math.max(0, x * colours.sunX + y * colours.sunY + z * colours.sunZ);
  const disc = Math.pow(towardSun, 1600);
  const glare = Math.pow(towardSun, 6) * 0.22;
  colour.r += colours.sunColour.r * (disc + glare);
  colour.g += colours.sunColour.g * (disc + glare);
  colour.b += colours.sunColour.b * (disc + glare);

  const cloud = cloudAt(x, y, z, colours);
  if (cloud > 0) {
    // Thin edges are lit through and bright; thick middles are shaded. That
    // one gradient is the difference between clouds and white blobs.
    const lit = smoothstep(0.15, 0.75, cloud);
    const r = colours.cloudShade.r + (colours.cloud.r - colours.cloudShade.r) * lit;
    const g = colours.cloudShade.g + (colours.cloud.g - colours.cloudShade.g) * lit;
    const b = colours.cloudShade.b + (colours.cloud.b - colours.cloudShade.b) * lit;
    colour.r += (r - colour.r) * cloud;
    colour.g += (g - colour.g) * cloud;
    colour.b += (b - colour.b) * cloud;
  }

  return colour;
}

/**
 * Unit direction a texel on cube face `face` points along.
 *
 * The faces are in Babylon's order: +X -X +Y -Y +Z -Z. This used to return
 * only the y component, which was all a plain gradient needed; a sun and a
 * cloud layer need the whole vector.
 */
export function directionAt(face: number, u: number, v: number): [number, number, number] {
  // u, v run -1..1 across the face. The vertical texel axis is world -Y on
  // every side face, and the horizontal one flips with the face's handedness.
  let x: number;
  let y: number;
  let z: number;
  switch (face) {
    case 0:
      [x, y, z] = [1, -v, -u]; // +X
      break;
    case 1:
      [x, y, z] = [-1, -v, u]; // -X
      break;
    case 2:
      [x, y, z] = [u, 1, v]; // +Y
      break;
    case 3:
      [x, y, z] = [u, -1, -v]; // -Y
      break;
    case 4:
      [x, y, z] = [u, -v, 1]; // +Z
      break;
    default:
      [x, y, z] = [-u, -v, -1]; // -Z
      break;
  }
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
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
        const [dx, dy, dz] = directionAt(face, u, v);
        const colour = skyRadianceAt(dx, dy, dz, colours);
        const at = (y * size + x) * 4;
        // Clamped, not scaled: the sun is deliberately brighter than the
        // buffer can hold, and letting it burn out is what a photograph does.
        data[at] = Math.min(255, Math.round(colour.r * 255));
        data[at + 1] = Math.min(255, Math.round(colour.g * 255));
        data[at + 2] = Math.min(255, Math.round(colour.b * 255));
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
  // The dome and the reflection probe want DIFFERENT lower hemispheres, and
  // that is not an inconsistency — they answer different questions.
  //
  // The probe models radiance: what is actually down there is dark ground, and
  // a car's underside should reflect it. The dome models what a player SEES,
  // and in a scene with a floor you never see the sky below the horizon at
  // all — except at the edges of the world, where a dark hemisphere reads as a
  // hole punched in the picture. Haze is the least wrong thing to put there,
  // so below the horizon the dome simply keeps dimming the horizon colour.
  const domeColours: SkyColours = { ...colours, ground: colours.horizon.scale(0.72) };
  const texture = new RawCubeTexture(
    scene,
    skyFaces(DOME_FACE, domeColours),
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
