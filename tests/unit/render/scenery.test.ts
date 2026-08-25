import { describe, expect, it } from 'vitest';
import { boardRun, hashed, scatter, tyreWalls, type Placement } from '@/render/scenery.js';
import { sampleTrack, trackLength, trackPoseAt } from '@/sim/track.js';
import { modeConfig } from '@/sim/presets.js';

/**
 * Where the trackside furniture ends up.
 *
 * Placement is the half of the scenery that can be wrong in ways a screenshot
 * hides. A tree in the middle of the main straight is obvious; a tree just
 * inside the track limit at the far end of the circuit is not, and nor is a
 * tyre wall on the INSIDE of a corner — which reads as merely odd until you
 * realise the circuit has been telling every driver the wrong thing all race.
 */

/** A circle, walked anticlockwise in (x, z). Its inside is its centre. */
function circle(radius: number, points = 64): { x: number; z: number }[] {
  return Array.from({ length: points }, (_, i) => {
    const t = (i / points) * Math.PI * 2;
    return { x: radius * Math.cos(t), z: radius * Math.sin(t) };
  });
}

/** Perimeter of the sampled circle, which is what `trackPoseAt` walks. */
function perimeter(path: readonly { x: number; z: number }[]): number {
  let total = 0;
  for (let i = 0; i < path.length; i++) {
    const a = path[i]!;
    const b = path[(i + 1) % path.length]!;
    total += Math.hypot(b.x - a.x, b.z - a.z);
  }
  return total;
}

describe('the placement hash', () => {
  it('is deterministic', () => {
    expect(hashed(3, 7)).toBe(hashed(3, 7));
    expect(hashed(0, 0)).toBe(hashed(0, 0));
  });

  it('stays in 0..1', () => {
    for (let x = -50; x < 50; x++) {
      for (let y = -3; y < 3; y++) {
        const value = hashed(x, y);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(1);
      }
    }
  });

  it('does not collapse to a handful of values', () => {
    const seen = new Set<number>();
    for (let x = 0; x < 40; x++) for (let y = 0; y < 40; y++) seen.add(hashed(x, y));
    expect(seen.size).toBeGreaterThan(1500);
  });
});

describe('scattering trees', () => {
  const config = modeConfig('grandprix');
  const bounds = {
    halfExtentX: config.arenaHalfExtentX + 30,
    halfExtentZ: config.arenaHalfExtentZ + 30,
    trackPath: config.trackPath,
    clearance: 14,
  };

  it('never puts anything within the clearance of the road', () => {
    // The whole point. A circuit folds back on itself, so "far from where I
    // placed the last one" is not the same question as "far from the track".
    for (const tree of scatter(bounds, 5, 11)) {
      expect(sampleTrack(config.trackPath, tree.x, tree.z).lateral).toBeGreaterThanOrEqual(14);
    }
  });

  it('stays inside the bounds it was given', () => {
    for (const tree of scatter(bounds, 5, 11)) {
      expect(Math.abs(tree.x)).toBeLessThanOrEqual(bounds.halfExtentX);
      expect(Math.abs(tree.z)).toBeLessThanOrEqual(bounds.halfExtentZ);
    }
  });

  it('actually plants a wood', () => {
    // A clearance that rejects everything is a silent failure: the scene still
    // renders, it is just empty, and nobody notices until the screenshot.
    expect(scatter(bounds, 5, 11).length).toBeGreaterThan(200);
  });

  it('thins toward the edge instead of stopping on a line', () => {
    // A forest that ends dead on the scatter bounds draws the edge of the
    // world as a silhouette; the taper is what lets the fog explain it.
    const cell = 5;
    const trees = scatter(bounds, cell, 11);
    const edgeOf = (tree: Placement): number =>
      Math.min(bounds.halfExtentX - Math.abs(tree.x), bounds.halfExtentZ - Math.abs(tree.z));
    const rim = trees.filter((tree) => edgeOf(tree) < cell).length;
    const inner = trees.filter((tree) => edgeOf(tree) >= cell * 3 && edgeOf(tree) < cell * 4);
    // The rim band and the reference band cover a similar area; the rim must
    // be markedly thinner, not merely unlucky.
    expect(rim).toBeLessThan(inner.length * 0.5);
  });

  it('is the same wood every run, and a different one per salt', () => {
    const a = scatter(bounds, 5, 11);
    const b = scatter(bounds, 5, 11);
    const c = scatter(bounds, 5, 12);
    expect(a.map((p) => p.x)).toEqual(b.map((p) => p.x));
    expect(a.map((p) => p.x)).not.toEqual(c.map((p) => p.x));
  });

  it('varies size and tint across the wood', () => {
    const trees = scatter(bounds, 5, 11);
    const scales = trees.map((tree) => tree.scale);
    expect(Math.max(...scales) - Math.min(...scales)).toBeGreaterThan(0.5);
    // Every species must actually get planted, or some of the prototypes
    // are dead weight in the scene graph.
    const species = new Set(trees.map((tree) => Math.floor(tree.tint * 5)));
    expect(species).toEqual(new Set([0, 1, 2, 3, 4]));
  });
});

describe('tyre walls', () => {
  it('ignores anything that is not really a corner', () => {
    // A very large radius is the honest stand-in for a straight: a genuinely
    // straight list of points is not a lap, and `trackPoseAt` closes it into
    // one, which puts a hairpin at each end. At 120 metres of radius the road
    // turns about five degrees over the sampling chord, which is a kink — and
    // lining kinks with tyres is what makes the real corners stop meaning
    // anything.
    const gentle = circle(120, 160);
    expect(tyreWalls(gentle, perimeter(gentle), 10, 6)).toEqual([]);
  });

  it('lines the OUTSIDE of a corner', () => {
    // The load-bearing claim, and the easy one to get backwards. On a circle
    // the outside is simply "further from the centre than the road is", so a
    // wall placed on the inside fails by a wide, obvious margin rather than by
    // a sign nobody can eyeball.
    const radius = 40;
    const path = circle(radius);
    const walls = tyreWalls(path, perimeter(path), 8, 6);
    expect(walls.length).toBeGreaterThan(4);
    for (const wall of walls) {
      expect(Math.hypot(wall.x, wall.z)).toBeGreaterThan(radius + 6);
    }
  });

  it('spaces them by distance travelled, not by control point', () => {
    const path = circle(40);
    const lap = perimeter(path);
    const close: Placement[] = tyreWalls(path, lap, 8, 3);
    const sparse: Placement[] = tyreWalls(path, lap, 8, 12);
    expect(close.length).toBeGreaterThan(sparse.length * 3);
  });
});

describe('advertising boards', () => {
  it('never lets a board corner cross the barrier line', () => {
    // The regression this pins: a flat 5.6m hoarding placed on a stretch the
    // straightness test accepted, whose CORNERS still crossed the curved
    // rail in front of it. Both ends of every board must stay clearly
    // outside the wall.
    const config = modeConfig('grandprix');
    const path = config.trackPath;
    const lap = trackLength(path);
    const half = config.track.halfWidth;
    const wall = half + config.track.barrierRunoff;
    const offset = half + Math.max(config.track.barrierRunoff, 3) + 1;

    for (const side of [1, -1] as const) {
      for (const board of boardRun(path, lap, offset * side, 7, side)) {
        // A hoarding's width runs parallel to the road, so its corners sit
        // along the track tangent at its centre — derived from the path
        // itself rather than from the yaw convention, which this test once
        // guessed wrong. 2.9 covers the half-width plus a corner's grace.
        const progress = sampleTrack(path, board.x, board.z).progress;
        const pose = trackPoseAt(path, progress);
        for (const end of [-1, 1]) {
          const x = board.x + end * 2.9 * pose.dirX;
          const z = board.z + end * 2.9 * pose.dirZ;
          expect(sampleTrack(path, x, z).lateral).toBeGreaterThan(wall + 0.25);
        }
      }
    }
  });

  it('still finds somewhere to advertise', () => {
    // A clearance rule strict enough to reject every placement would pass
    // the test above while silently emptying the circuit.
    const config = modeConfig('grandprix');
    const lap = trackLength(config.trackPath);
    const offset = config.track.halfWidth + Math.max(config.track.barrierRunoff, 3) + 1;
    expect(boardRun(config.trackPath, lap, offset, 7, 1).length).toBeGreaterThan(3);
  });
});
