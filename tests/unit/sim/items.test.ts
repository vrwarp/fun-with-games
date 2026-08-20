import { describe, expect, it, vi } from 'vitest';
import { makeSimConfig, type SimConfigOverrides } from '@/sim/config.js';
import { addEffect } from '@/sim/systems/effects.js';
import { World } from '@/sim/world.js';

const profile = { name: 'p', color: '#4cc9f0' };

function ctfWorld(overrides: SimConfigOverrides = {}): World {
  return new World({
    seed: 12,
    config: makeSimConfig({
      obstacleCount: 0,
      pickupCount: 0,
      arenaHalfExtentX: 30,
      arenaHalfExtentZ: 30,
      teams: { count: 2 },
      items: [
        { kind: 'flag', homeX: -20, homeZ: 0, team: 0 },
        { kind: 'flag', homeX: 20, homeZ: 0, team: 1 },
      ],
      zones: [
        { kind: 'base', x: -20, z: 0, radius: 3, team: 0, order: 0 },
        { kind: 'base', x: 20, z: 0, radius: 3, team: 1, order: 0 },
      ],
      itemRules: { returnTicks: 20, stealGraceTicks: 10, deliverScore: 1 },
      ...overrides,
    }),
  });
}

function park(world: World): void {
  for (const player of world.players()) {
    Object.assign(player, { x: 0, z: 25, vx: 0, vz: 0 });
  }
}

describe('items: flags', () => {
  it('is taken by an enemy standing on it, and follows the carrier', () => {
    const world = ctfWorld();
    const a = world.addPlayer('a', profile); // team 0
    park(world);
    Object.assign(a, { x: 20, z: 0 }); // standing on team 1's flag
    world.step();

    const enemyFlag = world.items()[1]!;
    expect(enemyFlag.carrierId).toBe('a');
    expect(enemyFlag.atHome).toBe(false);

    Object.assign(a, { x: 5, z: 5 });
    world.step();
    expect(world.items()[1]!.x).toBeCloseTo(a.x, 6);
  });

  it('cannot be taken by its own team; touching a dropped one returns it', () => {
    const world = ctfWorld();
    const a = world.addPlayer('a', profile); // team 0
    park(world);

    // Standing on own flag at home: nothing happens.
    Object.assign(a, { x: -20, z: 0 });
    world.step();
    expect(world.items()[0]!.carrierId).toBe('');
    expect(world.items()[0]!.atHome).toBe(true);

    // Drop own flag somewhere in the field, then touch it: instant return.
    const flag = world.items()[0] as { x: number; z: number; atHome: boolean; returnTick: number };
    Object.assign(flag, { x: 5, z: 5, atHome: false, returnTick: 10_000 });
    Object.assign(a, { x: 5, z: 5 });
    world.step();
    expect(world.items()[0]!.atHome).toBe(true);
    expect(world.items()[0]!.x).toBe(-20);
  });

  it('drops when the carrier is knocked out and auto-returns later', () => {
    const world = ctfWorld({ combat: { enabled: true, maxHp: 1 } });
    const a = world.addPlayer('a', profile);
    park(world);
    Object.assign(a, { x: 20, z: 0 });
    world.step();
    expect(world.items()[1]!.carrierId).toBe('a');

    const dropped = vi.fn();
    world.events.on('itemDropped', dropped);
    Object.assign(a, { x: 3, z: 3 });
    addEffect(a, 'ko', world.tick + 500);
    world.step();

    expect(world.items()[1]!.carrierId).toBe('');
    expect(world.items()[1]!.x).toBeCloseTo(3, 1);
    expect(dropped).toHaveBeenCalled();

    // Nobody touches it: it snaps home after returnTicks.
    park(world);
    world.stepMany(25);
    expect(world.items()[1]!.atHome).toBe(true);
  });

  it('delivers at an own base for team and personal score', () => {
    const world = ctfWorld();
    const a = world.addPlayer('a', profile); // team 0
    park(world);
    const delivered = vi.fn();
    world.events.on('itemDelivered', delivered);

    Object.assign(a, { x: 20, z: 0 }); // grab enemy flag
    world.step();
    Object.assign(a, { x: -20, z: 0, vx: 0, vz: 0 }); // walk it home
    world.step();

    expect(delivered).toHaveBeenCalledWith({ itemId: 1, playerId: 'a', score: 1 });
    expect(world.teamScores[0]).toBe(1);
    expect(a.score).toBe(1);
    expect(world.items()[1]!.atHome).toBe(true);
    expect(world.items()[1]!.x).toBe(20);
  });
});

describe('items: crown', () => {
  function crownWorld(): World {
    return new World({
      seed: 12,
      config: makeSimConfig({
        obstacleCount: 0,
        pickupCount: 0,
        arenaHalfExtentX: 30,
        arenaHalfExtentZ: 30,
        items: [{ kind: 'crown', homeX: 0, homeZ: 0, team: -1 }],
        itemRules: { stealGraceTicks: 10, carryScorePerSecond: 1 },
      }),
    });
  }

  it('anyone can take it, and holding it scores every second', () => {
    const world = crownWorld();
    const a = world.addPlayer('a', profile);
    Object.assign(a, { x: 0, z: 0, vx: 0, vz: 0 });

    world.stepMany(world.config.tickRate + 2);

    expect(world.items()[0]!.carrierId).toBe('a');
    expect(a.score).toBeGreaterThanOrEqual(1);
  });

  it('is stolen by touching the carrier once the grace expires', () => {
    const world = crownWorld();
    const a = world.addPlayer('a', profile);
    const b = world.addPlayer('b', profile);
    Object.assign(a, { x: 0, z: 0, vx: 0, vz: 0 });
    Object.assign(b, { x: 10, z: 10, vx: 0, vz: 0 });
    world.step();
    expect(world.items()[0]!.carrierId).toBe('a');

    // During grace: touching does not steal.
    Object.assign(b, { x: a.x + 0.6, z: a.z, vx: 0, vz: 0 });
    world.step();
    expect(world.items()[0]!.carrierId).toBe('a');

    world.stepMany(12); // grace over; b still adjacent (collision keeps ~2r)
    expect(world.items()[0]!.carrierId).toBe('b');
  });
});
