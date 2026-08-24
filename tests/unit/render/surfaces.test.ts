import { describe, expect, it } from 'vitest';
import {
  asphalt,
  carbonWeave,
  fbm,
  grass,
  normalMap,
  tyreRubber,
  valueNoise,
  type SurfacePattern,
} from '@/render/surfaces.js';

/**
 * The generated surface patterns.
 *
 * These are the only part of the renderer that CAN be tested here, and that is
 * exactly why they were written as pure arithmetic over typed arrays rather
 * than as canvas drawing: unit tests run in Node with no DOM, and the browser
 * suite has no way to assert on a texel. Everything below would otherwise have
 * to be checked by looking at it, which is how the tyre grain shipped with a
 * seam down every wheel — a bug two lines of arithmetic catch instantly and a
 * screenshot at speed never would.
 */

/** Every generator, so the shared invariants are asserted on all of them. */
const PATTERNS: ReadonlyArray<[string, (size: number) => SurfacePattern]> = [
  ['asphalt', asphalt],
  ['grass', grass],
  ['carbonWeave', carbonWeave],
  ['tyreRubber', tyreRubber],
];

const SIZE = 64;

/** Red channel of a texel. */
function red(pattern: SurfacePattern, x: number, y: number): number {
  return pattern.albedo[(y * SIZE + x) * 4] ?? -1;
}

/**
 * How discontinuous a pattern is across the wrap, against how discontinuous it
 * is anywhere else.
 *
 * A texture tiles when its right edge continues into its left. "Continues"
 * cannot mean "is identical" — neighbouring texels differ everywhere — so the
 * honest test is that the step ACROSS the seam is no bigger than a typical
 * step inside the texture. A pattern that does not wrap fails this loudly:
 * two unrelated parts of the noise field meet and the jump is an order of
 * magnitude larger than any interior step.
 */
function seamVersusInterior(pattern: SurfacePattern): { seam: number; interior: number } {
  let seam = 0;
  let interior = 0;
  for (let y = 0; y < SIZE; y++) {
    seam = Math.max(seam, Math.abs(red(pattern, SIZE - 1, y) - red(pattern, 0, y)));
    for (let x = 1; x < SIZE; x++) {
      interior = Math.max(interior, Math.abs(red(pattern, x - 1, y) - red(pattern, x, y)));
    }
  }
  return { seam, interior };
}

/** Mean of all three channels, 0..1. */
function brightness(pattern: SurfacePattern): number {
  let sum = 0;
  for (let i = 0; i < pattern.albedo.length; i += 4) {
    sum += (pattern.albedo[i] ?? 0) + (pattern.albedo[i + 1] ?? 0) + (pattern.albedo[i + 2] ?? 0);
  }
  return sum / (SIZE * SIZE * 3) / 255;
}

/** How much greener than red a pattern is, on average. 0 is neutral. */
function greenness(pattern: SurfacePattern): number {
  let sum = 0;
  for (let i = 0; i < pattern.albedo.length; i += 4) {
    sum += (pattern.albedo[i + 1] ?? 0) - (pattern.albedo[i] ?? 0);
  }
  return sum / (SIZE * SIZE) / 255;
}

describe('value noise', () => {
  it('repeats at its period on each axis independently', () => {
    for (let i = 0; i < 20; i++) {
      const x = i * 0.37;
      const y = i * 0.91;
      expect(valueNoise(x, y, 8, 128)).toBeCloseTo(valueNoise(x + 8, y, 8, 128), 10);
      expect(valueNoise(x, y, 8, 128)).toBeCloseTo(valueNoise(x, y + 128, 8, 128), 10);
    }
  });

  it('stays inside 0..1, which every pattern below assumes', () => {
    for (let i = 0; i < 200; i++) {
      const v = valueNoise(i * 0.13, i * 0.29, 16);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('is deterministic — the same coordinates always give the same value', () => {
    // Not a tautology: a texture that differed between two peers could not be
    // compared in a screenshot, and one that differed between two runs could
    // not be tested at all. `hash2` is the reason, and this is its guard.
    expect(valueNoise(3.25, 7.5, 16)).toBe(valueNoise(3.25, 7.5, 16));
    expect(fbm(3.25, 7.5, 16, 3)).toBe(fbm(3.25, 7.5, 16, 3));
  });

  it('is smooth: a small step in x is a small step in value', () => {
    let worst = 0;
    for (let i = 0; i < 500; i++) {
      const x = i * 0.02;
      worst = Math.max(worst, Math.abs(valueNoise(x, 1.5, 16) - valueNoise(x + 0.02, 1.5, 16)));
    }
    // A hash straight through would jump by up to 1 between adjacent samples.
    expect(worst).toBeLessThan(0.1);
  });
});

describe('fbm', () => {
  it('repeats at its period, so a pattern built on it tiles', () => {
    for (let i = 0; i < 20; i++) {
      const x = i * 0.41;
      const y = i * 0.17;
      expect(fbm(x, y, 12, 3)).toBeCloseTo(fbm(x + 12, y, 12, 3), 10);
      expect(fbm(x, y, 12, 3)).toBeCloseTo(fbm(x, y + 12, 12, 3), 10);
    }
  });

  it('stays inside 0..1 however many octaves are stacked', () => {
    for (let octaves = 1; octaves <= 5; octaves++) {
      for (let i = 0; i < 100; i++) {
        const v = fbm(i * 0.19, i * 0.07, 16, octaves);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('normal map', () => {
  it('points straight up off a flat surface', () => {
    const flat = new Float32Array(8 * 8).fill(0.5);
    const map = normalMap(flat, 8, 10);
    for (let i = 0; i < 8 * 8; i++) {
      // 128 is zero in a tangent-space normal map; 255 is +1 on Z.
      expect(map[i * 4]).toBe(128);
      expect(map[i * 4 + 1]).toBe(128);
      expect(map[i * 4 + 2]).toBe(255);
      expect(map[i * 4 + 3]).toBe(255);
    }
  });

  it('tilts against the slope of a ramp', () => {
    // Height rising with x. The surface normal of a height field is
    // (-dh/dx, -dh/dy, 1), so a rising ramp must tilt the normal toward -X,
    // which is BELOW 128 in the red channel. Getting this sign wrong is the
    // classic normal map bug: the light looks like it comes from the wrong
    // side, and it is nearly impossible to see by eye on a noisy texture.
    const size = 16;
    const ramp = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) ramp[y * size + x] = x / size;
    }
    const map = normalMap(ramp, size, 8);
    // Sampled away from the wrap, where the ramp resets and the slope flips.
    const at = (8 * size + 8) * 4;
    expect(map[at]).toBeLessThan(120);
    expect(map[at + 1]).toBe(128);
  });

  it('reads across the wrap rather than clamping at the edge', () => {
    // A height field that is flat except for one raised column at x = 0. The
    // texel at the far right edge is a NEIGHBOUR of that column once the
    // texture tiles, so it must see a slope. Clamping instead would leave the
    // right edge flat and put a visible ridge down every seam.
    const size = 8;
    const field = new Float32Array(size * size);
    for (let y = 0; y < size; y++) field[y * size] = 1;
    const map = normalMap(field, size, 8);
    const rightEdge = (3 * size + (size - 1)) * 4;
    expect(map[rightEdge]).not.toBe(128);
  });

  it('fills every channel of every texel', () => {
    const map = normalMap(new Float32Array(16 * 16), 16, 6);
    expect(map.length).toBe(16 * 16 * 4);
    for (let i = 0; i < map.length; i += 4) expect(map[i + 3]).toBe(255);
  });
});

describe('every surface pattern', () => {
  it.each(PATTERNS)('%s fills buffers of the right size', (_name, make) => {
    const pattern = make(SIZE);
    expect(pattern.albedo.length).toBe(SIZE * SIZE * 4);
    expect(pattern.height.length).toBe(SIZE * SIZE);
  });

  it.each(PATTERNS)('%s keeps its height field inside 0..1', (_name, make) => {
    const { height } = make(SIZE);
    for (const h of height) {
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(1);
    }
  });

  it.each(PATTERNS)('%s writes an opaque texel everywhere', (_name, make) => {
    const { albedo } = make(SIZE);
    for (let i = 0; i < albedo.length; i += 4) expect(albedo[i + 3]).toBe(255);
  });

  it.each(PATTERNS)('%s tiles: the seam is no worse than the interior', (_name, make) => {
    const { seam, interior } = seamVersusInterior(make(SIZE));
    expect(seam).toBeLessThanOrEqual(interior);
  });
});

describe('asphalt', () => {
  it('is dark, because tarmac is', () => {
    // Real asphalt reflects roughly a tenth of the light that lands on it.
    // This is not pedantry: the exposure, the fog and the zone overlays are
    // all balanced against it, and the first version of this texture was three
    // times too bright and turned the road into gravel.
    const { albedo } = asphalt(SIZE);
    let sum = 0;
    for (let i = 0; i < albedo.length; i += 4) sum += albedo[i] ?? 0;
    const mean = sum / (SIZE * SIZE) / 255;
    expect(mean).toBeGreaterThan(0.05);
    expect(mean).toBeLessThan(0.2);
  });

  it('is neutral, so the sky can colour it', () => {
    // A road with a colour of its own takes the sky's colour on top of it and
    // comes out tinted — which is how it once ended up teal.
    const { albedo } = asphalt(SIZE);
    for (let i = 0; i < albedo.length; i += 4) {
      const r = albedo[i] ?? 0;
      const g = albedo[i + 1] ?? 0;
      const b = albedo[i + 2] ?? 0;
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(3);
    }
  });

  it('has stones in it — the height field is not flat', () => {
    const { height } = asphalt(SIZE);
    const min = Math.min(...height);
    const max = Math.max(...height);
    expect(max - min).toBeGreaterThan(0.3);
  });
});

describe('grass', () => {
  it('is green-dominant', () => {
    const { albedo } = grass(SIZE);
    for (let i = 0; i < albedo.length; i += 4) {
      expect(albedo[i + 1] ?? 0).toBeGreaterThan(albedo[i] ?? 0);
      expect(albedo[i + 1] ?? 0).toBeGreaterThan(albedo[i + 2] ?? 0);
    }
  });

  it('reads clearly apart from the tarmac beside it', () => {
    // The contrast between the two is a driver's fastest read of where the
    // road is, so it is a gameplay property rather than a decorative one, and
    // it has to hold on BOTH axes. Hue alone is not enough — the road spent a
    // while tinted green by the environment probe, and a green road beside
    // green grass is a track limit you discover by losing grip. Brightness
    // alone is not enough either: the two were within a few percent of each
    // other and merged into one dark expanse from a chase camera.
    const road = asphalt(SIZE);
    const turf = grass(SIZE);
    expect(brightness(turf)).toBeGreaterThan(brightness(road) * 1.15);
    expect(greenness(turf)).toBeGreaterThan(0.05);
    expect(greenness(road)).toBeLessThan(0.01);
  });
});

describe('carbon weave', () => {
  it('is a twill and not a plain weave', () => {
    // What separates the two is the PERIOD along a row. A 2x2 twill floats
    // over two tows and under two, so shifting by four tows reproduces it and
    // shifting by two inverts it; a plain weave alternates every single tow,
    // so a two-tow shift would reproduce it. That difference is one modulo,
    // it is very easy to get wrong, and getting it wrong yields something
    // that looks like canvas rather than like carbon.
    //
    // The diagonal invariance below is the other half of the same fact: the
    // float pattern depends on `cu - cv`, so it is unchanged by stepping one
    // tow along both axes at once. That IS the diagonal rib a twill is
    // recognised by — it is the feature, not a defect.
    const size = 128;
    const tow = size / 16;
    const { height } = carbonWeave(size);
    const at = (x: number, y: number): number => height[(y % size) * size + (x % size)] ?? 0;

    const worstShift = (dx: number, dy: number): number => {
      let worst = 0;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          worst = Math.max(worst, Math.abs(at(x, y) - at(x + dx, y + dy)));
        }
      }
      return worst;
    };

    expect(worstShift(4 * tow, 0)).toBeLessThan(1e-6);
    expect(worstShift(tow, tow)).toBeLessThan(1e-6);
    expect(worstShift(2 * tow, 0)).toBeGreaterThan(0.2);
  });

  it('is nearly black, because carbon is', () => {
    const { albedo } = carbonWeave(SIZE);
    for (let i = 0; i < albedo.length; i += 4) expect(albedo[i] ?? 0).toBeLessThan(40);
  });
});

describe('tyre rubber', () => {
  it('runs its grain around the barrel rather than across it', () => {
    // U is the way round a Babylon cylinder. A scuff is long and thin, so the
    // pattern must vary far less along U than across it — the opposite would
    // draw tread blocks on a slick.
    const size = 64;
    const { height } = tyreRubber(size);
    const at = (x: number, y: number): number => height[y * size + x] ?? 0;
    let alongU = 0;
    let acrossV = 0;
    for (let y = 1; y < size; y++) {
      for (let x = 1; x < size; x++) {
        alongU = Math.max(alongU, Math.abs(at(x, y) - at(x - 1, y)));
        acrossV = Math.max(acrossV, Math.abs(at(x, y) - at(x, y - 1)));
      }
    }
    expect(acrossV).toBeGreaterThan(alongU * 3);
  });
});
