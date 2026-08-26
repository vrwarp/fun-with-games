import { describe, expect, it } from 'vitest';
import {
  EMPTY_MANIFEST,
  findSkyEntry,
  normalizeManifest,
  requiresAttribution,
} from '@/shared/manifest.js';

describe('normalizeManifest', () => {
  it('keeps well-formed entries', () => {
    const manifest = normalizeManifest({
      version: 1,
      models: [
        {
          id: 'player',
          url: 'assets/generated/runner.gltf',
          scale: 2,
          description: 'A runner',
          license: { name: 'CC0-1.0', source: 'generated', author: 'us' },
        },
      ],
    });

    expect(manifest.models).toEqual([
      {
        id: 'player',
        url: 'assets/generated/runner.gltf',
        scale: 2,
        description: 'A runner',
        license: { name: 'CC0-1.0', source: 'generated', author: 'us' },
      },
    ]);
  });

  it('preserves licence metadata', () => {
    // This was a real bug: the parser dropped `license` entirely, so licence
    // information never reached the running game and a credits panel could not
    // have shown anything even in principle.
    const manifest = normalizeManifest({
      models: [
        {
          id: 'fox',
          url: 'assets/vendor/fox.glb',
          license: { name: 'CC-BY-4.0', source: 'https://example.com' },
        },
      ],
    });

    expect(manifest.models[0]?.license).toEqual({
      name: 'CC-BY-4.0',
      source: 'https://example.com',
    });
  });

  it('omits an author that was not supplied', () => {
    const manifest = normalizeManifest({
      models: [{ id: 'a', url: 'assets/a.gltf', license: { name: 'CC0-1.0', source: 'x' } }],
    });
    expect(manifest.models[0]?.license).not.toHaveProperty('author');
  });

  it('drops entries without an id or url', () => {
    const manifest = normalizeManifest({
      models: [{ id: 'ok', url: 'assets/ok.gltf' }, { id: 'no-url' }, { url: 'assets/no-id.gltf' }],
    });
    expect(manifest.models.map((m) => m.id)).toEqual(['ok']);
  });

  it('drops a malformed licence rather than half-parsing it', () => {
    const manifest = normalizeManifest({
      models: [{ id: 'a', url: 'assets/a.gltf', license: { name: 'CC0-1.0' } }],
    });
    expect(manifest.models[0]?.license).toBeUndefined();
  });

  it.each([
    ['null', null],
    ['a string', 'nope'],
    ['an object with no models', {}],
    ['models that is not an array', { models: 'nope' }],
  ])('returns the empty manifest for %s', (_label, input) => {
    expect(normalizeManifest(input)).toEqual(EMPTY_MANIFEST);
  });
});

describe('normalizeManifest meta', () => {
  const entry = (meta: unknown) => ({
    id: 'sky',
    url: 'assets/vendor/sky.hdr',
    license: { name: 'CC0-1.0', source: 'x' },
    meta,
  });

  it('parses the full environment meta', () => {
    const manifest = normalizeManifest({
      models: [
        entry({
          kind: 'environment',
          rotationY: -1.5,
          horizon: [0.4, 0.5, 0.6],
          sun: { color: [1, 0.7, 0.5], intensity: 3.6 },
          envLevel: 0.5,
        }),
      ],
    });
    expect(manifest.models[0]?.meta).toEqual({
      kind: 'environment',
      rotationY: -1.5,
      horizon: [0.4, 0.5, 0.6],
      sun: { color: [1, 0.7, 0.5], intensity: 3.6 },
      envLevel: 0.5,
    });
  });

  it('keeps a sun with only one of its two knobs', () => {
    const manifest = normalizeManifest({
      models: [entry({ sun: { intensity: 4 } })],
    });
    expect(manifest.models[0]?.meta).toEqual({ sun: { intensity: 4 } });
  });

  it.each([
    ['a sun that is not an object', { sun: 'bright' }],
    ['a sun with malformed fields', { sun: { color: [1, 2], intensity: 'lots' } }],
    ['a non-finite envLevel', { envLevel: Number.NaN }],
    ['an unknown kind', { kind: 'shader' }],
  ])('drops %s rather than half-parsing it', (_label, meta) => {
    const manifest = normalizeManifest({ models: [entry(meta)] });
    expect(manifest.models[0]?.meta).toBeUndefined();
  });
});

describe('findSkyEntry', () => {
  const sky = (id: string, kind?: string) => ({
    id,
    url: `assets/vendor/${id}.hdr`,
    ...(kind !== undefined ? { meta: { kind } } : {}),
    license: { name: 'CC0-1.0', source: 'x' },
  });

  it('prefers the mode-specific sky over the generic one', () => {
    const manifest = normalizeManifest({
      models: [sky('sky', 'environment'), sky('sky-street', 'environment')],
    });
    expect(findSkyEntry(manifest, 'street')?.id).toBe('sky-street');
    expect(findSkyEntry(manifest, 'grandprix')?.id).toBe('sky');
  });

  it('ignores an id collision that is not an environment', () => {
    // A future texture named sky-street must degrade to the generic sky,
    // never to a JPEG fed to the cube-map decoder.
    const manifest = normalizeManifest({
      models: [sky('sky', 'environment'), sky('sky-street', 'texture')],
    });
    expect(findSkyEntry(manifest, 'street')?.id).toBe('sky');
  });

  it('finds nothing when no environment is catalogued', () => {
    const manifest = normalizeManifest({ models: [sky('sky')] });
    expect(findSkyEntry(manifest, 'street')).toBeUndefined();
  });
});

describe('requiresAttribution', () => {
  it.each(['CC0-1.0', 'CC0', 'cc0', 'Public Domain', 'public-domain', 'Unlicense'])(
    'is false for the pure public-domain dedication %s',
    (name) => {
      expect(requiresAttribution({ name, source: 'x' })).toBe(false);
    },
  );

  it.each(['CC-BY-4.0', 'CC BY-SA 4.0', 'MIT', 'Apache-2.0', 'SCEA Shared Source License'])(
    'is true for %s',
    (name) => {
      expect(requiresAttribution({ name, source: 'x' })).toBe(true);
    },
  );

  it('is true for a compound licence that merely starts with CC0', () => {
    // Khronos ships exactly this shape. A loose prefix match would read it as
    // public domain and silently drop an attribution the licence requires.
    expect(
      requiresAttribution({
        name: 'CC0-1.0 (model) / CC-BY-4.0 (rigging, animation, glTF conversion)',
        source: 'https://example.com',
      }),
    ).toBe(true);
  });

  it('assumes the strictest reading when the licence is missing', () => {
    expect(requiresAttribution(undefined)).toBe(true);
  });
});
