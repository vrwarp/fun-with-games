#!/usr/bin/env node
/**
 * Generates placeholder art procedurally.
 *
 * Why this exists: an agent can run `npm run assets:generate` and get real
 * glTF files with no network, no licence questions and no binary blobs to
 * review in a diff. The output is deterministic, so re-running it produces
 * byte-identical files and an unchanged git status.
 *
 * Everything here is a placeholder in the honest sense — the shapes are
 * readable at gameplay distance and nothing more. See `docs/ASSETS.md` for
 * how to replace them with real art.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { box, merge, toGltf } from './lib/gltf.mjs';
import { drawIcon } from './lib/png.mjs';
import {
  ROOT as root,
  loadManifest,
  replaceOrigin,
  saveAttribution,
  saveManifest,
} from './lib/manifest.mjs';

const outputDir = join(root, 'public', 'assets', 'generated');
const iconDir = join(root, 'public', 'icons');
const ORIGIN = 'generated';

/**
 * A blocky humanoid, 1.7 units tall and centred on the origin.
 *
 * Both properties matter to the renderer: the capsule it replaces spans
 * -0.85..+0.85 about the entity root, so a model built with its feet at y=0
 * would float half a body height above the floor. Forward is +Z, matching
 * `heading = atan2(vx, vz)` in the simulation.
 */
function runnerModel() {
  return merge([
    // Legs
    box({ center: [-0.15, -0.55, 0], size: [0.22, 0.6, 0.24] }),
    box({ center: [0.15, -0.55, 0], size: [0.22, 0.6, 0.24] }),
    // Torso
    box({ center: [0, 0.1, 0], size: [0.6, 0.7, 0.36] }),
    // Arms
    box({ center: [-0.39, 0.15, 0], size: [0.18, 0.6, 0.2] }),
    box({ center: [0.39, 0.15, 0], size: [0.18, 0.6, 0.2] }),
    // Head
    box({ center: [0, 0.65, 0], size: [0.42, 0.4, 0.4] }),
    // Visor on the +Z face: without it the model reads as symmetrical and you
    // cannot tell which way a player is facing.
    box({ center: [0, 0.68, 0.21], size: [0.3, 0.12, 0.04] }),
  ]);
}

/** A faceted crystal for pickups: two stacked pyramids, 0.8 units tall. */
function shardModel() {
  return merge([
    box({ center: [0, 0.12, 0], size: [0.3, 0.34, 0.3] }),
    box({ center: [0, 0.34, 0], size: [0.18, 0.22, 0.18] }),
    box({ center: [0, -0.14, 0], size: [0.18, 0.22, 0.18] }),
  ]);
}

/** A simple crate, useful as an obstacle or a prop. */
function crateModel() {
  return merge([
    box({ center: [0, 0, 0], size: [1, 1, 1] }),
    // Corner braces, so it does not read as an untextured cube.
    box({ center: [0, 0.5, 0], size: [1.06, 0.08, 1.06] }),
    box({ center: [0, -0.5, 0], size: [1.06, 0.08, 1.06] }),
  ]);
}

const MODELS = [
  {
    id: 'player',
    file: 'runner.gltf',
    build: runnerModel,
    baseColor: [0.72, 0.76, 0.86, 1],
    description: 'Blocky humanoid placeholder for player characters.',
  },
  {
    id: 'shard',
    file: 'shard.gltf',
    build: shardModel,
    baseColor: [0.96, 0.77, 0.09, 1],
    metallic: 0.35,
    roughness: 0.3,
    description: 'Faceted crystal placeholder for collectible pickups.',
  },
  {
    id: 'crate',
    file: 'crate.gltf',
    build: crateModel,
    baseColor: [0.55, 0.42, 0.28, 1],
    description: 'Braced crate placeholder for obstacles and props.',
  },
];

// ---------------------------------------------------------------------------
// App icons
// ---------------------------------------------------------------------------

const BACKGROUND = [10, 12, 18];
const ACCENT = [76, 201, 240];
const SHARD = [245, 197, 24];

/**
 * The installed-app icon: a shard on the game's background colour.
 *
 * `inset` shrinks the artwork for the maskable variant. Android crops maskable
 * icons to whatever shape the launcher uses, and only the inner ~80% is
 * guaranteed to survive, so the shard has to sit well inside that circle.
 */
function shardIcon(inset) {
  return (x, y) => {
    // Rounded-square background, so the icon still looks deliberate on
    // platforms that do not mask it.
    const corner = 0.72;
    const dx = Math.max(Math.abs(x) - corner, 0);
    const dy = Math.max(Math.abs(y) - corner, 0);
    if (Math.hypot(dx, dy) > 1 - corner) return [0, 0, 0, 0];

    const scale = 1 / inset;
    const sx = x * scale;
    const sy = y * scale;

    // Diamond: |x|/a + |y|/b <= 1.
    const diamond = Math.abs(sx) / 0.5 + Math.abs(sy) / 0.72;
    if (diamond <= 1) {
      // A soft vertical ramp from accent to shard colour gives it some depth
      // without needing a real gradient or lighting model.
      const t = (sy + 0.72) / 1.44;
      return [
        Math.round(ACCENT[0] + (SHARD[0] - ACCENT[0]) * t),
        Math.round(ACCENT[1] + (SHARD[1] - ACCENT[1]) * t),
        Math.round(ACCENT[2] + (SHARD[2] - ACCENT[2]) * t),
        255,
      ];
    }
    if (diamond <= 1.14) return [...ACCENT, 90]; // faint halo

    return [...BACKGROUND, 255];
  };
}

const ICONS = [
  { file: 'icon-192.png', size: 192, inset: 0.78 },
  { file: 'icon-512.png', size: 512, inset: 0.78 },
  // Maskable: extra margin so a circular or squircle crop keeps the shard.
  { file: 'icon-maskable-512.png', size: 512, inset: 0.58 },
];

async function generateIcons() {
  await mkdir(iconDir, { recursive: true });
  for (const icon of ICONS) {
    const png = drawIcon(icon.size, shardIcon(icon.inset));
    const path = join(iconDir, icon.file);
    await writeFile(path, png);
    console.log(`generated ${relative(root, path)} (${png.length} bytes)`);
  }
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  await generateIcons();

  const written = [];
  for (const model of MODELS) {
    const gltf = toGltf(model.build(), {
      name: model.id,
      baseColor: model.baseColor,
      ...(model.metallic !== undefined ? { metallic: model.metallic } : {}),
      ...(model.roughness !== undefined ? { roughness: model.roughness } : {}),
    });

    const path = join(outputDir, model.file);
    // Stable key order and a trailing newline keep re-runs diff-free.
    await writeFile(path, `${JSON.stringify(gltf, null, 2)}\n`, 'utf8');

    written.push({
      id: model.id,
      url: `assets/generated/${model.file}`,
      scale: 1,
      origin: ORIGIN,
      description: model.description,
      license: {
        name: 'CC0-1.0',
        source: 'Procedurally generated by scripts/generate-assets.mjs',
        author: 'fun-with-games contributors',
      },
    });
    console.log(`generated ${relative(root, path)}`);
  }

  const manifest = replaceOrigin(await loadManifest(), ORIGIN, written);
  await saveManifest(manifest);
  await saveAttribution(manifest);

  console.log(`\n${written.length} models written to ${relative(root, outputDir)}`);
  console.log('manifest.json and ATTRIBUTION.md updated');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
