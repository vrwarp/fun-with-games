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

  const total = trackLength(points);
  if (total === 0) return ORIGIN_POSE;

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

  const first = points[0];
  return first ? { x: first.x, z: first.z, dirX: 0, dirZ: 1 } : ORIGIN_POSE;
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
