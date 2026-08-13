#!/usr/bin/env node
/**
 * Validates the asset manifest. Runs in CI on every push and pull request.
 *
 * The point is licence hygiene as much as correctness: it is very easy for an
 * agent to drop a downloaded model into `public/` and move on, and very hard
 * to untangle six months later when nobody remembers where it came from. An
 * asset without recorded provenance fails the build here.
 *
 * Checks:
 *  - the manifest parses and has the expected shape
 *  - ids are unique, urls are repo-relative and stay inside `assets/`
 *  - every entry records a licence name and source
 *  - committed (`generated`) files exist and are within the size budget
 *  - downloaded (`vendor`) files may be absent — they are gitignored — but a
 *    present one must match its recorded checksum
 *  - ATTRIBUTION.md is regenerated and in sync
 */

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  ATTRIBUTION_PATH,
  MANIFEST_PATH,
  ROOT as root,
  renderAttribution,
} from './lib/manifest.mjs';

/** Anything bigger will noticeably hurt first load over a slow connection. */
const MAX_COMMITTED_BYTES = 4 * 1024 * 1024;

const errors = [];
const warnings = [];

function error(message) {
  errors.push(message);
}

function warn(message) {
  warnings.push(message);
}

async function readManifest() {
  try {
    return JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  } catch (cause) {
    if (cause.code === 'ENOENT') {
      // A missing manifest is legitimate: the game runs on procedural geometry.
      console.log('No manifest.json — the game will use procedural geometry only.');
      return null;
    }
    error(`manifest.json is not valid JSON: ${cause.message}`);
    return null;
  }
}

async function verifyEntry(model, index) {
  const label = model.id ? `"${model.id}"` : `entry #${index}`;

  if (typeof model.id !== 'string' || model.id.length === 0) {
    error(`${label}: missing "id"`);
  }
  if (typeof model.url !== 'string' || model.url.length === 0) {
    error(`${label}: missing "url"`);
    return;
  }
  if (model.url.startsWith('/') || model.url.includes('..')) {
    error(`${label}: "url" must be repo-relative and must not traverse upwards`);
    return;
  }
  if (!model.url.startsWith('assets/')) {
    error(`${label}: "url" must live under "assets/"`);
    return;
  }
  if (!model.license?.name || !model.license?.source) {
    error(
      `${label}: missing licence metadata. Record where this came from and ` +
        'under what terms, or remove it. See docs/ASSETS.md.',
    );
  }

  const path = join(root, 'public', model.url);
  let info;
  try {
    info = await stat(path);
  } catch {
    if (model.origin === 'vendor') {
      warn(
        `${label}: ${relative(root, path)} is absent. That is expected for ` +
          'downloaded assets — run `npm run assets:fetch` to restore it.',
      );
    } else {
      error(`${label}: ${relative(root, path)} does not exist`);
    }
    return;
  }

  if (model.origin !== 'vendor' && info.size > MAX_COMMITTED_BYTES) {
    error(
      `${label}: ${relative(root, path)} is ${info.size} bytes, over the ` +
        `${MAX_COMMITTED_BYTES}-byte budget for committed assets`,
    );
  }

  if (model.sha256) {
    const actual = createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
    if (actual !== model.sha256) {
      error(`${label}: checksum mismatch for ${relative(root, path)}`);
    }
  }
}

async function verifyAttribution(manifest) {
  const expected = renderAttribution(manifest);
  let actual;
  try {
    actual = await readFile(ATTRIBUTION_PATH, 'utf8');
  } catch {
    error('ATTRIBUTION.md is missing. Run `npm run assets:generate` to write it.');
    return;
  }
  if (actual !== expected) {
    error(
      'ATTRIBUTION.md is out of sync with manifest.json. ' +
        'Run `npm run assets:generate` (or `assets:fetch`) and commit the result.',
    );
  }
}

async function main() {
  const manifest = await readManifest();
  if (!manifest) {
    process.exitCode = errors.length > 0 ? 1 : 0;
    return;
  }

  if (!Array.isArray(manifest.models)) {
    error('manifest.json must have a "models" array');
  } else {
    const seen = new Set();
    for (const [index, model] of manifest.models.entries()) {
      if (seen.has(model.id)) error(`duplicate id "${model.id}"`);
      seen.add(model.id);
      await verifyEntry(model, index);
    }
    await verifyAttribution(manifest);
    console.log(`Checked ${manifest.models.length} asset(s).`);
  }

  for (const message of warnings) console.warn(`warning: ${message}`);

  if (errors.length > 0) {
    console.error(`\n${errors.length} problem(s):`);
    for (const message of errors) console.error(`  - ${message}`);
    process.exitCode = 1;
    return;
  }

  console.log('Asset manifest OK.');
}

main().catch((error_) => {
  console.error(error_);
  process.exitCode = 1;
});
