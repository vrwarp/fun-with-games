import type { SimConfig } from '../config.js';
import type { PlayerState } from '../types.js';

/**
 * Timed status effects.
 *
 * An effect is just an entry in `player.effects`: id -> expiry tick
 * (exclusive — active while `tick < expiry`). That representation was chosen
 * so that snapshots, the wire codec and the checksum handle every effect the
 * same way: **adding a new effect kind is not a protocol change**, and it can
 * never be forgotten in a snapshot.
 *
 * Systems own their effects: combat sets `ko` and `safe`, projectiles set
 * `reload`, pickups set `speed` and `shield`, items refresh `carry`. This
 * module only provides the shared verbs and the two questions the movement
 * integrator asks every tick ("can this player move?", "how fast?").
 */

/** Grants (or extends) an effect until `untilTick`. Never shortens one. */
export function addEffect(player: PlayerState, id: string, untilTick: number): void {
  const current = player.effects[id] ?? 0;
  if (untilTick > current) player.effects[id] = untilTick;
}

export function clearEffect(player: PlayerState, id: string): void {
  if (id in player.effects) delete player.effects[id];
}

export function hasEffect(player: PlayerState, id: string, tick: number): boolean {
  const until = player.effects[id];
  return until !== undefined && tick < until;
}

/** Remaining duration in ticks; 0 when absent or expired. */
export function effectRemaining(player: PlayerState, id: string, tick: number): number {
  const until = player.effects[id];
  return until !== undefined && until > tick ? until - tick : 0;
}

/** Ids of the effects active at `tick`, sorted for deterministic iteration. */
export function activeEffects(player: PlayerState, tick: number): string[] {
  return Object.keys(player.effects)
    .filter((id) => hasEffect(player, id, tick))
    .sort();
}

/**
 * Drops expired entries so snapshots stay small.
 *
 * `ko` is deliberately kept: its expiry is the respawn moment, and the combat
 * system must still observe the expired entry to perform the respawn. It is
 * removed there, not here.
 */
export function pruneEffects(players: readonly PlayerState[], tick: number): void {
  for (const player of players) {
    for (const id of Object.keys(player.effects)) {
      if (id === 'ko') continue;
      const until = player.effects[id];
      if (until !== undefined && until <= tick) delete player.effects[id];
    }
  }
}

/** Frozen, stunned or knocked out — no voluntary movement. */
export function isImmobilized(player: PlayerState, tick: number): boolean {
  return (
    hasEffect(player, 'frozen', tick) ||
    hasEffect(player, 'stun', tick) ||
    hasEffect(player, 'ko', tick)
  );
}

/** Shielded, spawn-protected, or out of play — tags and damage pass through. */
export function isProtected(player: PlayerState, tick: number): boolean {
  return (
    hasEffect(player, 'shield', tick) ||
    hasEffect(player, 'safe', tick) ||
    hasEffect(player, 'ko', tick)
  );
}

/** Knocked out right now (respawn pending or eliminated). */
export function isKnockedOut(player: PlayerState, tick: number): boolean {
  return hasEffect(player, 'ko', tick);
}

/**
 * Speed multiplier from everything currently affecting the player. Applied to
 * both acceleration and max speed by `integratePlayer`, so prediction and
 * authority agree automatically.
 */
export function movementScale(player: PlayerState, tick: number, config: SimConfig): number {
  let scale = 1;
  if (hasEffect(player, 'speed', tick)) scale *= config.powerups.speedMultiplier;
  if (hasEffect(player, 'carry', tick)) scale *= config.itemRules.carrySpeedMultiplier;
  if (player.isBot) scale *= config.bots.speedMultiplier;
  return scale;
}
