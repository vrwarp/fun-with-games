import { describe, expect, it } from 'vitest';
import { groundFootprint, viewSpec } from '@/render/views.js';

/**
 * How much ground a camera actually sees.
 *
 * This is the piece of trigonometry that was wrong for a year without anyone
 * noticing, because being wrong about it does not look like an error — it
 * looks like a camera that occasionally shows a bit more of the world than it
 * should, and pins itself off-centre near the edges for no visible reason.
 *
 * The old code used the ortho box's width and height as world X and Z. That is
 * exactly right for `topdown` and wrong for everything else, which is the
 * shape of the bug: correct in the view it was written for.
 */

/** Straight down, looking along a world axis: the one easy case. */
const STRAIGHT_DOWN = 0;

describe('the ground a view covers', () => {
  it('is the frustum itself when the camera looks straight down a world axis', () => {
    // alpha = -PI/2 puts screen-right on +X and screen-up on -Z. With no tilt
    // there is no stretch either, so the footprint IS the box. Any formula has
    // to agree here or it disagrees with the simplest possible case.
    const footprint = groundFootprint(-Math.PI / 2, STRAIGHT_DOWN, 40, 25);
    expect(footprint.x).toBeCloseTo(40, 6);
    expect(footprint.z).toBeCloseTo(25, 6);
  });

  it('swaps the axes when the camera turns a quarter turn', () => {
    const footprint = groundFootprint(0, STRAIGHT_DOWN, 40, 25);
    expect(footprint.x).toBeCloseTo(25, 6);
    expect(footprint.z).toBeCloseTo(40, 6);
  });

  it('splits both screen axes across both world axes on a diagonal', () => {
    // The first half of the old bug. At 45 degrees neither screen axis is a
    // world axis, and each world axis takes cos(45) of both.
    const footprint = groundFootprint(-Math.PI / 4, STRAIGHT_DOWN, 40, 26);
    const expected = Math.SQRT1_2 * (40 + 26);
    expect(footprint.x).toBeCloseTo(expected, 6);
    expect(footprint.z).toBeCloseTo(expected, 6);
  });

  it('sees further along the ground the more the camera is tilted', () => {
    // The second half. Screen height h covers h / cos(beta) of ground, so a
    // camera 60 degrees off vertical sees exactly twice its own height.
    const flat = groundFootprint(-Math.PI / 2, STRAIGHT_DOWN, 40, 25);
    const tilted = groundFootprint(-Math.PI / 2, Math.PI / 3, 40, 25);
    expect(tilted.z).toBeCloseTo(flat.z * 2, 6);
    // Tilting about the horizontal axis must not change the width.
    expect(tilted.x).toBeCloseTo(flat.x, 6);
  });

  it('never reports less ground than the frustum is wide', () => {
    // A footprint smaller than the box would mean the camera saw less world
    // than it drew, which is the failure that lets the view escape its clamp.
    for (let alpha = -Math.PI; alpha <= Math.PI; alpha += 0.13) {
      for (const beta of [0, 0.4, 0.9, 1.3]) {
        const footprint = groundFootprint(alpha, beta, 40, 25);
        expect(Math.hypot(footprint.x, footprint.z)).toBeGreaterThanOrEqual(25);
      }
    }
  });

  it('stays finite for a camera looking at the horizon', () => {
    // cos(beta) goes to zero as the camera levels out and the true reach goes
    // to infinity — correctly, but an infinity here would propagate into the
    // camera's position. `side` sits at beta = PI/2.05, close enough to matter.
    const level = groundFootprint(-Math.PI / 2, Math.PI / 2, 11, 7);
    expect(Number.isFinite(level.z)).toBe(true);
    expect(level.z).toBeGreaterThan(100);
  });

  it('shows why the isometric view escaped its old clamp', () => {
    // The regression this whole function exists for, in numbers. A desktop
    // frame at the grandprix framing: the old arithmetic claimed 40 x 25, and
    // the arena is only 42 deep — so a camera the clamp believed was safely
    // inside was in fact seeing a third of the way past the far wall.
    const iso = viewSpec('iso');
    const halfHeight = (iso.orthoHalfHeight ?? 0) * 1.7;
    const halfWidth = halfHeight * (1100 / 700);
    const footprint = groundFootprint(iso.alpha, iso.beta, halfWidth, halfHeight);

    expect(halfWidth).toBeCloseTo(40.1, 1);
    expect(halfHeight).toBeCloseTo(25.5, 1);
    expect(footprint.x).toBeGreaterThan(55);
    expect(footprint.z).toBeGreaterThan(55);
    // Bigger than the arena is deep, which is why no clamp could have hidden
    // the walls: the frustum overspills them from the dead centre.
    expect(footprint.z).toBeGreaterThan(42);
  });

  it('agrees with the frustum for topdown, which the old code was written for', () => {
    // Proof that the fix is a strict improvement rather than a different
    // guess: where the old arithmetic was right, the new one matches it.
    const spec = viewSpec('topdown');
    const halfHeight = (spec.orthoHalfHeight ?? 0) * 1.7;
    const halfWidth = halfHeight * (1100 / 700);
    const footprint = groundFootprint(spec.alpha, spec.beta, halfWidth, halfHeight);
    expect(footprint.x).toBeCloseTo(halfWidth, 5);
    // Near-vertical, so the stretch is under one percent.
    expect(footprint.z / halfHeight).toBeGreaterThan(1);
    expect(footprint.z / halfHeight).toBeLessThan(1.01);
  });
});
