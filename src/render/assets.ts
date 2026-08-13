import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader.js';
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
