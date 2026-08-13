import type { Rng } from '../rng.js';
import type { SimConfig } from '../config.js';
import type { Obstacle } from '../types.js';

/**
 * Builds the static arena geometry from the seeded RNG.
 *
 * Called once per world, before any player exists, so every peer that opens
 * the same room derives byte-identical obstacles without exchanging them.
 * Obstacles are therefore NOT part of the snapshot.
 */
export function generateObstacles(config: SimConfig, rng: Rng): Obstacle[] {
  const obstacles: Obstacle[] = [];
  // Keep a clear ring around the origin so spawning players are never stuck.
  const spawnKeepout = 6;
  const maxAttemptsPerObstacle = 24;

  for (let id = 0; id < config.obstacleCount; id++) {
    for (let attempt = 0; attempt < maxAttemptsPerObstacle; attempt++) {
      const halfX = rng.range(config.obstacleMinHalfExtent, config.obstacleMaxHalfExtent);
      const halfZ = rng.range(config.obstacleMinHalfExtent, config.obstacleMaxHalfExtent);
      const x = rng.range(-config.arenaHalfExtentX + halfX, config.arenaHalfExtentX - halfX);
      const z = rng.range(-config.arenaHalfExtentZ + halfZ, config.arenaHalfExtentZ - halfZ);

      const candidate: Obstacle = { id, x, z, halfX, halfZ };
      if (overlapsOrigin(candidate, spawnKeepout)) continue;
      if (obstacles.some((existing) => overlaps(existing, candidate, 1.5))) continue;

      obstacles.push(candidate);
      break;
    }
  }

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

/** True when a circle at `(x, z)` would intersect any obstacle. */
export function isBlocked(
  x: number,
  z: number,
  radius: number,
  obstacles: readonly Obstacle[],
): boolean {
  for (const o of obstacles) {
    const dx = Math.max(Math.abs(x - o.x) - o.halfX, 0);
    const dz = Math.max(Math.abs(z - o.z) - o.halfZ, 0);
    if (dx * dx + dz * dz < radius * radius) return true;
  }
  return false;
}

/**
 * Picks a free point inside the arena. Falls back to the origin after a bounded
 * number of tries — an unbounded loop here would hang the whole simulation if
 * an agent ever configures an arena that is mostly obstacle.
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

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const x = rng.range(-marginX, marginX);
    const z = rng.range(-marginZ, marginZ);
    if (!isBlocked(x, z, radius, obstacles)) return { x, z };
  }
  return { x: 0, z: 0 };
}

/**
 * Deterministic spawn point for a player index — evenly spaced on a ring so
 * players never spawn inside one another.
 */
export function spawnPosition(config: SimConfig, index: number): { x: number; z: number } {
  const ringRadius = Math.min(config.arenaHalfExtentX, config.arenaHalfExtentZ) * 0.35;
  const angle = (index * Math.PI * 2) / 8;
  return { x: Math.cos(angle) * ringRadius, z: Math.sin(angle) * ringRadius };
}
