import { distanceSq2 } from '../../shared/math.js';
import type { Rng } from '../rng.js';
import type { SimConfig } from '../config.js';
import type { Obstacle, PickupState, PlayerState } from '../types.js';
import { findFreePosition } from './arena.js';

export function createPickups(
  config: SimConfig,
  rng: Rng,
  obstacles: readonly Obstacle[],
): PickupState[] {
  const pickups: PickupState[] = [];
  for (let id = 0; id < config.pickupCount; id++) {
    const { x, z } = findFreePosition(config, rng, config.pickupRadius, obstacles);
    pickups.push({ id, x, z, active: true, respawnTick: 0 });
  }
  return pickups;
}

export interface PickupCollection {
  playerId: string;
  pickupId: number;
}

/**
 * Collects pickups and respawns expired ones.
 *
 * `players` must be sorted by id. When two players touch the same pickup on
 * the same tick, the sort order decides the winner — arbitrary, but identical
 * everywhere, which is the property that actually matters.
 */
export function updatePickups(
  pickups: PickupState[],
  players: readonly PlayerState[],
  config: SimConfig,
  rng: Rng,
  obstacles: readonly Obstacle[],
  tick: number,
): { collected: PickupCollection[]; respawned: number[] } {
  const collected: PickupCollection[] = [];
  const respawned: number[] = [];
  const pickupRange = config.playerRadius + config.pickupRadius;
  const pickupRangeSq = pickupRange * pickupRange;

  for (const pickup of pickups) {
    if (!pickup.active) {
      if (tick >= pickup.respawnTick) {
        const spot = findFreePosition(config, rng, config.pickupRadius, obstacles);
        pickup.x = spot.x;
        pickup.z = spot.z;
        pickup.active = true;
        respawned.push(pickup.id);
      }
      continue;
    }

    for (const player of players) {
      if (distanceSq2(player.x, player.z, pickup.x, pickup.z) > pickupRangeSq) continue;

      player.score += config.pickupScore;
      pickup.active = false;
      pickup.respawnTick = tick + config.pickupRespawnTicks;
      collected.push({ playerId: player.id, pickupId: pickup.id });
      break;
    }
  }

  return { collected, respawned };
}
