/**
 * Asset manifest shape, shared between the loader and the credits panel.
 *
 * This lives in `shared` rather than in `render` because two layers need it and
 * they cannot see each other: `render` fetches and loads the models, while `ui`
 * has to show their licences. Only types and pure functions belong here — the
 * fetching stays in `render/assets.ts`, so nothing in `sim` can transitively
 * acquire a dependency on the network.
 */

export interface AssetLicense {
  /** SPDX-ish identifier, e.g. `CC0-1.0` or `CC-BY-4.0`. */
  name: string;
  /** Where it came from: a URL, or a description for generated assets. */
  source: string;
  author?: string;
}

/**
 * Renderer-facing knobs an asset carries with it.
 *
 * Art direction that belongs to a PARTICULAR file — how far to spin an
 * equirect sky so its sun lands where the key light points — travels with
 * the file's catalogue entry rather than being hard-coded against an asset
 * that might be swapped.
 */
export interface AssetMeta {
  /** What the file is, when it is not a loadable model. */
  kind?: 'model' | 'texture' | 'environment';
  /** Yaw applied to an equirect environment, in radians. */
  rotationY?: number;
  /**
   * The environment's own horizon haze as sRGB [r, g, b], measured from the
   * image. Distance fog must fade toward THIS colour once the photo sky is
   * up, or everything far silhouettes against a horizon it no longer matches.
   */
  horizon?: [number, number, number];
  /**
   * The key light this environment was photographed under: linear-ish RGB
   * tint and lamp intensity for the scene's directional sun. A dusk photo
   * behind a noon-tuned lamp reads as two different times of day at once.
   */
  sun?: { color?: [number, number, number]; intensity?: number };
  /**
   * Scale on the energy imported for image-based lighting. Photographic
   * suns carry orders of magnitude more energy than the painted probe every
   * material was tuned against; this is the per-file exposure trim.
   */
  envLevel?: number;
}

/** One entry in `public/assets/manifest.json`. */
export interface AssetEntry {
  /** Logical name gameplay code refers to, e.g. `player`. */
  id: string;
  /** Path relative to the site base, e.g. `assets/vendor/robot.glb`. */
  url: string;
  /** Uniform scale applied after load, to normalise wildly-sized sources. */
  scale?: number;
  description?: string;
  meta?: AssetMeta;
  /** Where the file came from and under what terms. */
  license?: AssetLicense;
}

export interface AssetManifest {
  version: number;
  models: AssetEntry[];
}

export const EMPTY_MANIFEST: AssetManifest = { version: 1, models: [] };

/**
 * Licence strings that are a pure public-domain dedication and nothing else.
 *
 * Deliberately anchored to the *whole* string. Real-world metadata is often
 * compound — Khronos's Fox is "CC0-1.0 (model) / CC-BY-4.0 (rigging, animation,
 * glTF conversion)" — and a loose prefix match would read that as CC0 and
 * silently drop an attribution the licence actually requires.
 */
const PUBLIC_DOMAIN_ONLY = /^(cc0(-1\.0)?|public[ -]?domain|unlicense)$/i;

/**
 * Whether an asset's licence obliges us to credit it in the running game.
 *
 * Unknown provenance returns `true`: assuming the strictest interpretation is
 * the safe direction to be wrong in. (`npm run assets:verify` refuses to let an
 * asset ship without licence metadata in the first place.)
 */
export function requiresAttribution(license: AssetLicense | undefined): boolean {
  if (!license?.name) return true;
  return !PUBLIC_DOMAIN_ONLY.test(license.name.trim());
}

/**
 * Parses whatever `manifest.json` contained into a manifest we trust.
 *
 * Total by construction: anything unrecognised is skipped rather than throwing,
 * because the game is required to run with no art at all.
 */
export function normalizeManifest(raw: unknown): AssetManifest {
  if (typeof raw !== 'object' || raw === null) return EMPTY_MANIFEST;
  const models = (raw as { models?: unknown }).models;
  if (!Array.isArray(models)) return EMPTY_MANIFEST;

  const entries: AssetEntry[] = [];
  for (const item of models) {
    if (typeof item !== 'object' || item === null) continue;
    const { id, url, scale, description, meta, license } = item as Record<string, unknown>;
    if (typeof id !== 'string' || typeof url !== 'string') continue;

    const parsedLicense = normalizeLicense(license);
    const parsedMeta = normalizeMeta(meta);
    entries.push({
      id,
      url,
      ...(typeof scale === 'number' ? { scale } : {}),
      ...(typeof description === 'string' ? { description } : {}),
      ...(parsedMeta !== undefined ? { meta: parsedMeta } : {}),
      ...(parsedLicense !== undefined ? { license: parsedLicense } : {}),
    });
  }

  return { version: 1, models: entries };
}

function normalizeMeta(raw: unknown): AssetMeta | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { kind, rotationY, horizon, sun, envLevel } = raw as Record<string, unknown>;
  const parsedKind =
    kind === 'model' || kind === 'texture' || kind === 'environment' ? kind : undefined;
  const parsedRotation = finite(rotationY);
  const parsedHorizon = triple(horizon);
  const parsedSun = normalizeSun(sun);
  const parsedLevel = finite(envLevel);
  if (
    parsedKind === undefined &&
    parsedRotation === undefined &&
    parsedHorizon === undefined &&
    parsedSun === undefined &&
    parsedLevel === undefined
  ) {
    return undefined;
  }
  return {
    ...(parsedKind !== undefined ? { kind: parsedKind } : {}),
    ...(parsedRotation !== undefined ? { rotationY: parsedRotation } : {}),
    ...(parsedHorizon !== undefined ? { horizon: parsedHorizon } : {}),
    ...(parsedSun !== undefined ? { sun: parsedSun } : {}),
    ...(parsedLevel !== undefined ? { envLevel: parsedLevel } : {}),
  };
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function triple(value: unknown): [number, number, number] | undefined {
  return Array.isArray(value) &&
    value.length === 3 &&
    value.every((v) => typeof v === 'number' && Number.isFinite(v))
    ? ([value[0], value[1], value[2]] as [number, number, number])
    : undefined;
}

function normalizeSun(raw: unknown): AssetMeta['sun'] | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { color, intensity } = raw as Record<string, unknown>;
  const parsedColor = triple(color);
  const parsedIntensity = finite(intensity);
  if (parsedColor === undefined && parsedIntensity === undefined) return undefined;
  return {
    ...(parsedColor !== undefined ? { color: parsedColor } : {}),
    ...(parsedIntensity !== undefined ? { intensity: parsedIntensity } : {}),
  };
}

/**
 * The sky an environment-conscious mode should fly: `sky-<mode>` when the
 * catalogue carries one, the plain `sky` otherwise.
 *
 * Selection lives here, pure and unit-testable, rather than in the renderer:
 * which photograph a mode gets is catalogue policy, not a rendering concern.
 * Only entries that declare `meta.kind === 'environment'` qualify — an id
 * collision with some future texture must degrade to "no sky", never to a
 * JPEG fed to the cube-map decoder.
 */
export function findSkyEntry(manifest: AssetManifest, modeId: string): AssetEntry | undefined {
  const environment = (id: string) =>
    manifest.models.find((entry) => entry.id === id && entry.meta?.kind === 'environment');
  return environment(`sky-${modeId}`) ?? environment('sky');
}

function normalizeLicense(raw: unknown): AssetLicense | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { name, source, author } = raw as Record<string, unknown>;
  if (typeof name !== 'string' || typeof source !== 'string') return undefined;
  return {
    name,
    source,
    ...(typeof author === 'string' ? { author } : {}),
  };
}
