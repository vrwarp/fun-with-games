import type { SimConfig, TrackPoint } from './config.js';

/**
 * Closed-circuit geometry.
 *
 * A track is a **centreline** — a closed polyline of `TrackPoint`s — plus a
 * half-width. Everything else a racing game needs is derived from it: whether
 * a car is on the tarmac, how far around the lap it is, which way the road
 * goes next, where the starting grid sits. Nothing here is state, so nothing
 * here is snapshotted, transmitted or checksummed; every peer (and the
 * renderer, which may read `SimConfig`) recomputes identical answers from the
 * same config.
 *
 * The functions walk the polyline in a single pass and accumulate distances as
 * they go, deliberately without a precomputed table. A circuit is a couple of
 * dozen points, the walk is a few hundred float operations, and a cache would
 * be module-level state in `src/sim` — the one thing this layer must not have.
 *
 * Distances ("progress") are measured along the centreline from `points[0]`,
 * which is therefore the start/finish line by construction.
 */

/** Nearest point on the centreline to a query position. */
export interface TrackSample {
  /** Distance from the query point to the centreline, in world units. */
  readonly lateral: number;
  /** Distance travelled along the centreline to reach that point. */
  readonly progress: number;
  /** Unit direction the road runs at that point. */
  readonly dirX: number;
  readonly dirZ: number;
  /** Total centreline length, so callers can wrap without a second pass. */
  readonly length: number;
}

/** A point on the centreline, with the road's direction there. */
export interface TrackPose {
  readonly x: number;
  readonly z: number;
  readonly dirX: number;
  readonly dirZ: number;
}

const ORIGIN_POSE: TrackPose = Object.freeze({ x: 0, z: 0, dirX: 0, dirZ: 1 });

const EMPTY_SAMPLE: TrackSample = Object.freeze({
  lateral: 0,
  progress: 0,
  dirX: 0,
  dirZ: 1,
  length: 0,
});

/**
 * Rounds a hand-authored circuit into the centreline the game actually uses.
 *
 * Corner-cutting (Chaikin): each pass replaces every point with two, a quarter
 * and three quarters of the way along each edge. Corners become arcs, straights
 * stay straight, and the result converges on a quadratic B-spline through the
 * authored points — so the list in `presets.ts` reads as **control points**,
 * not as the road's own vertices.
 *
 * This matters to both layers, which is why it happens here rather than in the
 * renderer. A raw polyline corner is a single vertex where the road's direction
 * changes all at once: the simulation leaves an unreachable pinch on the inside
 * of it, and anything offset from it by half the road width — the tarmac's own
 * edge — folds back across itself. Rounding the line once, before either layer
 * sees it, fixes both and keeps them describing the same road.
 *
 * The result is rotated back to the authored first point, and that point is
 * restored exactly, because point 0 is the start/finish line: the grid, the
 * gates and every lap time are measured from it, and corner-cutting would
 * otherwise slide it down the road. Pinning one point on a straight costs
 * nothing — which is the reason to draw the line on a straight.
 */
export function smoothTrack(points: readonly TrackPoint[], passes = 2): TrackPoint[] {
  if (points.length < 3 || passes <= 0) return [...points];

  let current: TrackPoint[] = [...points];
  for (let pass = 0; pass < passes; pass++) {
    const next: TrackPoint[] = [];
    for (let i = 0; i < current.length; i++) {
      const a = current[i];
      const b = current[(i + 1) % current.length];
      if (!a || !b) continue;
      next.push({ x: a.x + (b.x - a.x) * 0.25, z: a.z + (b.z - a.z) * 0.25 });
      next.push({ x: a.x + (b.x - a.x) * 0.75, z: a.z + (b.z - a.z) * 0.75 });
    }
    current = next;
  }

  const origin = points[0];
  if (!origin) return current;

  let startIndex = 0;
  let closest = Number.POSITIVE_INFINITY;
  current.forEach((point, index) => {
    const distance = Math.hypot(point.x - origin.x, point.z - origin.z);
    if (distance < closest) {
      closest = distance;
      startIndex = index;
    }
  });

  const rotated = [...current.slice(startIndex), ...current.slice(0, startIndex)];
  rotated[0] = { x: origin.x, z: origin.z };
  return rotated;
}

/** Total length of the closed centreline, in world units. */
export function trackLength(points: readonly TrackPoint[]): number {
  if (points.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (!a || !b) continue;
    total += Math.hypot(b.x - a.x, b.z - a.z);
  }
  return total;
}

/**
 * Projects `(x, z)` onto the centreline and reports where it landed.
 *
 * Ties are broken by the earlier segment, which matters where a circuit
 * doubles back on itself: two segments can be equidistant and a peer that
 * picked the other one would disagree about lap progress. Comparing with `<`
 * (not `<=`) makes the choice order-dependent, and the order is the config's.
 */
export function sampleTrack(points: readonly TrackPoint[], x: number, z: number): TrackSample {
  if (points.length < 2) return EMPTY_SAMPLE;

  let bestLateralSq = Number.POSITIVE_INFINITY;
  let bestProgress = 0;
  let bestDirX = 0;
  let bestDirZ = 1;
  let travelled = 0;

  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (!a || !b) continue;

    const segX = b.x - a.x;
    const segZ = b.z - a.z;
    const segLengthSq = segX * segX + segZ * segZ;
    const segLength = Math.sqrt(segLengthSq);
    if (segLength === 0) continue;

    // Clamped projection: t is where along [a, b] the query point falls.
    const t =
      segLengthSq > 0
        ? Math.min(1, Math.max(0, ((x - a.x) * segX + (z - a.z) * segZ) / segLengthSq))
        : 0;
    const nearX = a.x + segX * t;
    const nearZ = a.z + segZ * t;
    const lateralSq = (x - nearX) * (x - nearX) + (z - nearZ) * (z - nearZ);

    if (lateralSq < bestLateralSq) {
      bestLateralSq = lateralSq;
      bestProgress = travelled + segLength * t;
      bestDirX = segX / segLength;
      bestDirZ = segZ / segLength;
    }

    travelled += segLength;
  }

  // Every segment was zero-length (a path of repeated points). Reporting an
  // infinite lateral distance would make `isOnTrack` false everywhere, so a
  // typo in a circuit would turn the whole arena into a gravel trap; reporting
  // nothing makes it behave like a mode with no track at all.
  if (!Number.isFinite(bestLateralSq)) return EMPTY_SAMPLE;

  return {
    lateral: Math.sqrt(bestLateralSq),
    progress: bestProgress,
    dirX: bestDirX,
    dirZ: bestDirZ,
    length: travelled,
  };
}

/**
 * The point `distance` along the centreline from the start/finish line, with
 * the direction the road runs there. Wraps in both directions, so a negative
 * distance is "this far back from the line" — which is exactly how a starting
 * grid is described.
 */
export function trackPoseAt(points: readonly TrackPoint[], distance: number): TrackPose {
  if (points.length < 2) return ORIGIN_POSE;

  const first = points[0];
  if (!first) return ORIGIN_POSE;

  // A path with no length is a single place, so that place is the answer.
  // Falling back to the origin instead would put a starting grid at (0, 0),
  // which on most circuits is the middle of the infield.
  const total = trackLength(points);
  if (total === 0) return { x: first.x, z: first.z, dirX: 0, dirZ: 1 };

  // `%` keeps the sign of the dividend in JS; the extra term makes it a real
  // modulo so that -5 on a 100-unit lap is 95, not -5.
  let remaining = ((distance % total) + total) % total;

  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (!a || !b) continue;

    const segX = b.x - a.x;
    const segZ = b.z - a.z;
    const segLength = Math.hypot(segX, segZ);
    if (segLength === 0) continue;

    if (remaining <= segLength) {
      const t = remaining / segLength;
      return {
        x: a.x + segX * t,
        z: a.z + segZ * t,
        dirX: segX / segLength,
        dirZ: segZ / segLength,
      };
    }
    remaining -= segLength;
  }

  // Only reachable through float drift at exactly the wrap point.
  return { x: first.x, z: first.z, dirX: 0, dirZ: 1 };
}

/** True when the config describes a usable circuit. */
export function hasTrack(config: SimConfig): boolean {
  return config.track.enabled && config.trackPath.length >= 2;
}

/**
 * Is this position on the tarmac?
 *
 * Off-track is not a wall — it is grass: `track.offTrackSpeed` and
 * `track.offTrackGrip` make it slow and slippery, and the driver has to get
 * back on. A hard barrier would be unforgiving on a thumbstick, and a car
 * pinned against an invisible wall is worse than one wallowing in the run-off.
 */
export function isOnTrack(config: SimConfig, x: number, z: number): boolean {
  if (!hasTrack(config)) return true;
  return sampleTrack(config.trackPath, x, z).lateral <= config.track.halfWidth;
}

/**
 * How far around the lap a car is, as a fraction in `[0, 1)`.
 *
 * Combined with `player.lap` this totally orders a field of cars, which is
 * what race positions, the slipstream and DRS all need.
 */
export function trackProgress(config: SimConfig, x: number, z: number): number {
  if (!hasTrack(config)) return 0;
  const sample = sampleTrack(config.trackPath, x, z);
  return sample.length > 0 ? sample.progress / sample.length : 0;
}

/**
 * A point on the racing line `lookahead` units in front of `(x, z)`.
 *
 * This is what a bot aims at. Steering at the next checkpoint's centre makes a
 * car cut every corner and spend the lap in the gravel; steering at the road
 * a fixed distance ahead makes it follow the road.
 */
export function trackAhead(
  config: SimConfig,
  x: number,
  z: number,
  lookahead: number,
): TrackPose | null {
  if (!hasTrack(config)) return null;
  const sample = sampleTrack(config.trackPath, x, z);
  return trackPoseAt(config.trackPath, sample.progress + lookahead);
}
