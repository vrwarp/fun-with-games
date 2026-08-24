import { describe, expect, it } from 'vitest';
import { DAYLIGHT, skyColourAt } from '@/render/environment.js';

/**
 * The generated sky, as a gradient.
 *
 * Physically-based materials need something to be based on: metal is not a
 * colour, it is a mirror with a tint, and a mirror with nothing to reflect
 * renders as a flat black shape. This kit forbids shipping a captured HDR
 * panorama, so the environment is drawn in code — and being code, the shape of
 * it can be checked here rather than squinted at in a screenshot.
 */
const luminance = (y: number): number => {
  const c = skyColourAt(y);
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
};

describe('the sky gradient', () => {
  it('is brightest at the horizon, not overhead', () => {
    // The thing that makes a reflection look like it has a horizon in it. A
    // sky that simply got brighter upward would slide a bright band off the
    // top of every panel instead of wrapping round it as the car turns.
    expect(luminance(0)).toBeGreaterThan(luminance(1));
    expect(luminance(0)).toBeGreaterThan(luminance(-1));
  });

  it('darkens toward the ground faster than toward the zenith', () => {
    // The ground is close and the sky is not, so the falloff is asymmetric —
    // which is what stops a car's underside reflecting daylight.
    const down = luminance(0) - luminance(-0.3);
    const up = luminance(0) - luminance(0.3);
    expect(down).toBeGreaterThan(up);
  });

  it('is monotonic on each side of the horizon', () => {
    // A gradient with a kink in it shows up as a band sliding across
    // bodywork, which reads as a rendering artefact rather than a reflection.
    for (let y = 0.05; y <= 1; y += 0.05) {
      expect(luminance(y)).toBeLessThanOrEqual(luminance(y - 0.05) + 1e-9);
    }
    for (let y = -0.05; y >= -1; y -= 0.05) {
      expect(luminance(y)).toBeLessThanOrEqual(luminance(y + 0.05) + 1e-9);
    }
  });

  it('meets the named colours at the three anchors', () => {
    expect(skyColourAt(0).r).toBeCloseTo(DAYLIGHT.horizon.r, 5);
    expect(skyColourAt(1).b).toBeCloseTo(DAYLIGHT.zenith.b, 5);
    expect(skyColourAt(-1).g).toBeCloseTo(DAYLIGHT.ground.g, 5);
  });

  it('stays in range for anything a unit vector can hand it', () => {
    for (let y = -1; y <= 1; y += 0.02) {
      const colour = skyColourAt(y);
      for (const channel of [colour.r, colour.g, colour.b]) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    }
  });
});
