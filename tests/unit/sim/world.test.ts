import { describe, expect, it, vi } from 'vitest';
import { makeSimConfig } from '@/sim/config.js';
import { World } from '@/sim/world.js';

const profile = { name: 'tester', color: '#4cc9f0' };

function makeWorld(seed = 1): World {
  return new World({
    seed,
    config: makeSimConfig({
      arenaHalfExtentX: 12,
      arenaHalfExtentZ: 12,
      obstacleCount: 4,
      pickupCount: 5,
    }),
  });
}

describe('World: players', () => {
  it('adds a player and reports it', () => {
    const world = makeWorld();
    const player = world.addPlayer('alice', profile);

    expect(world.playerCount).toBe(1);
    expect(world.hasPlayer('alice')).toBe(true);
    expect(world.getPlayer('alice')).toBe(player);
    expect(player.score).toBe(0);
  });

  it('treats a repeat add as a profile update, not a reset', () => {
    const world = makeWorld();
    const first = world.addPlayer('alice', profile);
    first.score = 7;

    const again = world.addPlayer('alice', { name: 'renamed', color: '#ff0000' });

    expect(world.playerCount).toBe(1);
    expect(again.score).toBe(7);
    expect(again.name).toBe('renamed');
  });

  it('spawns players apart from each other', () => {
    const world = makeWorld();
    const a = world.addPlayer('a', profile);
    const b = world.addPlayer('b', profile);
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(0.5);
  });

  it('removes players and reports whether anything happened', () => {
    const world = makeWorld();
    world.addPlayer('alice', profile);

    expect(world.removePlayer('alice')).toBe(true);
    expect(world.removePlayer('alice')).toBe(false);
    expect(world.playerCount).toBe(0);
  });

  it('emits join and leave events', () => {
    const world = makeWorld();
    const joined = vi.fn();
    const left = vi.fn();
    world.events.on('playerJoined', joined);
    world.events.on('playerLeft', left);

    world.addPlayer('alice', profile);
    world.removePlayer('alice');

    expect(joined).toHaveBeenCalledWith({ playerId: 'alice' });
    expect(left).toHaveBeenCalledWith({ playerId: 'alice' });
  });

  it('iterates players in sorted id order regardless of join order', () => {
    // Iteration order decides float accumulation order, which decides whether
    // two peers agree. Insertion order differs between peers; sorted order
    // does not.
    const world = makeWorld();
    world.addPlayer('zoe', profile);
    world.addPlayer('adam', profile);
    world.addPlayer('mia', profile);

    expect(world.players().map((p) => p.id)).toEqual(['adam', 'mia', 'zoe']);
  });
});

describe('World: inputs', () => {
  it('ignores input for unknown players', () => {
    const world = makeWorld();
    expect(() =>
      world.setInput('ghost', { seq: 1, moveX: 1, moveZ: 0, sprint: false, buttons: 0 }),
    ).not.toThrow();
  });

  it('keeps the newest input when an older one arrives late', () => {
    const world = makeWorld();
    world.addPlayer('alice', profile);

    world.setInput('alice', { seq: 5, moveX: 1, moveZ: 0, sprint: false, buttons: 0 });
    world.setInput('alice', { seq: 2, moveX: -1, moveZ: 0, sprint: false, buttons: 0 });
    world.step();

    // The stale reversed input must not have been the one applied.
    expect(world.getPlayer('alice')?.vx).toBeGreaterThan(0);
  });
});

describe('World: stepping', () => {
  it('advances the tick counter by one per step', () => {
    const world = makeWorld();
    world.step();
    world.step();
    expect(world.tick).toBe(2);
  });

  it('stepMany matches repeated step calls', () => {
    const a = makeWorld(9);
    const b = makeWorld(9);
    a.addPlayer('p', profile);
    b.addPlayer('p', profile);

    a.setInput('p', { seq: 1, moveX: 1, moveZ: 0.5, sprint: false, buttons: 0 });
    b.setInput('p', { seq: 1, moveX: 1, moveZ: 0.5, sprint: false, buttons: 0 });

    a.stepMany(20);
    for (let i = 0; i < 20; i++) b.step();

    expect(a.checksum()).toBe(b.checksum());
  });

  it('moves a player when input is applied', () => {
    const world = makeWorld();
    const player = world.addPlayer('alice', profile);
    const startX = player.x;

    world.setInput('alice', { seq: 1, moveX: 1, moveZ: 0, sprint: false, buttons: 0 });
    world.stepMany(10);

    expect(player.x).not.toBe(startX);
  });
});

describe('World: arena generation', () => {
  it('generates the same arena for the same seed', () => {
    expect(makeWorld(77).obstacles).toEqual(makeWorld(77).obstacles);
  });

  it('generates different arenas for different seeds', () => {
    expect(makeWorld(1).obstacles).not.toEqual(makeWorld(2).obstacles);
  });

  it('keeps the spawn area clear', () => {
    // Players spawn on a ring near the origin; an obstacle there would trap
    // them at spawn.
    for (let seed = 0; seed < 25; seed++) {
      for (const obstacle of makeWorld(seed).obstacles) {
        const clear =
          Math.abs(obstacle.x) - obstacle.halfX >= 6 || Math.abs(obstacle.z) - obstacle.halfZ >= 6;
        expect(clear).toBe(true);
      }
    }
  });

  it('keeps obstacles inside the arena', () => {
    const world = makeWorld(5);
    for (const obstacle of world.obstacles) {
      expect(Math.abs(obstacle.x) + obstacle.halfX).toBeLessThanOrEqual(
        world.config.arenaHalfExtentX + 1e-6,
      );
      expect(Math.abs(obstacle.z) + obstacle.halfZ).toBeLessThanOrEqual(
        world.config.arenaHalfExtentZ + 1e-6,
      );
    }
  });
});
