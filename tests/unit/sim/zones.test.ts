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

  it('completes a lap back at the line, not at the last gate', () => {
    // Gate 0 is the start/finish line. A lap is not over when the car reaches
    // the LAST gate — it still has the run from there back to the line to do,
    // and counting it early takes that section off the lap counter, off every
    // lap time, and off where the chequered flag falls.
    const world = worldWith({ zones: [...gates] });
    const lap = vi.fn();
    world.events.on('lapCompleted', lap);
    const a = world.addPlayer('a', profile);

    // Crossing the line for the first time starts lap one; it does not end
    // lap zero. The grid sits behind the line.
    Object.assign(a, { x: 10, z: 0, vx: 0, vz: 0 });
    world.step();
    expect(a.lap).toBe(0);
    expect(a.checkpoint).toBe(1);

    // The far gate is the last of this two-gate circuit. Reaching it is not
    // the lap.
    Object.assign(a, { x: -10, z: 0, vx: 0, vz: 0 });
    world.step();
    expect(a.lap).toBe(0);
    // Parked on the gate count rather than wrapped to zero, so "back at the
    // line having done the lap" cannot be confused with "sat on the grid".
    expect(a.checkpoint).toBe(gates.length);
    expect(lap).not.toHaveBeenCalled();

    // Back at the line: now it is.
    Object.assign(a, { x: 10, z: 0, vx: 0, vz: 0 });
    world.step();
    expect(a.lap).toBe(1);
    expect(a.checkpoint).toBe(1);
    expect(a.score).toBe(world.config.zoneRules.lapScore);
    expect(lap).toHaveBeenCalledWith({ playerId: 'a', lap: 1, lapTicks: 2, best: true });
  });

  it('times each lap from the start/finish line, and remembers the best', () => {
    const world = worldWith({ zones: [...gates] });
    const a = world.addPlayer('a', profile);

    const crossLine = (): void => {
      Object.assign(a, { x: 10, z: 0, vx: 0, vz: 0 });
      world.step();
    };
    const crossBack = (): void => {
      Object.assign(a, { x: -10, z: 0, vx: 0, vz: 0 });
      world.step();
    };
    const idle = (ticks: number): void => {
      Object.assign(a, { x: 0, z: 20, vx: 0, vz: 0 });
      world.stepMany(ticks);
    };

    // Dawdling on the grid must not land on the first lap time: the clock
    // starts at the line, not at tick zero.
    idle(10);
    crossLine();
    const started = world.tick - 1;
    expect(a.lapStartTick).toBe(started);
    expect(a.lap).toBe(0);

    // Round the far gate and back to the line, which is what a lap is.
    idle(20);
    crossBack();
    expect(a.lap).toBe(0);
    idle(5);
    crossLine();
    const firstEnd = world.tick - 1;
    expect(a.lap).toBe(1);
    expect(a.lastLapTicks).toBe(firstEnd - started);
    expect(a.bestLapTicks).toBe(a.lastLapTicks);
    // The lap that just ended is where the next one starts from.
    expect(a.lapStartTick).toBe(firstEnd);
    const firstLap = a.lastLapTicks;

    // A slower second lap leaves the best alone.
    idle(60);
    crossBack();
    idle(5);
    crossLine();
    expect(a.lap).toBe(2);
    expect(a.lastLapTicks).toBeGreaterThan(firstLap);
    expect(a.bestLapTicks).toBe(firstLap);
  });
});
