import { distanceSq2 } from '../../shared/math.js';
import type { SimConfig } from '../config.js';
import type { StepContext } from '../step.js';
import { hasTrack, sampleTrack } from '../track.js';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, type PlayerId, type PlayerState } from '../types.js';
import { addEffect, hasEffect, isKnockedOut } from './effects.js';
import { isRoundActive } from './phase.js';

/**
 * The rules that turn "cars on a circuit" into a race: the running order, the
 * tow, the overtaking aid, and the tyres that make a pit stop a decision.
 *
 * Not one of these keeps its own state. Positions and gaps are derived from
 * `lap`, `checkpoint` and where a car sits on the centreline; the tow, the
 * wing and the tyres are timed effects, which the snapshot, the wire codec
 * and the checksum already carry. The whole file is therefore free of the
 * state-carrying ritual in `docs/RECIPES.md` — deliberately, because that is
 * how the kit prefers a feature to be built.
 *
 * `steerVehicle` is the consumer: it reads those effects when it works out a
 * car's top speed and grip, which means a client predicting its own car
 * applies exactly the same tow and the same worn rubber as the host.
 */

/** One car's place in the running order. */
export interface RaceStanding {
  readonly id: PlayerId;
  /** 1 for the leader. */
  readonly position: number;
  /**
   * Seconds behind the car directly ahead, at nominal pace.
   *
   * 0 for the leader, and 0 when the car ahead is on a different lap — an
   * interval across a lap boundary is not an interval, it is a lap.
   */
  readonly interval: number;
}

/** Bit for a configured button name; 0 when the action is unbound. */
function buttonBit(name: 'primary' | 'secondary' | 'none'): number {
  if (name === 'primary') return BUTTON_PRIMARY;
  if (name === 'secondary') return BUTTON_SECONDARY;
  return 0;
}

/** How far a player still has to go to reach their next gate. */
function distanceToNextGate(config: SimConfig, player: PlayerState): number {
  const gate = config.zones.find(
    (zone) => zone.kind === 'checkpoint' && zone.order === player.checkpoint,
  );
  if (!gate) return 0;
  return Math.sqrt(distanceSq2(player.x, player.z, gate.x, gate.z));
}

/**
 * The running order, leader first.
 *
 * Ranked by laps, then by gates passed, then by how close the car is to the
 * gate it is heading for. That ladder is used rather than a single
 * distance-round-the-lap number because the latter has to wrap somewhere, and
 * "somewhere" is the start/finish line — precisely where a race is decided and
 * where a car briefly reads as a whole lap ahead of itself.
 *
 * Ties break on player id, so every peer produces the same order.
 */
export function raceStandings(config: SimConfig, players: readonly PlayerState[]): RaceStanding[] {
  const ranked = [...players].sort((a, b) => {
    if (a.lap !== b.lap) return b.lap - a.lap;
    if (a.checkpoint !== b.checkpoint) return b.checkpoint - a.checkpoint;
    const gap = distanceToNextGate(config, a) - distanceToNextGate(config, b);
    if (gap !== 0) return gap;
    return a.id.localeCompare(b.id);
  });

  const nominalSpeed = config.playerMaxSpeed > 0 ? config.playerMaxSpeed : 1;

  return ranked.map((player, index) => {
    const ahead = index > 0 ? ranked[index - 1] : undefined;
    let interval = 0;
    if (ahead && ahead.lap === player.lap) {
      const distance = gapAhead(config, player, ahead);
      if (Number.isFinite(distance)) interval = distance / nominalSpeed;
    }
    return { id: player.id, position: index + 1, interval };
  });
}

/**
 * Distance from `player` forward along the road to `other`, in world units.
 *
 * Measured along the centreline and wrapped into one lap, which is what makes
 * it safe near the start/finish line: a car a metre past the line is a metre
 * ahead of one a metre before it, not a lap behind. `Infinity` when the mode
 * has no circuit to measure along.
 */
export function gapAhead(config: SimConfig, player: PlayerState, other: PlayerState): number {
  if (!hasTrack(config)) return Number.POSITIVE_INFINITY;

  const mine = sampleTrack(config.trackPath, player.x, player.z);
  const theirs = sampleTrack(config.trackPath, other.x, other.z);
  if (mine.length <= 0) return Number.POSITIVE_INFINITY;

  const delta = theirs.progress - mine.progress;
  return delta >= 0 ? delta : delta + mine.length;
}

/** True when this position is inside a DRS activation zone. */
function isInDrsZone(config: SimConfig, x: number, z: number): boolean {
  for (const zone of config.zones) {
    if (zone.kind !== 'drs') continue;
    if (distanceSq2(x, z, zone.x, zone.z) <= zone.radius * zone.radius) return true;
  }
  return false;
}

/** The closest car ahead on the road, and how far ahead it is. */
function carAhead(
  ctx: StepContext,
  player: PlayerState,
): { other: PlayerState; distance: number } | null {
  let best: { other: PlayerState; distance: number } | null = null;

  for (const other of ctx.players) {
    if (other.id === player.id || isKnockedOut(other, ctx.tick)) continue;
    const distance = gapAhead(ctx.config, player, other);
    // A gap of zero is the car you are inside of, which is a collision, not a
    // tow; and anything past half a lap is a car you are ahead of.
    if (distance <= 0 || !Number.isFinite(distance)) continue;
    if (!best || distance < best.distance) best = { other, distance };
  }

  return best;
}

/**
 * One tick of racing: tyres, the tow, and the wing.
 *
 * Runs after the zone system so that laps and gates are already up to date for
 * this tick, and before the next tick's movement, which is what reads the
 * effects this grants.
 */
export function updateRace(ctx: StepContext): void {
  const rules = ctx.config.race;
  if (!rules.enabled) return;

  const active = isRoundActive(ctx.phase, ctx.config);

  // --- Tyres ---------------------------------------------------------------
  // A set of tyres is one effect whose remaining duration IS its life. Fresh
  // rubber is granted whenever the race is not running (so every round starts
  // on a new set, however the last one ended) and whenever a car is in the
  // pits — which is the whole trade: a slow lane in exchange for grip.
  if (rules.tyreStintTicks > 0) {
    for (const player of ctx.players) {
      if (active && !inPit(ctx.config, player)) continue;
      addEffect(player, 'tyre', ctx.tick + rules.tyreStintTicks);
    }
  }

  if (!active) return;

  for (const player of ctx.players) {
    if (isKnockedOut(player, ctx.tick)) continue;

    const ahead = carAhead(ctx, player);
    if (!ahead) continue;

    // --- Slipstream ------------------------------------------------------
    // Refreshed two ticks at a time rather than granted for a duration, so it
    // ends the moment the driver falls out of the tow instead of lingering.
    if (rules.slipstreamRange > 0 && ahead.distance <= rules.slipstreamRange) {
      addEffect(player, 'tow', ctx.tick + 2);
    }

    // --- DRS -------------------------------------------------------------
    if (rules.drsGapSeconds <= 0) continue;
    const window = rules.drsGapSeconds * ctx.config.playerMaxSpeed;
    if (ahead.distance > window) continue;
    if (!isInDrsZone(ctx.config, player.x, player.z)) continue;

    // Armed: the HUD and the renderer read this to light the wing up.
    addEffect(player, 'drsok', ctx.tick + 2);

    const pressed = (player.input.buttons & buttonBit(rules.drsButton)) !== 0;
    if (pressed && !hasEffect(player, 'drs', ctx.tick)) {
      addEffect(player, 'drs', ctx.tick + rules.drsTicks);
      ctx.out.push({ type: 'drsOpened', playerId: player.id });
    }
  }
}

function inPit(config: SimConfig, player: PlayerState): boolean {
  for (const zone of config.zones) {
    if (zone.kind !== 'pit') continue;
    if (distanceSq2(player.x, player.z, zone.x, zone.z) <= zone.radius * zone.radius) return true;
  }
  return false;
}
