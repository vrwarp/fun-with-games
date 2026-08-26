import { tickDeltaSeconds, type SimConfig } from '../config.js';
import type { StepContext } from '../step.js';
import { hasTrack, trackLength, trackPoseAt } from '../track.js';
import type { TyreStackSpot, TyreState } from '../types.js';

export type { TyreStackSpot } from '../types.js';

/**
 * The tyre walls as bodies — one body per TYRE, not per stack.
 *
 * They began as trackside dressing a car drove straight through, then became
 * one rigid disc per three-tyre stack — which collided honestly but toppled
 * as a single welded unit, and a wall that falls over in whole stacks reads
 * as furniture. So the simulation now carries every tyre: three discs per
 * spot, coincident while the stack stands, burst apart by a hit. The burst is
 * shaped per tier — the top tyre takes the biggest, widest kick and the
 * bottom one drags — so one impact scatters a stack the way being batted off
 * the top actually scatters one, and every loose tyre then shoves whatever
 * it lands against.
 *
 * Coincident discs would normally explode a collision solver; the pair pass
 * below skips exactly-coincident pairs, which is also what lets a standing
 * stack cost nothing. The moment a hit differentiates their velocities they
 * separate, and from then on they are ordinary bodies.
 *
 * All of it is deterministic and index-ordered, snapshotted and checksummed
 * like any other mutable state; the renderer derives each tyre's pose (still
 * stacked, sliding flat, or rolling away on its tread) purely from this
 * state, so peers agree on the wreckage without an orientation on the wire.
 */

/** Tyres in one standing stack. The renderer stacks them by index. */
export const TYRES_PER_STACK = 3;

/** Footprint radius of one tyre, matching the rendered torus. */
export const TYRE_RADIUS = 0.8;

/**
 * One tyre's mass as a fraction of a car's. Three of them add up to the old
 * stack's fifth-of-a-car, so a full-face hit still costs the car the same
 * thump while each individual tyre flies harder.
 */
const TYRE_MASS = 0.06;

/** How much of the closing speed survives a contact. Rubber, not steel. */
const RESTITUTION = 0.3;

/** Per-second exponential decay: a loose tyre grinds to a halt in a moment. */
const FRICTION = 2.4;

/** A knocked tyre can never outrun the car that hit it. */
const MAX_SPEED = 26;

/** Below this it is parked; exact zero keeps checksums and the wire quiet. */
const SLEEP_SPEED = 0.02;

/**
 * How the burst is shaped, by tier (bottom, middle, top). The kick scales
 * the impulse; the spread fans its direction in radians. Identical kicks
 * would send all three tyres flying in formation — still one unit, just
 * airborne — and the fan is what makes a hit read as a stack coming apart.
 */
const TIER_KICK = [0.8, 1, 1.25] as const;
const TIER_SPREAD = [-0.35, 0, 0.35] as const;

/**
 * Where the stacks stand: on the outside of every real corner, a little
 * inside the barrier line. These two must keep matching what the renderer
 * draws — the wall of red and white bundles is part of how a circuit reads.
 */
const STACK_INSET = 0.6;
const STACK_SPACING = 2.2;

/** Curvature gate: roughly ten degrees over the chord, or it is only a kink. */
const TURN_THRESHOLD = 0.18;
const TURN_CHORD = 4;

/**
 * Deterministic home positions for every STACK on a circuit (each spawns
 * `TYRES_PER_STACK` tyres). Pure function of the config — no RNG, so
 * construction order in `World` cannot perturb the shared stream — and
 * shared with the renderer, which derives each tyre's pose from how far the
 * simulation has pushed it off this home.
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

/**
 * Initial state: every tyre parked on its stack's spot, stack-major order —
 * tyre `i` belongs to stack `floor(i / TYRES_PER_STACK)`, at tier
 * `i % TYRES_PER_STACK`. The three share a position; height is presentation.
 */
export function createTyres(config: SimConfig): TyreState[] {
  const out: TyreState[] = [];
  for (const spot of tyreStackSpots(config)) {
    for (let tier = 0; tier < TYRES_PER_STACK; tier++) {
      out.push({ x: spot.x, z: spot.z, vx: 0, vz: 0 });
    }
  }
  return out;
}

/** Puts every tyre back on its stack's spot; a new round gets a fresh wall. */
export function resetTyres(ctx: StepContext): void {
  ctx.tyres.forEach((tyre, index) => {
    const spot = ctx.tyreSpots[Math.floor(index / TYRES_PER_STACK)];
    if (!spot) return;
    tyre.x = spot.x;
    tyre.z = spot.z;
    tyre.vx = 0;
    tyre.vz = 0;
  });
}

/**
 * One tick of tyre physics: car contacts, then integration, then the loose
 * pile shoving itself apart. Fixed order, index order — determinism is the
 * point.
 */
export function updateTyres(ctx: StepContext): void {
  const tyres = ctx.tyres;
  if (tyres.length === 0) return;

  // The do-nothing gate, and the most load-bearing lines in the file. For
  // every tick of a clean race — which is nearly all of them — no tyre is
  // loose and no car is anywhere near a wall (the closest spot sits further
  // off the tarmac than a car's contact range reaches), so the whole system
  // is two flat scans with no allocations and no maths beyond compares.
  // Tests fast-forward entire grands prix through here under coverage
  // instrumentation; anything heavier than this on the calm path shows up
  // as minutes.
  if (!anyTyreLoose(ctx) && !anyPlayerNearWall(ctx)) return;

  const dt = tickDeltaSeconds(ctx.config);

  carContacts(ctx);

  // Integrate the loose ones. Parked tyres (the overwhelming majority) cost
  // one comparison each.
  const decay = Math.max(0, 1 - FRICTION * dt);
  for (const tyre of tyres) {
    if (tyre.vx === 0 && tyre.vz === 0) continue;
    tyre.vx *= decay;
    tyre.vz *= decay;
    const speedSq = tyre.vx * tyre.vx + tyre.vz * tyre.vz;
    if (speedSq < SLEEP_SPEED * SLEEP_SPEED) {
      tyre.vx = 0;
      tyre.vz = 0;
      continue;
    }
    if (speedSq > MAX_SPEED * MAX_SPEED) {
      const scale = MAX_SPEED / Math.sqrt(speedSq);
      tyre.vx *= scale;
      tyre.vz *= scale;
    }
    tyre.x += tyre.vx * dt;
    tyre.z += tyre.vz * dt;
  }

  tyreContacts(tyres);
}

/** Any tyre moving, or resting anywhere but exactly on its home spot. */
function anyTyreLoose(ctx: StepContext): boolean {
  const tyres = ctx.tyres;
  const spots = ctx.tyreSpots;
  for (let i = 0; i < tyres.length; i++) {
    const tyre = tyres[i];
    const spot = spots[Math.floor(i / TYRES_PER_STACK)];
    if (!tyre) continue;
    if (tyre.vx !== 0 || tyre.vz !== 0 || !spot || tyre.x !== spot.x || tyre.z !== spot.z) {
      return true;
    }
  }
  return false;
}

/** Any car within contact range of any stack spot (where home tyres sit). */
function anyPlayerNearWall(ctx: StepContext): boolean {
  const range = ctx.config.playerRadius + TYRE_RADIUS;
  const rangeSq = range * range;
  for (const player of ctx.players) {
    for (const spot of ctx.tyreSpots) {
      const dx = spot.x - player.x;
      const dz = spot.z - player.z;
      if (dx * dx + dz * dz < rangeSq) return true;
    }
  }
  return false;
}

/**
 * Car meets tyre: separate by inverse mass along the true normal, then
 * exchange momentum along a per-tier FANNED normal. A standing stack's three
 * tyres are coincident, so an undifferentiated impulse would launch them in
 * formation; the fan and the kick scale are what burst it. Both sides of the
 * exchange use the same fanned direction, so momentum stays conserved — it
 * is a glancing-contact model, not a cheat.
 *
 * Candidates come at STACK granularity, and that is the other load-bearing
 * economy here: every tyre is either exactly on its home spot (found by
 * checking the few dozen spots instead of the few hundred tyres) or away
 * from it (kept in a list that is empty for every tick of a clean race).
 * A car in the middle of the road costs a handful of spot distances per
 * tick; the full per-tyre maths only ever runs against a candidate the
 * cheap pass proved close. Candidates are processed in ascending tyre
 * index, so the physics is bit-identical to the all-tyres scan it replaced
 * — the order is part of determinism.
 */
function carContacts(ctx: StepContext): void {
  const range = ctx.config.playerRadius + TYRE_RADIUS;
  const rangeSq = range * range;
  const tyres = ctx.tyres;
  const spots = ctx.tyreSpots;

  // Tyres not sitting exactly on their home spot (or still moving), built
  // ONCE per tick — a parked wall has none, and this single pass is most of
  // what a calm tick pays. A tyre a car dislodges below is promoted into the
  // set immediately, so a second car this same tick still sees it. A freshly
  // restored host replica may list every tyre (quantized positions no longer
  // equal their homes exactly), which is only slower, never wrong.
  const away: number[] = [];
  const isAway = new Uint8Array(tyres.length);
  for (let i = 0; i < tyres.length; i++) {
    const tyre = tyres[i];
    const spot = spots[Math.floor(i / TYRES_PER_STACK)];
    if (!tyre) continue;
    if (tyre.vx !== 0 || tyre.vz !== 0 || !spot || tyre.x !== spot.x || tyre.z !== spot.z) {
      away.push(i);
      isAway[i] = 1;
    }
  }

  const candidates: number[] = [];
  for (const player of ctx.players) {
    candidates.length = 0;
    for (const i of away) candidates.push(i);
    for (let s = 0; s < spots.length; s++) {
      const spot = spots[s];
      if (!spot) continue;
      const sx = spot.x - player.x;
      const sz = spot.z - player.z;
      // At-home tyres sit exactly on the spot, so the spot's own distance is
      // theirs; members that have left it are in the away set instead.
      if (sx * sx + sz * sz >= rangeSq) continue;
      for (let tier = 0; tier < TYRES_PER_STACK; tier++) {
        const i = s * TYRES_PER_STACK + tier;
        if (!isAway[i] && tyres[i]) candidates.push(i);
      }
    }
    candidates.sort((a, b) => a - b);

    for (const i of candidates) {
      const tyre = ctx.tyres[i];
      if (!tyre) continue;
      const dx = tyre.x - player.x;
      const dz = tyre.z - player.z;
      const distSq = dx * dx + dz * dz;
      if (distSq >= rangeSq || distSq < 1e-12) continue;

      const dist = Math.sqrt(distSq);
      const nx = dx / dist;
      const nz = dz / dist;
      const overlap = range - dist;

      // The light body gives way: the tyre takes most of the separation.
      const carShare = TYRE_MASS / (1 + TYRE_MASS);
      player.x -= nx * overlap * carShare;
      player.z -= nz * overlap * carShare;
      tyre.x += nx * overlap * (1 - carShare);
      tyre.z += nz * overlap * (1 - carShare);

      // Dislodged: later cars this tick find it through the away set.
      if (!isAway[i]) {
        away.push(i);
        isAway[i] = 1;
      }

      // Fan the exchange direction by tier.
      const tier = i % TYRES_PER_STACK;
      const spread = TIER_SPREAD[tier] ?? 0;
      const cos = Math.cos(spread);
      const sin = Math.sin(spread);
      const fx = nx * cos - nz * sin;
      const fz = nx * sin + nz * cos;

      const closing = (tyre.vx - player.vx) * fx + (tyre.vz - player.vz) * fz;
      if (closing >= 0) continue;

      // Impulse for unequal masses via the reduced mass; each side divides
      // by its own. j is per unit of the car's mass.
      const kick = TIER_KICK[tier] ?? 1;
      const j = (-(1 + RESTITUTION) * closing * TYRE_MASS * kick) / (1 + TYRE_MASS);
      player.vx -= j * fx;
      player.vz -= j * fz;
      tyre.vx += (j / TYRE_MASS) * fx;
      tyre.vz += (j / TYRE_MASS) * fz;
    }
  }
}

/**
 * Loose tyres shoving each other: what turns one hit into a scattering wall.
 *
 * Only MOVING tyres are candidates, and that gate is load-bearing: a circuit
 * carries a couple of hundred tyres, an all-pairs scan is tens of thousands
 * of checks, and it runs every tick of every race — which is invisible at
 * play speed and ruinous in a test fast-forwarding six laps. A sleeping tyre
 * cannot start a contact (positions only change through this system, and
 * every processed pair leaves separated), so the moving few against the
 * field covers every pair that could possibly touch. A parked wall costs one
 * velocity check per tyre and no pairs at all.
 *
 * Pairs are still resolved lowest-index-first with the normal from `a` to
 * `b`, exactly as the all-pairs scan did — the order is part of determinism.
 */
function tyreContacts(tyres: TyreState[]): void {
  const minDistance = TYRE_RADIUS * 2;
  const minDistanceSq = minDistance * minDistance;

  let anyAwake = false;
  for (const tyre of tyres) {
    if (tyre.vx !== 0 || tyre.vz !== 0) {
      anyAwake = true;
      break;
    }
  }
  if (!anyAwake) return;

  for (let i = 0; i < tyres.length; i++) {
    const a = tyres[i];
    if (!a) continue;
    const aAwake = a.vx !== 0 || a.vz !== 0;
    for (let j = i + 1; j < tyres.length; j++) {
      const b = tyres[j];
      if (!b) continue;
      if (!aAwake && b.vx === 0 && b.vz === 0) continue;

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
