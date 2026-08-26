import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import type { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import type { AssetContainer } from '@babylonjs/core/assetContainer.js';
import type { Scene } from '@babylonjs/core/scene.js';
import { createLogger } from '../shared/logger.js';
import {
  EMPTY_MANIFEST,
  normalizeManifest,
  type AssetEntry,
  type AssetManifest,
} from '../shared/manifest.js';

const log = createLogger('render:assets');

/** Resolves a manifest-relative asset path against the site base. */
export function assetUrl(entry: AssetEntry, baseUrl: string): string {
  return entry.url.startsWith('http')
    ? entry.url
    : `${baseUrl.replace(/\/$/, '')}/${entry.url.replace(/^\//, '')}`;
}

/**
 * Swaps a material's procedural albedo (and normal map, if it has one) for
 * photographed textures, in place.
 *
 * The procedural surface stays on screen until the photos have actually
 * arrived, and stays for good if they never do — a 404 or a broken file logs
 * and leaves the material untouched, which is the same fail-soft bargain the
 * model loader makes. Tiling, wrap and anisotropy are copied from the
 * outgoing texture: the procedural surface already knows how many world
 * units one tile covers, and that fact belongs to the geometry, not to
 * whichever image happens to be on it.
 *
 * The normal map is only swapped where a procedural one exists: its absence
 * means this material was built for a tier that skips the second fetch and
 * the per-fragment cost, and a vendor file must not override that decision.
 */
export interface PhotoSurfaceOptions {
  /**
   * Explicit tiling, for a material whose procedural predecessor had no
   * texture to copy the world-units-per-tile fact from (a flat-colour trunk).
   */
  uScale?: number;
  vScale?: number;
  /**
   * Packed AO / roughness / metallic map in the glTF ORM channel layout.
   * When it arrives, the material's metallic and roughness scalars step
   * aside (become 1x factors): the photograph measured the surface the
   * procedural scalars were guessing at.
   */
  armUrl?: string;
  /**
   * Albedo tint to install once the photo lands. A procedural material often
   * carried its colour in `albedoColor` with no texture at all; left in
   * place it would multiply the photograph nearly to black.
   */
  albedoColor?: [number, number, number];
}

export function applyPhotoSurface(
  scene: Scene,
  material: PBRMaterial,
  diffuseUrl: string,
  normalUrl: string | null,
  options: PhotoSurfaceOptions = {},
): Texture[] {
  const outgoing = material.albedoTexture;
  const uScale =
    options.uScale ?? (outgoing && 'uScale' in outgoing ? (outgoing as Texture).uScale : 1);
  const vScale =
    options.vScale ?? (outgoing && 'vScale' in outgoing ? (outgoing as Texture).vScale : 1);
  const anisotropy = outgoing ? outgoing.anisotropicFilteringLevel : 4;
  const created: Texture[] = [];

  const swapIn = (
    url: string,
    slot: 'albedoTexture' | 'bumpTexture' | 'metallicTexture',
    onLoad?: () => void,
  ): void => {
    const texture: Texture = new Texture(
      url,
      scene,
      false,
      true,
      Texture.TRILINEAR_SAMPLINGMODE,
      () => {
        const old = material[slot];
        material[slot] = texture;
        old?.dispose();
        onLoad?.();
      },
      (message) => {
        log.info(`photo surface unavailable (${url}); keeping the procedural one`, message);
        texture.dispose();
      },
    );
    texture.wrapU = Texture.WRAP_ADDRESSMODE;
    texture.wrapV = Texture.WRAP_ADDRESSMODE;
    texture.uScale = uScale;
    texture.vScale = vScale;
    texture.anisotropicFilteringLevel = anisotropy;
    // Photographs are sRGB; the normal and ORM maps are data. Getting either
    // wrong shows up as a washed-out road or relief lit from the wrong side.
    texture.gammaSpace = slot === 'albedoTexture';
    created.push(texture);
  };

  swapIn(diffuseUrl, 'albedoTexture', () => {
    if (options.albedoColor) {
      material.albedoColor = new Color3(...options.albedoColor).toLinearSpace();
    }
  });
  if (normalUrl && material.bumpTexture) swapIn(normalUrl, 'bumpTexture');
  if (options.armUrl) {
    swapIn(options.armUrl, 'metallicTexture', () => {
      material.useAmbientOcclusionFromMetallicTextureRed = true;
      material.useRoughnessFromMetallicTextureGreen = true;
      material.useMetallnessFromMetallicTextureBlue = true;
      material.useRoughnessFromMetallicTextureAlpha = false;
      material.metallic = 1;
      material.roughness = 1;
    });
  }
  return created;
}

/**
 * The glTF loader is loaded on demand.
 *
 * It is a large dependency, and the starter ships no models — pulling it into
 * the main bundle would make every player download a parser for files that do
 * not exist. Importing it here, at the moment a manifest actually names a
 * model, keeps the default payload small without any special-casing in the
 * calling code.
 */
let gltfLoaderPromise: Promise<unknown> | null = null;

function ensureGltfLoader(): Promise<unknown> {
  gltfLoaderPromise ??= import('@babylonjs/loaders/glTF/2.0/index.js');
  return gltfLoaderPromise;
}

/**
 * Loads the asset manifest.
 *
 * A missing or malformed manifest is not an error: the game is designed to run
 * entirely on procedural geometry, and art is an enhancement layered on top.
 * That property is what keeps CI fast and keeps the repo free of binaries.
 */
export async function loadManifest(baseUrl: string): Promise<AssetManifest> {
  const url = `${baseUrl.replace(/\/$/, '')}/assets/manifest.json`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      log.info('no asset manifest at', url, '- using procedural geometry');
      return EMPTY_MANIFEST;
    }
    const parsed: unknown = await response.json();
    return normalizeManifest(parsed);
  } catch (error) {
    log.warn('failed to read asset manifest; using procedural geometry', error);
    return EMPTY_MANIFEST;
  }
}

/**
 * Loads a glTF/GLB into a detached container.
 *
 * Returns `null` instead of throwing when the file is missing or broken: the
 * caller falls back to procedural geometry, so a bad asset degrades the look
 * of the game rather than breaking it. Failures are logged loudly enough to
 * notice during development.
 */
export async function loadModel(
  scene: Scene,
  entry: AssetEntry,
  baseUrl: string,
): Promise<AssetContainer | null> {
  const url = entry.url.startsWith('http')
    ? entry.url
    : `${baseUrl.replace(/\/$/, '')}/${entry.url.replace(/^\//, '')}`;

  try {
    await ensureGltfLoader();
    const container = await LoadAssetContainerAsync(url, scene);
    log.info('loaded model', entry.id, 'from', url);
    return container;
  } catch (error) {
    log.warn(`failed to load model "${entry.id}" from ${url}; falling back to procedural`, error);
    return null;
  }
}
