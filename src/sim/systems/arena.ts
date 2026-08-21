import type { Rng } from '../rng.js';
import type { SimConfig } from '../config.js';
import type { Obstacle } from '../types.js';

/**
 * Height of a seed-generated obstacle, from its footprint.
 *
 * Lives here rather than in the renderer because the simulation now cares:
 * with `platform.enabled` a player can jump onto a block, so its top surface
 * is gameplay, not decoration. The renderer reads `obstacle.top` instead of
 * recomputing, which is what keeps the picture and the physics honest.
 */
export function obstacleTop(halfX: number): number {
  return 1.6 + halfX * 0.4;
}

/**
 * Builds the static arena geometry from the seeded RNG.
 *
 * Called once per world, before any player exists, so every peer that opens
 * the same room derives byte-identical obstacles without exchanging them.
 * Obstacles are therefore NOT part of the snapshot.
 *
 * Zones (goals, hills, checkpoints, bases) and item homes (flags, crowns)
 * are kept clear: a random block squatting on a goal mouth or a flag stand
 * would make the mode unwinnable for that seed. The keepouts come from the
 * config, which every peer shares, so determinism is unaffected.
 *
 * `config.platforms` are appended verbatim afterwards. A hand-placed box is
 * an obstacle in every respect — it blocks, it supports, it renders — so a
 * platformer level is just a list of them.
 */
export function generateObstacles(config: SimConfig, rng: Rng): Obstacle[] {
  const obstacles: Obstacle[] = [];
  // Keep a clear ring around the origin so spawning players are never stuck.
  const spawnKeepout = 6;
  const maxAttemptsPerObstacle = 24;

  const keepouts: Array<{ x: number; z: number; radius: number }> = [
    ...config.zones.map((zone) => ({ x: zone.x, z: zone.z, radius: zone.radius + 1 })),
    ...config.items.map((item) => ({ x: item.homeX, z: item.homeZ, radius: 2.5 })),
  ];

  for (let id = 0; id < config.obstacleCount; id++) {
    for (let attempt = 0; attempt < maxAttemptsPerObstacle; attempt++) {
      const halfX = rng.range(config.obstacleMinHalfExtent, config.obstacleMaxHalfExtent);
      const halfZ = rng.range(config.obstacleMinHalfExtent, config.obstacleMaxHalfExtent);
      const x = rng.range(-config.arenaHalfExtentX + halfX, config.arenaHalfExtentX - halfX);
      const z = rng.range(-config.arenaHalfExtentZ + halfZ, config.arenaHalfExtentZ - halfZ);

      const candidate: Obstacle = { id, x, z, halfX, halfZ, baseY: 0, top: obstacleTop(halfX) };
      if (overlapsOrigin(candidate, spawnKeepout)) continue;
      if (keepouts.some((zone) => overlapsCircle(candidate, zone.x, zone.z, zone.radius))) {
        continue;
      }
      if (obstacles.some((existing) => overlaps(existing, candidate, 1.5))) continue;

      obstacles.push(candidate);
      break;
    }
  }

  config.platforms.forEach((spec, index) => {
    obstacles.push({
      id: config.obstacleCount + index,
      x: spec.x,
      z: spec.z,
      halfX: spec.halfX,
      halfZ: spec.halfZ,
      baseY: spec.baseY,
      top: spec.top,
    });
  });

  return obstacles;
}

function overlapsOrigin(o: Obstacle, keepout: number): boolean {
  return Math.abs(o.x) - o.halfX < keepout && Math.abs(o.z) - o.halfZ < keepout;
}

function overlaps(a: Obstacle, b: Obstacle, margin: number): boolean {
  return (
    Math.abs(a.x - b.x) < a.halfX + b.halfX + margin &&
    Math.abs(a.z - b.z) < a.halfZ + b.halfZ + margin
  );
}

function overlapsCircle(o: Obstacle, x: number, z: number, radius: number): boolean {
  const dx = Math.max(Math.abs(x - o.x) - o.halfX, 0);
  const dz = Math.max(Math.abs(z - o.z) - o.halfZ, 0);
  return dx * dx + dz * dz < radius * radius;
}

/** True when the circle's footprint overlaps the box's footprint. */
function overlapsFootprint(x: number, z: number, radius: number, o: Obstacle): boolean {
  const dx = Math.max(Math.abs(x - o.x) - o.halfX, 0);
  const dz = Math.max(Math.abs(z - o.z) - o.halfZ, 0);
  return dx * dx + dz * dz < radius * radius;
}

/**
 * True when a circle at `(x, z)` would intersect solid geometry at height `y`.
 *
 * Boxes that do not span `y` are ignored, which is what lets a player (or a
 * shot, or a bot's path probe) pass beneath a floating platform. In flat
 * modes every box spans y = 0, so this behaves exactly as a 2D test.
 */
export function isBlocked(
  x: number,
  z: number,
  radius: number,
  obstacles: readonly Obstacle[],
  y = 0,
): boolean {
  for (const o of obstacles) {
    if (y < o.baseY || y >= o.top) continue;
    if (overlapsFootprint(x, z, radius, o)) return true;
  }
  return false;
}

/**
 * Highest surface at or below `ceiling` that a circle at `(x, z)` could stand
 * on. The arena floor (0) is always a candidate, so this never returns
 * nothing — falling out of the world is not a failure mode here.
 */
export function supportHeight(
  x: number,
  z: number,
  radius: number,
  obstacles: readonly Obstacle[],
  ceiling: number,
): number {
  let best = 0;
  for (const o of obstacles) {
    if (o.top > ceiling || o.top <= best) continue;
    if (overlapsFootprint(x, z, radius, o)) best = o.top;
  }
  return best;
}

/**
 * Lowest box underside strictly above `floor` — the height a rising player
 * bumps their head on. `Infinity` when the sky is clear.
 */
export function ceilingAbove(
  x: number,
  z: number,
  radius: number,
  obstacles: readonly Obstacle[],
  floor: number,
): number {
  let best = Number.POSITIVE_INFINITY;
  for (const o of obstacles) {
    if (o.baseY <= floor || o.baseY >= best) continue;
    if (overlapsFootprint(x, z, radius, o)) best = o.baseY;
  }
  return best;
}

/**
 * Picks a free point inside the arena. Falls back to the origin after a bounded
 * number of tries — an unbounded loop here would hang the whole simulation if
 * an agent ever configures an arena that is mostly obstacle.
 *
 * Tested at ground level, so a spot underneath a floating platform counts as
 * free: a shard resting there is reachable, it just sits in shade.
 */
export function findFreePosition(
  config: SimConfig,
  rng: Rng,
  radius: number,
  obstacles: readonly Obstacle[],
  maxAttempts = 32,
): { x: number; z: number } {
  const marginX = config.arenaHalfExtentX - radius;
  const marginZ = config.arenaHalfExtentZ - radius;
  // A side-scroller is one lane deep; scattering across z would put pickups
  // where nobody can ever reach them.
  const lockZ = config.platform.enabled && config.platform.lockZ;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const x = rng.range(-marginX, marginX);
    const z = lockZ ? 0 : rng.range(-marginZ, marginZ);
    if (!isBlocked(x, z, radius, obstacles)) return { x, z };
  }
  return { x: 0, z: 0 };
}

/**
 * Deterministic spawn point for a player index — evenly spaced on a ring so
 * players never spawn inside one another. Side-scrollers get a line instead of
 * a ring, since they only have one usable axis.
 */
export function spawnPosition(config: SimConfig, index: number): { x: number; z: number } {
  if (config.platform.enabled && config.platform.lockZ) {
    const spacing = config.playerRadius * 3;
    const startX = -config.arenaHalfExtentX + 3;
    return { x: startX + (index % 8) * spacing, z: 0 };
  }

  const ringRadius = Math.min(config.arenaHalfExtentX, config.arenaHalfExtentZ) * 0.35;
  const angle = (index * Math.PI * 2) / 8;
  return { x: Math.cos(angle) * ringRadius, z: Math.sin(angle) * ringRadius };
}
