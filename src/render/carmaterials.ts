import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import type { Scene } from '@babylonjs/core/scene.js';
import { carbonWeave, createSurface, tyreRubber, type Surface } from './surfaces.js';
import { qualitySettings, type QualityTier } from './quality.js';

/**
 * What a racing car is made of, physically.
 *
 * ## What "PBR" has to mean to be worth the name
 *
 * The previous attempt at this bolted a `reflectionTexture` onto a
 * `StandardMaterial` and called it physically-based. It was not. Blinn-Phong
 * does not conserve energy — the specular highlight is added on top of the
 * diffuse rather than taken out of the same budget — so brightening the sun to
 * make the scene look lit blew the cars out to white, and the fix was to turn
 * the specular down until the paint stopped looking like paint. That is the
 * shape of the whole trap: every knob fights every other one, and the surface
 * never settles on looking like a real material.
 *
 * A metallic-roughness material settles, because the numbers mean something.
 * Roughness is how scattered the reflection is. Metallic is whether the
 * surface tints its reflection with its own colour (metal) or leaves it white
 * (everything else). Both are properties of the substance, and neither changes
 * when the lighting does — which is the actual payoff: turn the sun up and the
 * car gets brighter instead of getting whiter.
 *
 * ## Four substances, and why each is set the way it is
 *
 * ```
 *   paint    a coloured base under clear lacquer. Two lobes: the colour
 *            scatters, the lacquer reflects the sky sharply and without tint.
 *   carbon   a dark woven composite, also lacquered. Its LOOK is the weave,
 *            which is a normal map, not a colour.
 *   rubber   the darkest and roughest thing on the car; scatters almost
 *            everything, reflects almost nothing. Its job is contrast.
 *   metal    a rim: fully metallic, fairly polished, no colour of its own
 *            beyond a slight warmth.
 * ```
 *
 * The contrast between them is what sells any of them. A car where the tyres
 * and the bodywork catch light the same way reads as one moulded object, and
 * no amount of shaping fixes that.
 *
 * ## Everything needs something to reflect
 *
 * These materials are defined by what they reflect, so `scene.environmentTexture`
 * is not optional decoration — a metal with nothing to reflect renders as a
 * flat black shape. `environment.ts` generates one procedurally and every
 * quality tier gets it. See the note there.
 */

/** Texels per side for the generated surface patterns. */
export const SURFACE_SIZE = 256;

/** What the current quality tier will pay for. */
export interface FinishOptions {
  /** Normal-mapped weave and grain. Off on the cheapest tier. */
  readonly normalMaps: boolean;
  /** The lacquer lobe over paint and carbon. Off on the cheapest tier. */
  readonly clearCoat: boolean;
}

/**
 * What a tier will pay for, as a car's materials see it.
 *
 * The translation lives here rather than in `quality.ts` so that the tier
 * policy stays a pure statement about what a device can afford, with no
 * opinion about clear coat or weaves — and so there is exactly one place that
 * turns one into the other.
 */
export function finishOptions(tier: QualityTier): FinishOptions {
  const quality = qualitySettings(tier);
  return { normalMaps: quality.normalMaps, clearCoat: quality.clearCoat };
}

/**
 * The finishes every car on the grid shares.
 *
 * Shared because they are genuinely identical between cars — only the livery
 * differs — and because each one carries up to two 256px textures. Twenty cars
 * with their own copies would be forty textures saying the same thing.
 */
export class CarFinishes {
  readonly carbon: PBRMaterial;
  readonly rubber: PBRMaterial;
  readonly metal: PBRMaterial;

  readonly #scene: Scene;
  readonly #options: FinishOptions;
  readonly #surfaces: Surface[] = [];

  constructor(scene: Scene, options: FinishOptions) {
    this.#scene = scene;
    this.#options = options;

    const weave = this.#surface('car:carbon', carbonWeave(SURFACE_SIZE), {
      // Three tiles across a face. A real tow is millimetres wide, so honesty
      // here would be a shimmering moiré at any distance — the weave has to be
      // coarse enough to survive being minified onto a phone screen.
      uScale: 3,
      strength: 6,
    });
    const grain = this.#surface('car:rubber', tyreRubber(SURFACE_SIZE), {
      // Fine and faint: at 2 tiles and full strength the grain bristled the
      // tyres' silhouette in an elevation, and a slick's outline must be a
      // clean arc — the texture is for close-ups, not for the profile.
      uScale: 4,
      strength: 2,
    });

    this.carbon = new PBRMaterial('car:carbon', scene);
    this.carbon.albedoTexture = weave.albedo;
    if (weave.normal) this.carbon.bumpTexture = weave.normal;
    // Not zero — composite has graphite in it, and a slight metallic reading is
    // what stops it looking like moulded black plastic. Not much more than
    // zero either: carbon's albedo is nearly black, so every point of metallic
    // hands more of the surface over to the reflection, and past about here
    // the wings simply become mirrors of whatever the environment's ground
    // colour happens to be.
    this.carbon.metallic = 0.15;
    this.carbon.roughness = 0.45;
    this.#lacquer(this.carbon, 0.12);

    this.rubber = new PBRMaterial('car:rubber', scene);
    this.rubber.albedoTexture = grain.albedo;
    if (grain.normal) this.rubber.bumpTexture = grain.normal;
    this.rubber.metallic = 0;
    // Nearly the maximum. A tyre is the most diffuse thing in the scene, and
    // the flat, sunless look that gives it is exactly right — it is the anchor
    // everything shinier is judged against.
    this.rubber.roughness = 0.94;

    this.metal = new PBRMaterial('car:metal', scene);
    this.metal.albedoColor = new Color3(0.62, 0.62, 0.65).toLinearSpace();
    this.metal.metallic = 1;
    // Machined, not mirrored. A chrome rim reflects the whole circuit and
    // reads as a bubble; this is anodised aluminium.
    this.metal.roughness = 0.28;
  }

  /**
   * One car's wheel rims.
   *
   * Per car for one reason only: the rims ARE the brake glow. Their emissive
   * is driven frame by frame from that car's own deceleration, and a shared
   * rim material would light every wheel on the grid whenever anyone braked.
   * Owned by the caller, like the paint.
   */
  createWheelMetal(name: string): PBRMaterial {
    const metal = new PBRMaterial(name, this.#scene);
    metal.albedoColor = new Color3(0.5, 0.5, 0.53).toLinearSpace();
    metal.metallic = 1;
    metal.roughness = 0.3;
    // Starts cold. The glow is written into emissiveColor every frame by the
    // car's animation; this is only the resting state.
    metal.emissiveColor = new Color3(0, 0, 0);
    return metal;
  }

  /**
   * One car's livery.
   *
   * Handed over rather than kept: the colour is the one thing that is
   * genuinely per-player, so the car owns it and disposes it. A bank that also
   * held a reference would mean every paint being disposed twice — harmless
   * today, and exactly the sort of thing that stops being harmless later.
   */
  createPaint(name: string, color: Color3): PBRMaterial {
    const paint = new PBRMaterial(name, this.#scene);
    paint.albedoColor = color.toLinearSpace();
    // A hint of metallic flake, and no more than a hint. Metallic is a
    // *slider between two different materials*, not a gloss dial: as it rises
    // the diffuse colour is taken away and handed to the reflection, so a
    // strongly metallic car is mostly a mirror, and a mirror of a bright sky
    // is white. At 0.35 every livery came out pastel. Colour is how a player
    // finds their own car, so the flake loses this argument.
    paint.metallic = 0.12;
    paint.roughness = 0.34;
    this.#lacquer(paint, 0.06);
    return paint;
  }

  dispose(): void {
    this.carbon.dispose();
    this.rubber.dispose();
    this.metal.dispose();
    for (const surface of this.#surfaces) surface.dispose();
    this.#surfaces.length = 0;
  }

  // -------------------------------------------------------------- internals

  /**
   * The clear coat over a painted surface.
   *
   * A second specular lobe that does NOT take the colour underneath — which is
   * the whole trick, and the reason a red car has a white highlight rather
   * than a pink one. Below it the base is free to be as rough and as coloured
   * as it likes; the shine belongs to the lacquer, not to the pigment.
   *
   * Skipped on the cheapest tier, where the base lobe alone still reads as a
   * glossy surface, just a slightly plastic one.
   */
  #lacquer(material: PBRMaterial, roughness: number): void {
    if (!this.#options.clearCoat) return;
    material.clearCoat.isEnabled = true;
    material.clearCoat.intensity = 1;
    material.clearCoat.roughness = roughness;
  }

  #surface(
    name: string,
    pattern: ReturnType<typeof carbonWeave>,
    options: { uScale: number; strength: number },
  ): Surface {
    const surface = createSurface(this.#scene, name, pattern, {
      size: SURFACE_SIZE,
      uScale: options.uScale,
      strength: options.strength,
      withNormal: this.#options.normalMaps,
    });
    this.#surfaces.push(surface);
    return surface;
  }
}
