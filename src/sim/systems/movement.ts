import { clamp, clampMagnitude2, length2, normalize2 } from '../../shared/math.js';
import type { SimConfig } from '../config.js';
import type { Obstacle, PlayerInput, PlayerState } from '../types.js';
import { isImmobilized, movementScale } from './effects.js';

/** Below this speed a player is treated as stationary and stops turning. */
const HEADING_SPEED_EPSILON = 0.05;
/** Velocity components smaller than this are snapped to zero to avoid drift. */
const VELOCITY_EPSILON = 1e-4;
/** How fast speed above the current cap bleeds off, in world units/second². */
const OVERSPEED_DECEL = 24;

/**
 * Advances one player by one fixed step, in place.
 *
 * This function is the single source of truth for how a player moves, and it
 * is called from two very different places:
 *
 *  1. the host, stepping the authoritative world; and
 *  2. every client, replaying its own unacknowledged inputs during
 *     reconciliation (`ClientView` passes the tick and lock state it derived
 *     from the last authoritative snapshot).
 *
 * Those two must agree exactly or the local player will visibly snap on every
 * snapshot. Keep this function pure with respect to everything except
 * `player` — no clocks, no randomness, no reads of other players.
 *
 * `tick` is the tick being simulated (used to evaluate timed effects);
 * `movementLocked` is true during countdown / round-end freezes.
 */
export function integratePlayer(
  player: PlayerState,
  input: PlayerInput,
  config: SimConfig,
  obstacles: readonly Obstacle[],
  dt: number,
  tick = 0,
  movementLocked = false,
): void {
  const rawX = clamp(input.moveX, -1, 1);
  const rawZ = clamp(input.moveZ, -1, 1);
  // Analog magnitude: a half-pushed thumbstick moves at half speed. Keyboard
  // input always has magnitude 1 (diagonals clamp back down to 1).
  const magnitude = Math.min(1, length2(rawX, rawZ));
  const desired = normalize2(rawX, rawZ);
  const immobile = movementLocked || isImmobilized(player, tick);
  const hasInput = !immobile && magnitude > 0;
  const scale = movementScale(player, tick, config);
  const speedBefore = length2(player.vx, player.vz);

  if (hasInput) {
    const accel = config.playerAcceleration * scale * magnitude;
    player.vx += desired.x * accel * dt;
    player.vz += desired.y * accel * dt;
  } else {
    const decay = Math.max(0, 1 - config.playerFriction * dt);
    player.vx *= decay;
    player.vz *= decay;
    if (Math.abs(player.vx) < VELOCITY_EPSILON) player.vx = 0;
    if (Math.abs(player.vz) < VELOCITY_EPSILON) player.vz = 0;
  }

  const sprintMultiplier = input.sprint && !immobile ? config.playerSprintMultiplier : 1;
  // The cap scales with stick deflection so half-stick really is half speed.
  const inputCap = hasInput ? magnitude : 1;
  const maxSpeed = config.playerMaxSpeed * sprintMultiplier * scale * inputCap;
  // Speed already above the cap (knockback, a released sprint) bleeds off at a
  // fixed rate instead of being clamped away in one tick — a hard clamp here
  // would silently delete every impulse a gameplay system applies.
  const allowedSpeed = Math.max(maxSpeed, speedBefore - OVERSPEED_DECEL * dt);
  const capped = clampMagnitude2(player.vx, player.vz, allowedSpeed);
  player.vx = capped.x;
  player.vz = capped.y;

  player.x += player.vx * dt;
  player.z += player.vz * dt;

  resolveObstacles(player, config.playerRadius, obstacles);
  clampToArena(player, config);

  if (Math.abs(player.vx) + Math.abs(player.vz) > HEADING_SPEED_EPSILON) {
    player.heading = Math.atan2(player.vx, player.vz);
  }

  // Inputs can arrive out of order over an unreliable channel; never regress.
  if (input.seq > player.lastInputSeq) player.lastInputSeq = input.seq;
}

function clampToArena(player: PlayerState, config: SimConfig): void {
  const limitX = config.arenaHalfExtentX - config.playerRadius;
  const limitZ = config.arenaHalfExtentZ - config.playerRadius;

  if (player.x < -limitX) {
    player.x = -limitX;
    if (player.vx < 0) player.vx = 0;
  } else if (player.x > limitX) {
    player.x = limitX;
    if (player.vx > 0) player.vx = 0;
  }

  if (player.z < -limitZ) {
    player.z = -limitZ;
    if (player.vz < 0) player.vz = 0;
  } else if (player.z > limitZ) {
    player.z = limitZ;
    if (player.vz > 0) player.vz = 0;
  }
}

/**
 * Circle-vs-AABB push-out. Two passes, because resolving one obstacle can push
 * the player into a neighbouring one — common in the corner where two boxes
 * nearly touch.
 */
function resolveObstacles(
  player: PlayerState,
  radius: number,
  obstacles: readonly Obstacle[],
): void {
  for (let pass = 0; pass < 2; pass++) {
    let touched = false;
    for (const obstacle of obstacles) {
      if (resolveObstacle(player, radius, obstacle)) touched = true;
    }
    if (!touched) break;
  }
}

function resolveObstacle(player: PlayerState, radius: number, o: Obstacle): boolean {
  const minX = o.x - o.halfX;
  const maxX = o.x + o.halfX;
  const minZ = o.z - o.halfZ;
  const maxZ = o.z + o.halfZ;

  const nearestX = clamp(player.x, minX, maxX);
  const nearestZ = clamp(player.z, minZ, maxZ);

  const dx = player.x - nearestX;
  const dz = player.z - nearestZ;
  const distSq = dx * dx + dz * dz;

  if (distSq > radius * radius) return false;

  let nx: number;
  let nz: number;
  let penetration: number;

  if (distSq > 1e-12) {
    const dist = Math.sqrt(distSq);
    nx = dx / dist;
    nz = dz / dist;
    penetration = radius - dist;
  } else {
    // Centre is inside the box: escape along the shallowest axis.
    const toLeft = player.x - minX;
    const toRight = maxX - player.x;
    const toBack = player.z - minZ;
    const toFront = maxZ - player.z;
    const minPen = Math.min(toLeft, toRight, toBack, toFront);

    if (minPen === toLeft) {
      nx = -1;
      nz = 0;
      penetration = toLeft + radius;
    } else if (minPen === toRight) {
      nx = 1;
      nz = 0;
      penetration = toRight + radius;
    } else if (minPen === toBack) {
      nx = 0;
      nz = -1;
      penetration = toBack + radius;
    } else {
      nx = 0;
      nz = 1;
      penetration = toFront + radius;
    }
  }

  player.x += nx * penetration;
  player.z += nz * penetration;

  // Cancel only the velocity heading into the surface, so players slide along
  // walls instead of sticking to them.
  const intoSurface = player.vx * nx + player.vz * nz;
  if (intoSurface < 0) {
    player.vx -= intoSurface * nx;
    player.vz -= intoSurface * nz;
  }

  return true;
}

/**
 * Adds an instantaneous velocity impulse (knockback, dash, bounce pads).
 *
 * Speed above the movement cap decays at `OVERSPEED_DECEL` instead of being
 * clamped next tick, so impulses are actually felt.
 */
export function applyImpulse(player: PlayerState, ix: number, iz: number): void {
  player.vx += ix;
  player.vz += iz;
}

/**
 * Separates overlapping players.
 *
 * `players` MUST already be sorted by id: floating point addition is not
 * associative, so a different resolution order yields different positions and
 * the host/client replay would diverge.
 */
export function resolvePlayerCollisions(players: PlayerState[], config: SimConfig): void {
  const minDistance = config.playerRadius * 2;
  const minDistanceSq = minDistance * minDistance;

  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const a = players[i];
      const b = players[j];
      if (!a || !b) continue;

      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const distSq = dx * dx + dz * dz;
      if (distSq >= minDistanceSq) continue;

      if (distSq < 1e-12) {
        // Perfectly coincident: nudge apart deterministically by index rather
        // than randomly, so every peer produces the same result.
        a.x -= config.playerRadius * 0.5;
        b.x += config.playerRadius * 0.5;
        continue;
      }

      const dist = Math.sqrt(distSq);
      const overlap = (minDistance - dist) * 0.5;
      const nx = dx / dist;
      const nz = dz / dist;

      a.x -= nx * overlap;
      a.z -= nz * overlap;
      b.x += nx * overlap;
      b.z += nz * overlap;
    }
  }
}
