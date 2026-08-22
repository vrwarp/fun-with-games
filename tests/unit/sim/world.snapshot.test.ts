import { describe, expect, it, vi } from 'vitest';
import { makeSimConfig } from '@/sim/config.js';
import { World } from '@/sim/world.js';
import type { WorldSnapshot } from '@/sim/types.js';

const profile = { name: 'tester', color: '#4cc9f0' };

/**
 * Every kit system enabled at once. THIS is what gives the round-trip test
 * its teeth: a field added to any entity but forgotten in the snapshot (or
 * in `applySnapshot` / `checksum`) fails here. If you add a system, turn it
 * on here too.
 */
const config = makeSimConfig({
  obstacleCount: 3,
  pickupCount: 4,
  arenaHalfExtentX: 10,
  phases: { enabled: true, minPlayers: 1, countdownTicks: 10, playTicks: 600 },
  teams: { count: 2 },
  combat: { enabled: true, maxHp: 3, lives: 2 },
  projectiles: { enabled: true, cooldownTicks: 4 },
  tag: { enabled: true },
  ball: { enabled: true },
  // Cars, a circuit and the racing rules. The combination is nonsense as a
  // game — that is fine and rather the point: this config exists to make every
  // system write state, not to be playable.
  vehicle: { enabled: true },
  track: { enabled: true, halfWidth: 2 },
  trackPath: [
    { x: 0, z: -6 },
    { x: 7, z: -6 },
    { x: 7, z: 6 },
    { x: -7, z: 6 },
    { x: -7, z: -6 },
  ],
  race: { enabled: true, tyreStintTicks: 300, drsGapSeconds: 1 },
  zones: [
    { kind: 'hill', x: 0, z: 0, radius: 3, team: -1, order: 0 },
    { kind: 'goal', x: -8, z: 0, radius: 2, team: 0, order: 0 },
    { kind: 'checkpoint', x: 0, z: -6, radius: 3, team: -1, order: 0 },
    { kind: 'checkpoint', x: 0, z: 6, radius: 3, team: -1, order: 1 },
    { kind: 'drs', x: 4, z: -6, radius: 2, team: -1, order: 0 },
    { kind: 'pit', x: 0, z: -1, radius: 2, team: -1, order: 0 },
  ],
  items: [{ kind: 'crown', homeX: 3, homeZ: 3, team: -1 }],
  pickupWeights: { score: 0.5, speed: 0.2, shield: 0.2, heal: 0.1 },
});

function makeWorld(seed = 31): World {
  return new World({ seed, config });
}

function busyWorld(seed = 31): World {
  const world = makeWorld(seed);
  world.addPlayer('alice', profile);
  world.addPlayer('bob', { name: 'bob', color: '#f72585' });
  world.addBot();
  world.setInput('alice', { seq: 3, moveX: 1, moveZ: 0.4, sprint: true, buttons: 1 });
  world.setInput('bob', { seq: 2, moveX: -0.5, moveZ: 1, sprint: false, buttons: 0 });
  // Long enough to leave the countdown, fire projectiles, tag someone and
  // touch the ball — the snapshot should be full of in-flight state.
  world.stepMany(80);
  return world;
}

describe('World snapshots', () => {
  it('round-trips into a fresh world exactly', () => {
    // This is the guard rail for the whole netcode: if a mutable field is
    // added to the world but not to WorldSnapshot, this test fails. Do not
    // weaken it — loosen the assertion and desyncs become silent.
    const source = busyWorld();
    const snapshot = source.snapshot();

    const restored = makeWorld();
    restored.applySnapshot(snapshot);

    expect(restored.checksum()).toBe(source.checksum());
    expect(restored.snapshot()).toEqual(snapshot);
  });

  it('keeps simulating identically after a restore', () => {
    const source = busyWorld();
    const restored = makeWorld();
    restored.applySnapshot(source.snapshot());

    for (const world of [source, restored]) {
      world.setInput('alice', { seq: 99, moveX: 0.2, moveZ: -1, sprint: false, buttons: 0 });
      world.stepMany(30);
    }

    expect(restored.checksum()).toBe(source.checksum());
  });

  it('returns a deep copy, not live references', () => {
    const world = busyWorld();
    const snapshot = world.snapshot();
    const before = snapshot.players[0]?.x;

    world.stepMany(10);

    expect(snapshot.players[0]?.x).toBe(before);
  });

  it('adds players present only in the snapshot', () => {
    const source = busyWorld();
    const target = makeWorld();
    const joined = vi.fn();
    target.events.on('playerJoined', joined);

    target.applySnapshot(source.snapshot());

    expect(target.players().map((p) => p.id)).toEqual(['alice', 'bob', 'zz-bot-1']);
    expect(joined).toHaveBeenCalledTimes(3);
  });

  it('removes players absent from the snapshot', () => {
    const target = busyWorld();
    const left = vi.fn();
    target.events.on('playerLeft', left);

    const trimmed: WorldSnapshot = target.snapshot();
    trimmed.players = trimmed.players.filter((p) => p.id !== 'bob');
    target.applySnapshot(trimmed);

    expect(target.hasPlayer('bob')).toBe(false);
    expect(left).toHaveBeenCalledWith({ playerId: 'bob' });
  });

  it('restores the RNG stream position', () => {
    const source = busyWorld();
    const snapshot = source.snapshot();
    const restored = makeWorld();
    restored.applySnapshot(snapshot);

    // Pickup respawns draw from the RNG; identical positions afterwards only
    // happen if the stream position was carried across.
    source.stepMany(200);
    restored.stepMany(200);

    expect(restored.checksum()).toBe(source.checksum());
  });
});

describe('World checksum', () => {
  it('differs when state differs', () => {
    const a = busyWorld();
    const b = busyWorld();
    expect(a.checksum()).toBe(b.checksum());

    b.stepMany(1);
    expect(a.checksum()).not.toBe(b.checksum());
  });

  it('is insensitive to player insertion order', () => {
    const a = makeWorld();
    a.addPlayer('alice', profile);
    a.addPlayer('bob', profile);

    const b = makeWorld();
    b.addPlayer('bob', profile);
    b.addPlayer('alice', profile);

    // Spawn slots and team assignments are handed out in join order, so they
    // differ; align them before comparing, and the checksum should agree.
    for (const world of [a, b]) {
      const alice = world.getPlayer('alice');
      const bob = world.getPlayer('bob');
      if (alice) Object.assign(alice, { x: 1, z: 2, vx: 0, vz: 0, team: 0 });
      if (bob) Object.assign(bob, { x: 3, z: 4, vx: 0, vz: 0, team: 1 });
    }

    expect(a.checksum()).toBe(b.checksum());
  });
});
