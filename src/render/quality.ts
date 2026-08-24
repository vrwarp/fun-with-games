/**
 * How much rendering this device can afford.
 *
 * Every technique below "looks expensive" costs fill rate, and this game's
 * primary target reports a device pixel ratio of 3 — nine times the fragments
 * of a 1x screen for the same physical area. A post-processing chain that is
 * free on a laptop is a slideshow there. So the renderer does not have one
 * look; it has three, and picks.
 *
 * ## Why this is a separate, pure module
 *
 * The decisions here are the ones most likely to be wrong, and the ones
 * hardest to check where it matters: CI runs headless software rendering at
 * single-digit frame rates whatever the settings, so a browser test cannot
 * tell a cheap tier from an expensive one. Keeping the POLICY pure — which
 * tier a device starts on, when to give one up — means it can be pinned in
 * milliseconds even though the thing it is deciding about cannot be.
 *
 * ## The three tiers
 *
 * ```
 *   low     no post-processing at all. Tone mapping only, which is a
 *           per-material term rather than a screen pass.
 *   medium  + anti-aliasing and a restrained bloom.
 *   high    + ambient occlusion, sharper shadows, a wider colour treatment.
 * ```
 *
 * Tone mapping is deliberately in ALL of them. It is the single largest
 * difference between a render and a photograph, and it costs nothing per
 * pixel that the material was not already doing.
 */

export const QUALITY_TIERS = ['low', 'medium', 'high'] as const;
export type QualityTier = (typeof QUALITY_TIERS)[number];

/** What a tier actually switches on. */
export interface QualitySettings {
  /** Anti-aliasing. Jagged edges are the loudest "cheap" signal there is. */
  readonly antialias: boolean;
  /** Bloom on bright highlights. Restrained — this is sunlight, not a dream. */
  readonly bloom: boolean;
  /** Screen-space ambient occlusion. The most expensive thing here by far. */
  readonly ambientOcclusion: boolean;
  /** Shadow map resolution, in texels per side. */
  readonly shadowMapSize: number;
  /** Cap on the device pixel ratio the scene is rendered at. */
  readonly maxPixelRatio: number;
  /**
   * Normal-mapped surface detail: asphalt aggregate, carbon weave, tyre grain.
   *
   * One extra texture fetch and a matrix multiply per fragment, which is real
   * money at three times the pixel density. The albedo still carries the
   * pattern without it — the road is still made of stones, they are just lit
   * as though they were painted on.
   */
  readonly normalMaps: boolean;
  /**
   * A clear-coat lobe on car paint and lacquered carbon.
   *
   * The lacquer over the colour: a second, sharper specular layer that does
   * not take the paint's tint. It is what separates a car body from a coloured
   * shape, and it is a whole extra BRDF evaluation, so it is the first thing
   * a cheap phone gives up.
   */
  readonly clearCoat: boolean;
}

/**
 * Image-based lighting is NOT a tier.
 *
 * It used to be, and that was a bug waiting to happen: physically-based
 * materials are defined in terms of what they reflect, so a metal with no
 * environment is not a cheaper metal, it is a black shape. The generated sky
 * is six 64px faces — about 100KB, no network, no per-fragment cost beyond the
 * lookup the shader was already doing — so every tier gets it.
 */

const SETTINGS: Record<QualityTier, QualitySettings> = {
  low: {
    antialias: false,
    bloom: false,
    ambientOcclusion: false,
    shadowMapSize: 512,
    // 1.5 rather than 2. A phone at DPR 3 rendering at 2 is still 4x the
    // fragments of a 1x screen, and on a 6" panel the difference between 1.5
    // and 2 is invisible at arm's length while the cost is 78% more pixels.
    maxPixelRatio: 1.5,
    normalMaps: false,
    clearCoat: false,
  },
  medium: {
    antialias: true,
    bloom: true,
    ambientOcclusion: false,
    shadowMapSize: 1024,
    maxPixelRatio: 2,
    normalMaps: true,
    clearCoat: true,
  },
  high: {
    antialias: true,
    bloom: true,
    ambientOcclusion: true,
    shadowMapSize: 2048,
    maxPixelRatio: 2,
    normalMaps: true,
    clearCoat: true,
  },
};

/** What this tier switches on. */
export function qualitySettings(tier: QualityTier): QualitySettings {
  return SETTINGS[tier];
}

/** True when `tier` is a tier and not merely a string that got this far. */
export function isQualityTier(value: unknown): value is QualityTier {
  return typeof value === 'string' && (QUALITY_TIERS as readonly string[]).includes(value);
}

/** What the device is telling us about itself, as far as any of it is knowable. */
export interface DeviceHints {
  /** A touch screen. The honest proxy for "phone" — see the note below. */
  readonly coarsePointer: boolean;
  /** `navigator.hardwareConcurrency`, or 0 when it will not say. */
  readonly cores: number;
  /** Device pixel ratio. 3 on a modern phone, which is 9x the fragments. */
  readonly pixelRatio: number;
  /** The device has asked for less movement than the default. */
  readonly reducedMotion: boolean;
  /** There is no GPU: every fragment is being shaded on the CPU. */
  readonly softwareRenderer: boolean;
}

/**
 * Whether a WebGL renderer string names a software rasteriser.
 *
 * This is the one hardware question a browser answers honestly and usefully.
 * A software renderer is not a slow GPU, it is a different order of magnitude
 * — a post-processing chain that costs a millisecond on real silicon costs
 * hundreds here — and it is common enough to matter: CI containers, virtual
 * machines, remote desktops, and any browser where acceleration has been
 * turned off or blocklisted.
 *
 * Exported and pure because it is a string-matching heuristic, which is
 * exactly the kind of thing that quietly stops matching.
 */
export function isSoftwareRenderer(renderer: string): boolean {
  const name = renderer.toLowerCase();
  return (
    name.includes('swiftshader') ||
    name.includes('llvmpipe') ||
    name.includes('softpipe') ||
    name.includes('software') ||
    name.includes('basic render')
  );
}

/**
 * Reads what the platform will admit to. Safe to call anywhere.
 *
 * `renderer` is the WebGL renderer string, which only the caller holding the
 * engine can supply; omitting it simply means the software check never fires.
 */
export function readDeviceHints(renderer = ''): DeviceHints {
  const coarse = globalThis.matchMedia?.('(pointer: coarse)').matches ?? false;
  const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  return {
    coarsePointer: coarse,
    cores: typeof navigator === 'undefined' ? 0 : (navigator.hardwareConcurrency ?? 0),
    pixelRatio: typeof globalThis.devicePixelRatio === 'number' ? globalThis.devicePixelRatio : 1,
    reducedMotion: reduced,
    softwareRenderer: isSoftwareRenderer(renderer),
  };
}

/**
 * Which tier to open on.
 *
 * Deliberately pessimistic. A player who starts too low sees a game that runs
 * beautifully and can turn the handsome switches on; a player who starts too
 * high sees a stuttering mess and concludes the game is broken. The adaptive
 * step below can only ever go DOWN, for the same reason — quietly raising the
 * quality mid-race would be a stutter arriving from nowhere.
 *
 * There is no way to ask a browser what GPU it has that is both reliable and
 * not fingerprinting, so this is a proxy stack: a touch screen means a phone,
 * a phone with few cores means a cheap phone, and a high pixel ratio means
 * every fragment counts three times.
 */
export function startingTier(hints: DeviceHints): QualityTier {
  // No GPU at all beats every other signal, including a desktop-shaped one.
  // Without this, a machine with acceleration switched off opens on the most
  // expensive tier and then spends eight seconds discovering it cannot afford
  // it — which is eight seconds of a game that looks broken, and two rebuilds
  // to climb back out of.
  if (hints.softwareRenderer) return 'low';
  if (!hints.coarsePointer) return 'high';
  // A phone. The question is only which kind.
  const cheap = (hints.cores > 0 && hints.cores <= 4) || hints.pixelRatio >= 3;
  return cheap ? 'low' : 'medium';
}

/** One step down, or null when there is nowhere left to go. */
export function lowerTier(tier: QualityTier): QualityTier | null {
  const index = QUALITY_TIERS.indexOf(tier);
  return index > 0 ? (QUALITY_TIERS[index - 1] ?? null) : null;
}

/** Frame rate the renderer tries to stay above before giving up a tier. */
export const TARGET_FPS = 50;
/** Seconds of sustained shortfall before acting. */
export const PATIENCE_SECONDS = 4;

/**
 * Watches the frame rate and decides when a tier is not affordable.
 *
 * Sustained rather than instantaneous, and that is the whole design. Frame
 * rate on a browser dips for reasons that have nothing to do with the scene —
 * a texture upload, a garbage collection, another tab waking up, the very
 * first frames while shaders compile. Reacting to any single one of those
 * would drop the quality of a game that was running perfectly, and the player
 * would watch it happen.
 *
 * One way only. See `startingTier`.
 */
export class QualityGovernor {
  #tier: QualityTier;
  #short = 0;

  constructor(tier: QualityTier) {
    this.#tier = tier;
  }

  get tier(): QualityTier {
    return this.#tier;
  }

  /**
   * One frame. Returns the tier to drop to, or null to carry on.
   *
   * `fps` is whatever the engine last measured; `dt` is seconds since the
   * previous call.
   */
  update(fps: number, dt: number): QualityTier | null {
    // A tier the player chose by hand is theirs. Only the automatic starting
    // point is ours to take back, which `setTier` below records.
    if (fps >= TARGET_FPS || fps <= 0) {
      this.#short = 0;
      return null;
    }

    this.#short += dt;
    if (this.#short < PATIENCE_SECONDS) return null;

    const next = lowerTier(this.#tier);
    this.#short = 0;
    if (next === null) return null;
    this.#tier = next;
    return next;
  }

  /** Records a tier chosen elsewhere, and forgives whatever came before it. */
  setTier(tier: QualityTier): void {
    this.#tier = tier;
    this.#short = 0;
  }
}
