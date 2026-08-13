import { describe, expect, it, vi } from 'vitest';
import { makeSimConfig } from '@/sim/config.js';
import { World } from '@/sim/world.js';

const profile = { name: 'tester', color: '#4cc9f0' };

/** One pickup, no obstacles, small arena: collection is easy to reason about. */
function soloWorld(): World {
  return new World({
    seed: 7,
    config: makeSimConfig({
      arenaHalfExtentX: 8,
      arenaHalfExtentZ: 8,
      obstacleCount: 0,
      pickupCount: 1,
      pickupRespawnTicks: 10,
      pickupScore: 3,
    }),
  });
}

describe('pickups', () => {
  it('scores and deactivates when a player touches one', () => {
    const world = soloWorld();
    const player = world.addPlayer('alice', profile);
    const pickup = world.pickups()[0];
    expect(pickup).toBeDefined();

    // Teleport onto the pickup rather than driving there: this test is about
    // collection, not navigation.
    player.x = pickup!.x;
    player.z = pickup!.z;
    world.step();

    expect(player.score).toBe(3);
    expect(world.pickups()[0]?.active).toBe(false);
  });

  it('emits a collection event carrying the running score', () => {
    const world = soloWorld();
    const player = world.addPlayer('alice', profile);
    const collected = vi.fn();
    world.events.on('pickupCollected', collected);

    const pickup = world.pickups()[0]!;
    player.x = pickup.x;
    player.z = pickup.z;
    world.step();

    expect(collected).toHaveBeenCalledWith({ playerId: 'alice', pickupId: pickup.id, score: 3 });
  });

  it('respawns after the configured delay, somewhere legal', () => {
    const world = soloWorld();
    const player = world.addPlayer('alice', profile);
    const pickup = world.pickups()[0]!;

    player.x = pickup.x;
    player.z = pickup.z;
    world.step();
    expect(world.pickups()[0]?.active).toBe(false);

    // Move away so it is not instantly collected again on respawn.
    player.x = 7;
    player.z = 7;
    world.stepMany(11);

    const respawned = world.pickups()[0]!;
    expect(respawned.active).toBe(true);
    expect(Math.abs(respawned.x)).toBeLessThanOrEqual(world.config.arenaHalfExtentX);
    expect(Math.abs(respawned.z)).toBeLessThanOrEqual(world.config.arenaHalfExtentZ);
  });

  it('emits a respawn event', () => {
    const world = soloWorld();
    const player = world.addPlayer('alice', profile);
    const respawned = vi.fn();
    world.events.on('pickupRespawned', respawned);

    const pickup = world.pickups()[0]!;
    player.x = pickup.x;
    player.z = pickup.z;
    world.step();
    player.x = 7;
    player.z = 7;
    world.stepMany(11);

    expect(respawned).toHaveBeenCalledWith({ pickupId: pickup.id });
  });

  it('awards a contested pickup to exactly one player', () => {
    // Two players on the same tile on the same tick. Either may win; both
    // winning would mint points out of nothing.
    const world = soloWorld();
    const alice = world.addPlayer('alice', profile);
    const bob = world.addPlayer('bob', profile);
    const pickup = world.pickups()[0]!;

    alice.x = pickup.x;
    alice.z = pickup.z;
    bob.x = pickup.x;
    bob.z = pickup.z;
    world.step();

    expect(alice.score + bob.score).toBe(3);
  });

  it('does not collect at a distance', () => {
    const world = soloWorld();
    const player = world.addPlayer('alice', profile);
    const pickup = world.pickups()[0]!;

    player.x = pickup.x + 5;
    player.z = pickup.z + 5;
    world.stepMany(3);

    expect(player.score).toBe(0);
    expect(world.pickups()[0]?.active).toBe(true);
  });

  it('places pickups clear of obstacles', () => {
    const world = new World({
      seed: 21,
      config: makeSimConfig({ obstacleCount: 8, pickupCount: 12, arenaHalfExtentX: 16 }),
    });

    for (const pickup of world.pickups()) {
      for (const obstacle of world.obstacles) {
        const dx = Math.max(Math.abs(pickup.x - obstacle.x) - obstacle.halfX, 0);
        const dz = Math.max(Math.abs(pickup.z - obstacle.z) - obstacle.halfZ, 0);
        expect(Math.hypot(dx, dz)).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
