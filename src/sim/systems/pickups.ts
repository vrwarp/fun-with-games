import { distanceSq2 } from '../../shared/math.js';
import type { Rng } from '../rng.js';
import type { SimConfig } from '../config.js';
import type { StepContext } from '../step.js';
import type { Obstacle, PickupKind, PickupState } from '../types.js';
import { findFreePosition } from './arena.js';
import { addEffect, isKnockedOut } from './effects.js';

const PICKUP_KINDS: readonly PickupKind[] = ['score', 'speed', 'shield', 'heal'];

/** Weighted, deterministic kind roll. All-zero weights fall back to `score`. */
export function rollPickupKind(config: SimConfig, rng: Rng): PickupKind {
  const weights = config.pickupWeights;
  const total = PICKUP_KINDS.reduce((sum, kind) => sum + Math.max(0, weights[kind]), 0);
  if (total <= 0) return 'score';

  let roll = rng.range(0, total);
  for (const kind of PICKUP_KINDS) {
    roll -= Math.max(0, weights[kind]);
    if (roll < 0) return kind;
  }
  return 'score';
}

export function createPickups(
  config: SimConfig,
  rng: Rng,
  obstacles: readonly Obstacle[],
): PickupState[] {
  const pickups: PickupState[] = [];
  for (let id = 0; id < config.pickupCount; id++) {
    const { x, z } = findFreePosition(config, rng, config.pickupRadius, obstacles);
    const kind = rollPickupKind(config, rng);
    pickups.push({ id, x, z, kind, active: true, respawnTick: 0 });
  }
  return pickups;
}

/**
 * Collects pickups, applies their payload, and respawns expired ones.
 *
 * Payloads by kind: `score` adds `pickupScore` points (and counts for the
 * player's team), `speed` and `shield` grant the matching timed effect, and
 * `heal` restores hp up to `combat.maxHp`.
 *
 * `ctx.players` is sorted by id. When two players touch the same pickup on
 * the same tick, the sort order decides the winner — arbitrary, but identical
 * everywhere, which is the property that actually matters.
 */
export function updatePickups(ctx: StepContext): void {
  const { config } = ctx;
  const pickupRange = config.playerRadius + config.pickupRadius;
  const pickupRangeSq = pickupRange * pickupRange;

  for (const pickup of ctx.pickups) {
    if (!pickup.active) {
      if (ctx.tick >= pickup.respawnTick) {
        const spot = findFreePosition(config, ctx.rng, config.pickupRadius, ctx.obstacles);
        pickup.x = spot.x;
        pickup.z = spot.z;
        pickup.active = true;
        ctx.out.push({ type: 'pickupRespawned', pickupId: pickup.id });
      }
      continue;
    }

    for (const player of ctx.players) {
      if (isKnockedOut(player, ctx.tick)) continue;
      if (distanceSq2(player.x, player.z, pickup.x, pickup.z) > pickupRangeSq) continue;

      switch (pickup.kind) {
        case 'score':
          player.score += config.pickupScore;
          if (player.team >= 0 && player.team < ctx.teamScores.length) {
            ctx.teamScores[player.team] = (ctx.teamScores[player.team] ?? 0) + config.pickupScore;
          }
          break;
        case 'speed':
          addEffect(player, 'speed', ctx.tick + config.powerups.speedTicks);
          break;
        case 'shield':
          addEffect(player, 'shield', ctx.tick + config.powerups.shieldTicks);
          break;
        case 'heal':
          player.hp = Math.min(config.combat.maxHp, player.hp + config.powerups.healAmount);
          break;
      }

      pickup.active = false;
      pickup.respawnTick = ctx.tick + config.pickupRespawnTicks;
      ctx.out.push({
        type: 'pickupCollected',
        playerId: player.id,
        pickupId: pickup.id,
        kind: pickup.kind,
        score: player.score,
      });
      break;
    }
  }
}
