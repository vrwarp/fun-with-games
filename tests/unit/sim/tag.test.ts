import { describe, expect, it, vi } from 'vitest';
import { makeSimConfig, type SimConfigOverrides } from '@/sim/config.js';
import { ROLE_IT, ROLE_NONE } from '@/sim/types.js';
import { World } from '@/sim/world.js';

const profile = { name: 'p', color: '#4cc9f0' };

function tagWorld(overrides: SimConfigOverrides = {}): World {
  return new World({
    seed: 8,
    config: makeSimConfig({
      obstacleCount: 0,
      pickupCount: 0,
      arenaHalfExtentX: 30,
      arenaHalfExtentZ: 30,
      ...overrides,
      tag: { enabled: true, graceTicks: 10, survivorScorePerSecond: 1, ...overrides.tag },
    }),
  });
}

function apart(world: World): void {
  const [a, b, c] = world.players();
  if (a) Object.assign(a, { x: -20, z: -20, vx: 0, vz: 0 });
  if (b) Object.assign(b, { x: 20, z: 20, vx: 0, vz: 0 });
  if (c) Object.assign(c, { x: -20, z: 20, vx: 0, vz: 0 });
}

describe('tag: role assignment', () => {
  it('picks exactly one it once two players exist', () => {
    const world = tagWorld();
    world.addPlayer('a', profile);
    world.stepMany(3);
    expect(world.players().filter((p) => p.role === ROLE_IT)).toHaveLength(0);

    world.addPlayer('b', profile);
    apart(world);
    world.step();

    expect(world.players().filter((p) => p.role === ROLE_IT)).toHaveLength(1);
  });

  it('re-assigns when the it player leaves', () => {
    const world = tagWorld();
    world.addPlayer('a', profile);
    world.addPlayer('b', profile);
    world.addPlayer('c', profile);
    apart(world);
    world.step();

    const it_ = world.players().find((p) => p.role === ROLE_IT);
    expect(it_).toBeDefined();
    world.removePlayer(it_!.id);
    world.step();

    expect(world.players().filter((p) => p.role === ROLE_IT)).toHaveLength(1);
  });
});

describe('tag: transfer on contact', () => {
  it('moves the role to the touched player and protects them briefly', () => {
    const world = tagWorld();
    const a = world.addPlayer('a', profile);
    const b = world.addPlayer('b', profile);
    apart(world);
    const tagged = vi.fn();
    world.events.on('playerTagged', tagged);
    world.step(); // initial assignment

    const it_ = a.role === ROLE_IT ? a : b;
    const other = it_ === a ? b : a;

    // Let the initial grace expire, then touch.
    world.stepMany(12);
    Object.assign(other, { x: it_.x + 0.5, z: it_.z, vx: 0, vz: 0 });
    world.step();

    expect(other.role).toBe(ROLE_IT);
    expect(it_.role).toBe(ROLE_NONE);
    // The ex-it player gets the grace, so the tag cannot bounce back.
    expect(it_.effects['safe']).toBeGreaterThan(world.tick);
    expect(tagged).toHaveBeenCalledWith({ playerId: other.id, byId: it_.id });
  });

  it('cannot bounce straight back during the grace period', () => {
    const world = tagWorld();
    const a = world.addPlayer('a', profile);
    const b = world.addPlayer('b', profile);
    apart(world);
    world.step();
    world.stepMany(12);

    const it_ = a.role === ROLE_IT ? a : b;
    const other = it_ === a ? b : a;
    Object.assign(other, { x: it_.x + 0.5, z: it_.z, vx: 0, vz: 0 });
    world.step(); // transfer happens; `other` is now it with fresh grace

    // They are still touching (collision pushed them apart to exactly 2r,
    // within tag reach) — but the old it is NOT protected, so without grace
    // asymmetry the tag would ping-pong. Verify it does not.
    world.step();
    expect(other.role).toBe(ROLE_IT);
  });

  it('spread variant infects without curing the tagger', () => {
    const world = tagWorld({ tag: { enabled: true, variant: 'spread', graceTicks: 10 } });
    const a = world.addPlayer('a', profile);
    const b = world.addPlayer('b', profile);
    const c = world.addPlayer('c', profile);
    apart(world);
    world.step();
    world.stepMany(12);

    const it_ = world.players().find((p) => p.role === ROLE_IT)!;
    const healthy = world.players().filter((p) => p.role === ROLE_NONE);
    const victim = healthy[0]!;
    Object.assign(victim, { x: it_.x + 0.5, z: it_.z, vx: 0, vz: 0 });
    world.step();

    expect(it_.role).toBe(ROLE_IT);
    expect(victim.role).toBe(ROLE_IT);
    void a;
    void b;
    void c;
  });
});

describe('tag: survivor scoring', () => {
  it('pays everyone except it once per second', () => {
    const world = tagWorld();
    world.addPlayer('a', profile);
    world.addPlayer('b', profile);
    apart(world);
    world.stepMany(1); // assignment on the first step

    // Advance to just past the next full second boundary.
    world.stepMany(world.config.tickRate + 2);

    const it_ = world.players().find((p) => p.role === ROLE_IT)!;
    const survivor = world.players().find((p) => p.role === ROLE_NONE)!;
    expect(survivor.score).toBeGreaterThan(0);
    expect(it_.score).toBe(0);
  });
});
