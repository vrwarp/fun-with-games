import { describe, expect, it } from 'vitest';
import {
  clamp,
  clampMagnitude2,
  distance2,
  distanceSq2,
  length2,
  lerp,
  lerpAngle,
  normalize2,
  quantize,
} from '@/shared/math.js';

describe('clamp', () => {
  it('passes through values inside the range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it('clamps to both bounds', () => {
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});

describe('lerp', () => {
  it('interpolates linearly', () => {
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(0, 10, 0.5)).toBe(5);
    expect(lerp(0, 10, 1)).toBe(10);
  });
});

describe('lerpAngle', () => {
  it('takes the short way around the wrap point', () => {
    // From 350° to 10° should pass through 0°, not sweep backwards through 180°.
    const from = (350 * Math.PI) / 180;
    const to = (10 * Math.PI) / 180;
    const mid = lerpAngle(from, to, 0.5);
    const degrees = ((mid * 180) / Math.PI + 360) % 360;
    expect(degrees).toBeCloseTo(0, 5);
  });

  it('interpolates normally away from the wrap point', () => {
    expect(lerpAngle(0, 1, 0.5)).toBeCloseTo(0.5, 6);
  });
});

describe('normalize2', () => {
  it('produces a unit vector', () => {
    const result = normalize2(3, 4);
    expect(length2(result.x, result.y)).toBeCloseTo(1, 10);
  });

  it('returns zero for a zero vector rather than NaN', () => {
    // A zero input is the common case (no keys held); NaN here would poison
    // the player's position for the rest of the session.
    expect(normalize2(0, 0)).toEqual({ x: 0, y: 0 });
  });
});

describe('clampMagnitude2', () => {
  it('leaves short vectors untouched', () => {
    expect(clampMagnitude2(1, 0, 5)).toEqual({ x: 1, y: 0 });
  });

  it('caps length while preserving direction', () => {
    const result = clampMagnitude2(30, 40, 5);
    expect(length2(result.x, result.y)).toBeCloseTo(5, 10);
    expect(result.x / result.y).toBeCloseTo(30 / 40, 10);
  });

  it('handles a zero vector', () => {
    expect(clampMagnitude2(0, 0, 5)).toEqual({ x: 0, y: 0 });
  });
});

describe('distance helpers', () => {
  it('agree with each other', () => {
    expect(distance2(0, 0, 3, 4)).toBeCloseTo(5, 10);
    expect(distanceSq2(0, 0, 3, 4)).toBeCloseTo(25, 10);
  });
});

describe('quantize', () => {
  it('rounds to the requested precision', () => {
    expect(quantize(1.23456, 3)).toBe(1.235);
    expect(quantize(1.23456, 1)).toBe(1.2);
    expect(quantize(-1.23456, 2)).toBe(-1.23);
  });

  it('defaults to three decimals', () => {
    expect(quantize(0.123456)).toBe(0.123);
  });
});
