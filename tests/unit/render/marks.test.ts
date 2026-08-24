import { describe, expect, it } from 'vitest';
import { marksGround, slipOf, type MarkSource } from '@/render/marks.js';

/**
 * What counts as "in trouble", checked without a GPU.
 *
 * A browser test can tell you something was drawn. It cannot tell you the
 * right car was drawn at the right moment, and that decision — when a tyre is
 * scrubbing hard enough to leave a mark — is the whole editorial content of
 * the feature. It is a pure function precisely so it can be pinned here.
 */
function car(overrides: Partial<MarkSource> = {}): MarkSource {
  return { id: 'a', x: 0, z: 0, heading: 0, vx: 0, vz: 20, onTrack: true, ...overrides };
}

describe('slipOf', () => {
  it('is zero for a car tracking its nose, either way along it', () => {
    expect(slipOf(car({ vz: 20 }))).toBeCloseTo(0, 6);
    expect(slipOf(car({ vz: -20 }))).toBeCloseTo(0, 6);
  });

  it('is signed toward the side the car is sliding', () => {
    expect(slipOf(car({ vx: 6, vz: 20 }))).toBeGreaterThan(0);
    expect(slipOf(car({ vx: -6, vz: 20 }))).toBeLessThan(0);
  });

  it('is zero for a parked car rather than an arbitrary angle', () => {
    expect(slipOf(car({ vx: 0, vz: 0 }))).toBe(0);
  });
});

describe('what leaves a mark', () => {
  it('says nothing for a car going straight and fast', () => {
    // The common case, and the one that matters for the frame budget: a whole
    // field on the racing line should be laying nothing at all.
    expect(marksGround(car({ vz: 26 }))).toBe(false);
  });

  it('marks a car that is properly sideways', () => {
    expect(marksGround(car({ vx: 12, vz: 20 }))).toBe(true);
  });

  it('ignores a car that is barely moving, however sideways it is', () => {
    // A stationary car being nudged has a large slip angle and is not
    // scrubbing anything. Without the speed floor a grid full of cars waiting
    // for the lights would quietly paint the start straight black.
    expect(marksGround(car({ vx: 1, vz: 0.2 }))).toBe(false);
  });

  it('kicks up off the road even when the car is dead straight', () => {
    // Dust is about the surface, not the slide: all four wheels on the grass
    // are throwing dirt whether or not the driver has lost it.
    expect(marksGround(car({ vz: 20, onTrack: false }))).toBe(true);
    expect(marksGround(car({ vz: 20, onTrack: true }))).toBe(false);
  });

  it('needs a real slide rather than a twitch', () => {
    // A car correcting mid-corner is not a car in trouble, and marking every
    // small correction would leave the circuit permanently black.
    expect(marksGround(car({ vx: 1.5, vz: 26 }))).toBe(false);
  });
});
