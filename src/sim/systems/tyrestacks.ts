import { tickDeltaSeconds, type SimConfig } from '../config.js';
import type { StepContext } from '../step.js';
import { hasTrack, trackLength, trackPoseAt } from '../track.js';
import type { TyreStackState } from '../types.js';

/**
 * Tyre-wall stacks as bodies, not wallpaper.
 *
 * They began as trackside dressing — merged static meshes the renderer scatter
 * ed along the corners — which meant a car drove straight through them, and on
 * a software rasteriser they were not even there while still LOOKING like the
 * barrier. A stack of tyres either exists for every peer or for none, so the
 * stacks live here now: placed deterministically from the circuit, hit with
 * real momentum exchange, and carried in every snapshot like any other mutable
 * state. The render layer draws them wherever the simulation says they are and
 * adds the tumbling on top, derived from this state rather than stored.
 *
 * The physics is the ball's, with one difference that is the entire point: a
 * stack is much lighter than a car. Hitting one costs the car a thump of speed
 * and sends the stack flying, which is both what real tyre barriers are FOR
 * (soft, sacrificial) and what makes clipping one at the exit of a corner feel
 * like an event instead of a wall.
 */

/** Footprint radius of one stack, matching the rendered torus. */
export const TYRE_STACK_RADIUS = 0.8;

/**
 * Stack mass as a fraction of a car's. Three road tyres and a band is barely
 * a fifth of a car, so the car keeps most of its speed and the stack takes
 * most of the exchange — the asymmetry that makes the hit read as "burst
 * through" rather than "hit a bollard".
 */
const STACK_MASS = 0.18;

/** How much of the closing speed survives the contact. Rubber, not steel. */
const RESTITUTION = 0.3;

/** Per-second exponential decay: a loose stack grinds to a halt in a moment. */
const FRICTION = 2.4;

/** A knocked stack can never outrun the car that hit it. */
const MAX_SPEED = 26;

/** Below this it is parked; exact zero keeps checksums and the wire quiet. */
const SLEEP_SPEED = 0.02;

/**
 * Where the stacks stand: on the outside of every real corner, a little
 * inside the barrier line. These two must keep matching what the renderer
 * used when the stacks were scenery — the wall of red and white bundles is
 * part of how a circuit reads, and moving it would re-teach every corner.
 */
const STACK_INSET = 0.6;
const STACK_SPACING = 2.2;

/** Curvature gate: roughly ten degrees over the chord, or it is only a kink. */
const TURN_THRESHOLD = 0.18;
const TURN_CHORD = 4;

export interface TyreStackSpot {
  x: number;
  z: number;
  /** Yaw of the road at the spot, for the renderer's paint variation. */
  angle: number;
}

/**
 * Deterministic home positions for every stack on a circuit.
 *
 * Pure function of the config — no RNG, so construction order in `World`
 * cannot perturb the shared stream — and shared with the renderer, which
 * derives each stack's tumble from how far the simulation has pushed it off
 * this home.
 */
export function tyreStackSpots(config: SimConfig): TyreStackSpot[] {
  if (!hasTrack(config)) return [];
  const path = config.trackPath;
  const lap = trackLength(path);
  if (lap <= 0) return [];
  const offset = config.track.halfWidth + Math.max(config.track.barrierRunoff, 3) - STACK_INSET;

  const out: TyreStackSpot[] = [];
  const steps = Math.max(4, Math.floor(lap / STACK_SPACING));
  for (let i = 0; i < steps; i++) {
    const at = (lap * i) / steps;
    const behind = trackPoseAt(path, at - TURN_CHORD);
    const ahead = trackPoseAt(path, at + TURN_CHORD);
    // Signed turn over the chord: cross for the sine, dot for the cosine.
    const cross = behind.dirX * ahead.dirZ - behind.dirZ * ahead.dirX;
    const dot = behind.dirX * ahead.dirX + behind.dirZ * ahead.dirZ;
    const turn = Math.atan2(cross, dot);
    if (Math.abs(turn) < TURN_THRESHOLD) continue;

    const pose = trackPoseAt(path, at);
    // Right of the road is (dirZ, -dirX); a positive turn is a left-hander,
    // whose outside is the right — the only side a tyre wall belongs on.
    const side = turn > 0 ? 1 : -1;
    out.push({
      x: pose.x + pose.dirZ * side * offset,
      z: pose.z - pose.dirX * side * offset,
      angle: Math.atan2(pose.dirX, pose.dirZ),
    });
  }
  return out;
}

/** Initial state: every stack parked on its home spot. */
export function createTyreStacks(config: SimConfig): TyreStackState[] {
  return tyreStackSpots(config).map((spot) => ({ x: spot.x, z: spot.z, vx: 0, vz: 0 }));
}

/** Puts every stack back on its home spot; a new round gets a fresh wall. */
export function resetTyreStacks(ctx: StepContext): void {
  const spots = tyreStackSpots(ctx.config);
  ctx.tyreStacks.forEach((stack, index) => {
    const spot = spots[index];
    if (!spot) return;
    stack.x = spot.x;
    stack.z = spot.z;
    stack.vx = 0;
    stack.vz = 0;
  });
}

/**
 * One tick of stack physics: car contacts, then integration, then the pile
 * shoving itself apart. Fixed order, index order — determinism is the point.
 */
export function updateTyreStacks(ctx: StepContext): void {
  const stacks = ctx.tyreStacks;
  if (stacks.length === 0) return;
  const dt = tickDeltaSeconds(ctx.config);

  carContacts(ctx);

  // Integrate the loose ones. Parked stacks (the overwhelming majority) cost
  // one comparison each.
  const decay = Math.max(0, 1 - FRICTION * dt);
  for (const stack of stacks) {
    if (stack.vx === 0 && stack.vz === 0) continue;
    stack.vx *= decay;
    stack.vz *= decay;
    const speedSq = stack.vx * stack.vx + stack.vz * stack.vz;
    if (speedSq < SLEEP_SPEED * SLEEP_SPEED) {
      stack.vx = 0;
      stack.vz = 0;
      continue;
    }
    if (speedSq > MAX_SPEED * MAX_SPEED) {
      const scale = MAX_SPEED / Math.sqrt(speedSq);
      stack.vx *= scale;
      stack.vz *= scale;
    }
    stack.x += stack.vx * dt;
    stack.z += stack.vz * dt;
  }

  stackContacts(stacks);
}

/**
 * Car meets stack: separate by inverse mass, exchange momentum along the
 * normal. The car is `1` and the stack `STACK_MASS`, so the car sheds a
 * thump of speed while the stack takes the rest and flies.
 */
function carContacts(ctx: StepContext): void {
  const range = ctx.config.playerRadius + TYRE_STACK_RADIUS;
  const rangeSq = range * range;

  for (const player of ctx.players) {
    for (const stack of ctx.tyreStacks) {
      const dx = stack.x - player.x;
      const dz = stack.z - player.z;
      const distSq = dx * dx + dz * dz;
      if (distSq >= rangeSq || distSq < 1e-12) continue;

      const dist = Math.sqrt(distSq);
      const nx = dx / dist;
      const nz = dz / dist;
      const overlap = range - dist;

      // The light body gives way: the stack takes most of the separation.
      const carShare = STACK_MASS / (1 + STACK_MASS);
      player.x -= nx * overlap * carShare;
      player.z -= nz * overlap * carShare;
      stack.x += nx * overlap * (1 - carShare);
      stack.z += nz * overlap * (1 - carShare);

      const closing = (stack.vx - player.vx) * nx + (stack.vz - player.vz) * nz;
      if (closing >= 0) continue;

      // Impulse for unequal masses via the reduced mass; each side divides by
      // its own. j is per unit of the car's mass.
      const j = (-(1 + RESTITUTION) * closing * STACK_MASS) / (1 + STACK_MASS);
      player.vx -= j * nx;
      player.vz -= j * nz;
      stack.vx += (j / STACK_MASS) * nx;
      stack.vz += (j / STACK_MASS) * nz;
    }
  }
}

/**
 * Stacks shoving each other: what turns one hit into a scattering wall.
 * Neighbours rest just beyond touching, so at rest every pair rejects on the
 * first comparison and this is nearly free.
 */
function stackContacts(stacks: TyreStackState[]): void {
  const minDistance = TYRE_STACK_RADIUS * 2;
  const minDistanceSq = minDistance * minDistance;

  for (let i = 0; i < stacks.length; i++) {
    for (let j = i + 1; j < stacks.length; j++) {
      const a = stacks[i];
      const b = stacks[j];
      if (!a || !b) continue;

      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const distSq = dx * dx + dz * dz;
      if (distSq >= minDistanceSq || distSq < 1e-12) continue;

      const dist = Math.sqrt(distSq);
      const overlap = (minDistance - dist) * 0.5;
      const nx = dx / dist;
      const nz = dz / dist;

      a.x -= nx * overlap;
      a.z -= nz * overlap;
      b.x += nx * overlap;
      b.z += nz * overlap;

      const closing = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
      if (closing >= 0) continue;

      // Equal masses: half each, like the cars.
      const impulse = (-(1 + RESTITUTION) * closing) / 2;
      a.vx -= impulse * nx;
      a.vz -= impulse * nz;
      b.vx += impulse * nx;
      b.vz += impulse * nz;
    }
  }
}
