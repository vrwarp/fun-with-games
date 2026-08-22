import { describe, expect, it } from 'vitest';
import { makeSimConfig, type TrackPoint } from '@/sim/config.js';
import { GAME_MODE_IDS, modeConfig } from '@/sim/presets.js';
import {
  hasTrack,
  isOnTrack,
  sampleTrack,
  trackAhead,
  trackLength,
  trackPoseAt,
  trackProgress,
  smoothTrack,
} from '@/sim/track.js';
import { spawnHeading, spawnPosition } from '@/sim/systems/arena.js';

/** A 40 x 20 rectangle, driven anticlockwise from the middle of one long side. */
const RECTANGLE: readonly TrackPoint[] = [
  { x: 0, z: -10 },
  { x: 20, z: -10 },
  { x: 20, z: 10 },
  { x: -20, z: 10 },
  { x: -20, z: -10 },
];

const RECTANGLE_LAP = 20 + 20 + 40 + 20 + 20;

function trackConfig(overrides: { halfWidth?: number; gridColumns?: number } = {}) {
  return makeSimConfig({
    track: { enabled: true, halfWidth: overrides.halfWidth ?? 4, ...overrides },
    trackPath: RECTANGLE,
    arenaHalfExtentX: 30,
    arenaHalfExtentZ: 20,
    obstacleCount: 0,
    pickupCount: 0,
  });
}

describe('track geometry', () => {
  it('measures the closed centreline, including the wrap back to the start', () => {
    expect(trackLength(RECTANGLE)).toBeCloseTo(RECTANGLE_LAP, 6);
  });

  it('treats a path with fewer than two points as no track at all', () => {
    expect(trackLength([{ x: 1, z: 1 }])).toBe(0);
    expect(hasTrack(makeSimConfig({ track: { enabled: true }, trackPath: [] }))).toBe(false);
    // Enabled but empty must not claim everything is off-track, or a mode
    // misconfigured this way would be unplayable rather than merely plain.
    expect(isOnTrack(makeSimConfig({ track: { enabled: true } }), 999, 999)).toBe(true);
  });

  it('projects a point onto the nearest part of the road', () => {
    // Ten units up the first side, four units to the left of it.
    const sample = sampleTrack(RECTANGLE, 10, -14);
    expect(sample.lateral).toBeCloseTo(4, 6);
    expect(sample.progress).toBeCloseTo(10, 6);
    expect(sample.dirX).toBeCloseTo(1, 6);
    expect(sample.dirZ).toBeCloseTo(0, 6);
    expect(sample.length).toBeCloseTo(RECTANGLE_LAP, 6);
  });

  it('walks to a distance along the road, wrapping both ways', () => {
    expect(trackPoseAt(RECTANGLE, 0)).toMatchObject({ x: 0, z: -10 });
    expect(trackPoseAt(RECTANGLE, 20)).toMatchObject({ x: 20, z: -10 });

    // A negative distance is "this far back from the line" — which is exactly
    // how a starting grid is described, so it has to wrap, not clamp.
    const behind = trackPoseAt(RECTANGLE, -5);
    expect(behind.x).toBeCloseTo(-5, 6);
    expect(behind.z).toBeCloseTo(-10, 6);
    // A full lap on is the same place again.
    const wrapped = trackPoseAt(RECTANGLE, RECTANGLE_LAP + 20);
    expect(wrapped.x).toBeCloseTo(20, 6);
    expect(wrapped.z).toBeCloseTo(-10, 6);
  });

  it('calls the tarmac on-track and the run-off off it', () => {
    const config = trackConfig({ halfWidth: 4 });
    expect(isOnTrack(config, 10, -10)).toBe(true); // centre of the road
    expect(isOnTrack(config, 10, -13.9)).toBe(true); // just inside the edge
    expect(isOnTrack(config, 10, -14.1)).toBe(false); // just onto the grass
    expect(trackProgress(config, 10, -10)).toBeCloseTo(10 / RECTANGLE_LAP, 6);
  });

  it('survives a path with repeated points instead of dividing by zero', () => {
    // Zero-length segments are the classic authoring slip (a copy-pasted
    // point). They must contribute nothing rather than produce NaN, because a
    // NaN position desyncs every peer that touches it.
    const doubled: readonly TrackPoint[] = [
      { x: 0, z: -10 },
      { x: 0, z: -10 },
      { x: 20, z: -10 },
      { x: 20, z: 10 },
      { x: 20, z: 10 },
      { x: -20, z: 10 },
      { x: -20, z: -10 },
    ];

    expect(trackLength(doubled)).toBeCloseTo(RECTANGLE_LAP, 6);
    const sample = sampleTrack(doubled, 10, -14);
    expect(Number.isFinite(sample.lateral)).toBe(true);
    expect(sample.lateral).toBeCloseTo(4, 6);
    const pose = trackPoseAt(doubled, 25);
    expect(Number.isFinite(pose.x)).toBe(true);
    expect(pose.x).toBeCloseTo(20, 6);
  });

  it('falls back to the first point when a path has no length at all', () => {
    const stack: readonly TrackPoint[] = [
      { x: 3, z: 4 },
      { x: 3, z: 4 },
    ];
    expect(trackLength(stack)).toBe(0);
    expect(trackPoseAt(stack, 12)).toMatchObject({ x: 3, z: 4 });
    // Nothing to be off, so nothing is off.
    expect(sampleTrack(stack, 100, 100).lateral).toBe(0);
  });

  it('looks ahead along the road rather than straight on', () => {
    const config = trackConfig();
    // Sitting two units from the end of the first straight, looking ten ahead
    // must put the target eight units round the corner and up the next side —
    // which is the whole reason bots steer at the road rather than at a gate.
    const ahead = trackAhead(config, 18, -10, 10);
    expect(ahead).not.toBeNull();
    expect(ahead!.x).toBeCloseTo(20, 6);
    expect(ahead!.z).toBeCloseTo(-2, 6);
    expect(ahead!.dirZ).toBeCloseTo(1, 6);
    expect(trackAhead(makeSimConfig(), 0, 0, 5)).toBeNull();
  });
});

describe('starting grid', () => {
  it('lines cars up behind the line, staggered, facing down the road', () => {
    const config = trackConfig({ halfWidth: 4, gridColumns: 2 });
    const rowSpacing = config.track.gridRowSpacing;

    const pole = spawnPosition(config, 0);
    // Pole sits one row back from the line, offset to one side of it.
    expect(pole.x).toBeCloseTo(-rowSpacing, 6);
    expect(Math.abs(pole.z + 10)).toBeGreaterThan(0.5);
    expect(Math.abs(pole.z + 10)).toBeLessThan(config.track.halfWidth);

    // Second on the grid is on the other side AND half a row further back.
    const second = spawnPosition(config, 1);
    expect(second.x).toBeLessThan(pole.x);
    expect(Math.sign(second.z + 10)).toBe(-Math.sign(pole.z + 10));

    // Everyone faces +X, the direction of the main straight.
    expect(spawnHeading(config, 0)).toBeCloseTo(Math.PI / 2, 6);
    expect(spawnHeading(config, 5)).toBeCloseTo(Math.PI / 2, 6);
    // Off a circuit nothing changes: still the old ring, still facing +Z.
    expect(spawnHeading(makeSimConfig(), 0)).toBe(0);
  });

  it('never puts two cars on the same square', () => {
    const config = trackConfig();
    const slots = Array.from({ length: 8 }, (_, index) => spawnPosition(config, index));
    for (let i = 0; i < slots.length; i++) {
      for (let j = i + 1; j < slots.length; j++) {
        const a = slots[i]!;
        const b = slots[j]!;
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(config.playerRadius * 2);
      }
    }
  });
});

describe('smoothing a circuit', () => {
  it('rounds corners while leaving straights alone', () => {
    const square: readonly TrackPoint[] = [
      { x: 0, z: -10 },
      { x: 10, z: -10 },
      { x: 10, z: 10 },
      { x: -10, z: 10 },
      { x: -10, z: -10 },
    ];
    const smooth = smoothTrack(square, 2);

    expect(smooth.length).toBe(square.length * 4);
    // Corner-cutting only ever moves points inwards, so the lap gets shorter
    // and the shape never grows past what was authored.
    expect(trackLength(smooth)).toBeLessThan(trackLength(square));
    for (const point of smooth) {
      expect(Math.abs(point.x)).toBeLessThanOrEqual(10.001);
      expect(Math.abs(point.z)).toBeLessThanOrEqual(10.001);
    }
  });

  it('keeps the start/finish line where it was authored', () => {
    // Corner-cutting slides every point along the road, which would drag the
    // line — and the grid, and every lap time — down the straight with it.
    const path = smoothTrack(RECTANGLE, 2);
    const start = path[0]!;
    expect(Math.hypot(start.x - 0, start.z - -10)).toBeLessThan(1);
  });

  it('leaves paths it cannot round alone', () => {
    const pair: readonly TrackPoint[] = [
      { x: 0, z: 0 },
      { x: 1, z: 1 },
    ];
    expect(smoothTrack(pair, 2)).toEqual([...pair]);
    expect(smoothTrack(RECTANGLE, 0)).toEqual([...RECTANGLE]);
  });
});

/**
 * A corner cannot be tighter than the road is wide.
 *
 * Where it is, the inside edge of the tarmac crosses over itself: the
 * simulation leaves an unreachable pinch on the racing line, and the renderer
 * folds a wedge of kerb across it. Neither is recoverable at draw time, so it
 * has to be caught in the level, which is what this checks — the racing
 * equivalent of the platformer's jump-height guard.
 *
 * Measured on `config.trackPath`, the smoothed centreline both layers actually
 * use, rather than on the control points an author writes: rounding is exactly
 * what decides how tight the corner ends up.
 *
 * The local radius at a vertex is `min(segment) / 2 / tan(turn / 2)`, the
 * largest circle that fits inside the turn.
 */
describe('circuit corner radii', () => {
  const racingModes = GAME_MODE_IDS.filter((id) => modeConfig(id).track.enabled);

  it('covers every circuit that ships', () => {
    expect(racingModes.length).toBeGreaterThan(0);
  });

  for (const id of racingModes) {
    it(`${id}: no corner is tighter than its road is wide`, () => {
      const config = modeConfig(id);
      const path = config.trackPath;
      const half = config.track.halfWidth;

      path.forEach((point, index) => {
        const before = path[(index - 1 + path.length) % path.length]!;
        const after = path[(index + 1) % path.length]!;

        const inX = point.x - before.x;
        const inZ = point.z - before.z;
        const outX = after.x - point.x;
        const outZ = after.z - point.z;

        const shortest = Math.min(Math.hypot(inX, inZ), Math.hypot(outX, outZ));
        expect(shortest, `${id} vertex ${index} has a zero-length segment`).toBeGreaterThan(0);

        let turn = Math.atan2(outX, outZ) - Math.atan2(inX, inZ);
        while (turn > Math.PI) turn -= Math.PI * 2;
        while (turn < -Math.PI) turn += Math.PI * 2;
        turn = Math.abs(turn);
        if (turn < 1e-6) return;

        const radius = shortest / 2 / Math.tan(turn / 2);
        expect(radius, `${id} vertex ${index} (${point.x}, ${point.z})`).toBeGreaterThan(half);
      });
    });

    it(`${id}: the circuit fits inside its arena, run-off included`, () => {
      const config = modeConfig(id);
      const half = config.track.halfWidth;
      for (const point of config.trackPath) {
        expect(Math.abs(point.x) + half).toBeLessThan(config.arenaHalfExtentX);
        expect(Math.abs(point.z) + half).toBeLessThan(config.arenaHalfExtentZ);
      }
    });
  }
});
