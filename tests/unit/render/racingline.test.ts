import { describe, expect, it } from 'vitest';
import { racingLineOffsets } from '@/render/trackview.js';
import { modeConfig } from '@/sim/presets.js';
import { trackLength } from '@/sim/track.js';

/**
 * Where the fast line runs.
 *
 * The strip of laid-in rubber is the first thing a driver reads off a circuit,
 * and it is generated rather than authored — so it can be subtly wrong in ways
 * that look plausible: a line on the OUTSIDE of every corner is still a smooth
 * dark line, and still completely backwards.
 */

/** A circle walked anticlockwise in (x, z). Its inside is its centre. */
function circle(radius: number, points = 96): { x: number; z: number }[] {
  return Array.from({ length: points }, (_, i) => {
    const t = (i / points) * Math.PI * 2;
    return { x: radius * Math.cos(t), z: radius * Math.sin(t) };
  });
}

function perimeter(path: readonly { x: number; z: number }[]): number {
  let total = 0;
  for (let i = 0; i < path.length; i++) {
    const a = path[i]!;
    const b = path[(i + 1) % path.length]!;
    total += Math.hypot(b.x - a.x, b.z - a.z);
  }
  return total;
}

describe('the racing line', () => {
  it('runs to the INSIDE of a corner', () => {
    // The claim that matters, and the one that is invisible once it is a dark
    // stripe on dark tarmac. On a circle "inside" is unambiguous: the offset
    // has to move the line toward the centre.
    //
    // The offset is measured along the road's right-hand normal, which on this
    // anticlockwise circle points outward — so an inside line is negative.
    // A twenty-metre radius is slow enough to be worth committing to fully,
    // so the line should sit at the limit it was given all the way round. A
    // faster corner deliberately does not — see the next test.
    const path = circle(20);
    const offsets = racingLineOffsets(path, perimeter(path), 120, 4);
    expect(offsets.length).toBe(120);
    for (const offset of offsets) {
      expect(offset).toBeLessThan(-3.9);
    }
  });

  it('commits less to a faster corner', () => {
    // Not a detail: a line pinned to the inside kerb through a flat-out kink
    // is not a racing line, it is a wall-follower. Commitment scales with how
    // hard the road is actually turning.
    const tight = circle(20);
    const fast = circle(60);
    const tightest = Math.max(...racingLineOffsets(tight, perimeter(tight), 120, 4).map(Math.abs));
    const gentlest = Math.max(...racingLineOffsets(fast, perimeter(fast), 120, 4).map(Math.abs));
    expect(gentlest).toBeLessThan(tightest * 0.7);
    expect(gentlest).toBeGreaterThan(0.2);
  });

  it('flips with the corner', () => {
    // The same circle walked the other way is a right-hander, and the line
    // must swap sides. A sign taken from anything but the turn direction
    // would pass the test above and fail this one.
    const path = circle(20).reverse();
    const offsets = racingLineOffsets(path, perimeter(path), 120, 4);
    for (const offset of offsets) {
      expect(offset).toBeGreaterThan(3.9);
    }
  });

  it('never asks for more than it was given', () => {
    const config = modeConfig('grandprix');
    const lap = trackLength(config.trackPath);
    const maxOffset = 3.5;
    for (const offset of racingLineOffsets(config.trackPath, lap, 180, maxOffset)) {
      expect(Math.abs(offset)).toBeLessThanOrEqual(maxOffset + 1e-9);
    }
  });

  it('is smooth, including across the start/finish line', () => {
    // Smoothing a lap as an open sequence leaves a kink exactly where every
    // player is looking. The step across the wrap has to be no worse than the
    // steps everywhere else.
    const config = modeConfig('grandprix');
    const lap = trackLength(config.trackPath);
    const offsets = racingLineOffsets(config.trackPath, lap, 180, 3.5);

    let worstInterior = 0;
    for (let i = 1; i < offsets.length; i++) {
      worstInterior = Math.max(worstInterior, Math.abs(offsets[i]! - offsets[i - 1]!));
    }
    const seam = Math.abs(offsets[0]! - offsets[offsets.length - 1]!);
    expect(seam).toBeLessThanOrEqual(worstInterior);
    // And smooth in absolute terms: a metre of lateral movement per 1.5m of
    // track would be a slalom, not a line.
    expect(worstInterior).toBeLessThan(0.4);
  });

  it('actually leaves the middle of the road on a real circuit', () => {
    // A line that never commits is a line nobody can see. Somewhere on the
    // lap it has to be most of the way to a kerb.
    const config = modeConfig('grandprix');
    const lap = trackLength(config.trackPath);
    const offsets = racingLineOffsets(config.trackPath, lap, 180, 3.5);
    expect(Math.max(...offsets.map(Math.abs))).toBeGreaterThan(2.2);
    // ...and it has to use both sides. This circuit runs predominantly one
    // way, as most do, so the counter-swing is the smaller of the two — but it
    // has to be there, or the line is a constant offset rather than a line.
    expect(Math.min(...offsets)).toBeLessThan(-1);
    expect(Math.max(...offsets)).toBeGreaterThan(0.5);
  });

  it('returns nothing it cannot compute', () => {
    expect(racingLineOffsets([], 100, 60, 3)).toEqual([]);
    expect(racingLineOffsets(circle(40), 0, 60, 3)).toEqual([]);
    expect(racingLineOffsets(circle(40), 100, 2, 3)).toEqual([]);
  });
});
