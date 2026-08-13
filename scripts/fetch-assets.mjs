#!/usr/bin/env node
/**
 * Downloads the third-party assets listed in `assets/sources.json`.
 *
 * Design notes worth knowing before you extend this:
 *
 *  - **Binaries are not committed.** `public/assets/vendor/` is gitignored.
 *    The catalogue is the source of truth; anyone can reproduce the files.
 *    This keeps clones small and keeps art out of code review.
 *  - **Licence metadata is mandatory.** An entry without it is refused here
 *    and again in `assets:verify`. Downloading art whose licence nobody
 *    recorded is how a project ends up unable to ship.
 *  - **Integrity is recorded, not assumed.** The SHA-256 of every download is
 *    written back into the manifest. Pin it in the catalogue (`sha256`) and a
 *    changed upstream file becomes a hard failure instead of a surprise.
 *
 * Not run in CI: it needs the network, and the game is designed to work
 * without any of it.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  ROOT as root,
  loadManifest,
  replaceOrigin,
  saveAttribution,
  saveManifest,
} from './lib/manifest.mjs';

const catalogPath = join(root, 'assets', 'sources.json');
const vendorDir = join(root, 'public', 'assets', 'vendor');
const ORIGIN = 'vendor';

/** Refuse anything implausibly large; a runaway download helps nobody. */
const MAX_BYTES = 16 * 1024 * 1024;

async function readCatalog() {
  try {
    const parsed = JSON.parse(await readFile(catalogPath, 'utf8'));
    return Array.isArray(parsed.assets) ? parsed.assets : [];
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.error(`No catalogue at ${relative(root, catalogPath)}; nothing to fetch.`);
      return [];
    }
    throw error;
  }
}

function validateEntry(entry) {
  const problems = [];
  if (!entry.id) problems.push('missing "id"');
  if (!entry.url) problems.push('missing "url"');
  if (!entry.file) problems.push('missing "file"');
  if (!entry.license?.name) problems.push('missing "license.name"');
  if (!entry.license?.source) problems.push('missing "license.source"');
  if (entry.url && !/^https:\/\//.test(entry.url)) problems.push('"url" must be https');
  if (entry.file && !/^[\w.-]+$/.test(entry.file)) {
    // A `file` containing a path separator could escape the vendor directory.
    problems.push('"file" must be a bare filename');
  }
  return problems;
}

async function download(entry) {
  const response = await fetch(entry.url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_BYTES) {
    throw new Error(`file is ${buffer.byteLength} bytes, over the ${MAX_BYTES}-byte limit`);
  }

  const sha256 = createHash('sha256').update(buffer).digest('hex');
  if (entry.sha256 && entry.sha256 !== sha256) {
    throw new Error(
      `checksum mismatch\n    expected ${entry.sha256}\n    actual   ${sha256}\n` +
        '    Upstream changed the file. Review it, then update "sha256" in assets/sources.json.',
    );
  }

  return { buffer, sha256 };
}

async function main() {
  const catalog = await readCatalog();
  const enabled = catalog.filter((entry) => entry.enabled !== false);

  if (catalog.length === 0) {
    console.log('Catalogue is empty. See docs/ASSETS.md for where to find CC0 art.');
    return;
  }
  if (enabled.length === 0) {
    console.log(
      `All ${catalog.length} catalogue entries are disabled. ` +
        'Set "enabled": true on the ones you want.',
    );
    return;
  }

  await mkdir(vendorDir, { recursive: true });

  const entries = [];
  const failures = [];

  for (const entry of enabled) {
    const problems = validateEntry(entry);
    if (problems.length > 0) {
      failures.push(`${entry.id ?? '(unnamed)'}: ${problems.join(', ')}`);
      continue;
    }

    try {
      const { buffer, sha256 } = await download(entry);
      const path = join(vendorDir, entry.file);
      await writeFile(path, buffer);

      entries.push({
        id: entry.id,
        url: `assets/vendor/${entry.file}`,
        scale: entry.scale ?? 1,
        origin: ORIGIN,
        sha256,
        ...(entry.description ? { description: entry.description } : {}),
        license: entry.license,
      });

      console.log(`fetched ${entry.id} -> ${relative(root, path)} (${buffer.byteLength} bytes)`);
      if (!entry.sha256) console.log(`  add "sha256": "${sha256}" to pin this file`);
    } catch (error) {
      failures.push(`${entry.id}: ${error.message}`);
    }
  }

  if (entries.length > 0) {
    const manifest = replaceOrigin(await loadManifest(), ORIGIN, entries);
    await saveManifest(manifest);
    await saveAttribution(manifest);
    console.log('\nmanifest.json and ATTRIBUTION.md updated');
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} asset(s) failed:`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
