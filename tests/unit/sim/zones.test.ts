import { describe, expect, it, vi } from 'vitest';
import { makeSimConfig, type SimConfigOverrides } from '@/sim/config.js';
import { World } from '@/sim/world.js';

const profile = { name: 'p', color: '#4cc9f0' };

function worldWith(overrides: SimConfigOverrides): World {
  return new World({
    seed: 6,
    config: makeSimConfig({
      obstacleCount: 0,
      pickupCount: 0,
      arenaHalfExtentX: 30,
      arenaHalfExtentZ: 30,
      ...overrides,
    }),
  });
}

const hill = { kind: 'hill', x: 0, z: 0, radius: 4, team: -1, order: 0 } as const;

describe('zones: hill', () => {
  it('pays the sole occupant once per second', () => {
    const world = worldWith({ zones: [hill] });
    const a = world.addPlayer('a', profile);
    Object.assign(a, { x: 0, z: 0, vx: 0, vz: 0 });

    world.stepMany(world.config.tickRate * 2 + 2);

    expect(a.score).toBeGreaterThanOrEqual(2);
    expect(world.zones()[0]?.ownerId).toBe('a');
  });

  it('pays nobody while contested', () => {
    const world = worldWith({ zones: [hill] });
    const a = world.addPlayer('a', profile);
    const b = world.addPlayer('b', profile);
    Object.assign(a, { x: -1, z: 0, vx: 0, vz: 0 });
    Object.assign(b, { x: 1, z: 0, vx: 0, vz: 0 });

    world.stepMany(world.config.tickRate * 2 + 2);

    expect(a.score).toBe(0);
    expect(b.score).toBe(0);
    expect(world.zones()[0]?.ownerId).toBe('');
  });

  it('a sole occupying team owns the hill and scores', () => {
    const world = worldWith({ zones: [hill], teams: { count: 2 } });
    const a = world.addPlayer('a', profile); // team 0
    const b = world.addPlayer('b', profile); // team 1
    Object.assign(a, { x: -1, z: 0, vx: 0, vz: 0 });
    Object.assign(b, { x: 25, z: 25, vx: 0, vz: 0 });

    world.stepMany(world.config.tickRate + 2);

    expect(world.zones()[0]?.ownerTeam).toBe(0);
    expect(world.teamScores[0]).toBeGreaterThanOrEqual(1);
    expect(world.teamScores[1]).toBe(0);
  });

  it('emits zoneCaptured when ownership changes hands', () => {
    const world = worldWith({ zones: [hill] });
    const captured = vi.fn();
    world.events.on('zoneCaptured', captured);
    const a = world.addPlayer('a', profile);
    Object.assign(a, { x: 0, z: 0, vx: 0, vz: 0 });

    world.step();
    expect(captured).toHaveBeenCalledWith({ zoneId: 0, ownerId: 'a', ownerTeam: -1 });
  });
});

describe('zones: checkpoints', () => {
  const gates = [
    { kind: 'checkpoint', x: 10, z: 0, radius: 3, team: -1, order: 0 },
    { kind: 'checkpoint', x: -10, z: 0, radius: 3, team: -1, order: 1 },
  ] as const;

  it('advances only through the next gate in sequence', () => {
    const world = worldWith({ zones: [...gates] });
    const a = world.addPlayer('a', profile);

    // Standing in gate 1 first does nothing — gate 0 is next.
    Object.assign(a, { x: -10, z: 0, vx: 0, vz: 0 });
    world.step();
    expect(a.checkpoint).toBe(0);

    Object.assign(a, { x: 10, z: 0, vx: 0, vz: 0 });
    world.step();
    expect(a.checkpoint).toBe(1);
  });

  it('completes a lap, scores it and emits the event', () => {
    const world = worldWith({ zones: [...gates] });
    const lap = vi.fn();
    world.events.on('lapCompleted', lap);
    const a = world.addPlayer('a', profile);

    Object.assign(a, { x: 10, z: 0, vx: 0, vz: 0 });
    world.step();
    Object.assign(a, { x: -10, z: 0, vx: 0, vz: 0 });
    world.step();

    expect(a.lap).toBe(1);
    expect(a.checkpoint).toBe(0); // wrapped for the next lap
    expect(a.score).toBe(world.config.zoneRules.lapScore);
    expect(lap).toHaveBeenCalledWith({ playerId: 'a', lap: 1 });
  });
});
