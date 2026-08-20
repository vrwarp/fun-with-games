import { describe, expect, it } from 'vitest';
import { makeSimConfig, type SimConfigOverrides } from '@/sim/config.js';
import { hasEffect } from '@/sim/systems/effects.js';
import { BUTTON_PRIMARY } from '@/sim/types.js';
import { World } from '@/sim/world.js';

const profile = { name: 'p', color: '#4cc9f0' };

function arenaWorld(overrides: SimConfigOverrides = {}): World {
  return new World({
    seed: 3,
    config: makeSimConfig({
      obstacleCount: 0,
      pickupCount: 0,
      arenaHalfExtentX: 30,
      arenaHalfExtentZ: 30,
      combat: { enabled: true, maxHp: 2, respawnTicks: 30 },
      projectiles: { enabled: true, cooldownTicks: 10, speed: 15, lifetimeTicks: 40 },
      ...overrides,
    }),
  });
}

/** Puts `id` at (x, z) facing +Z, all velocity cleared. */
function place(world: World, id: string, x: number, z: number, heading = 0): void {
  const player = world.getPlayer(id);
  if (!player) throw new Error(`no player ${id}`);
  Object.assign(player, { x, z, vx: 0, vz: 0, heading });
}

describe('projectiles: firing', () => {
  it('fires while the primary button is held, then reloads', () => {
    const world = arenaWorld();
    world.addPlayer('a', profile);
    place(world, 'a', 0, 0);
    world.setInput('a', { seq: 1, moveX: 0, moveZ: 0, sprint: false, buttons: BUTTON_PRIMARY });

    world.step();
    expect(world.projectiles()).toHaveLength(1);
    expect(hasEffect(world.getPlayer('a')!, 'reload', world.tick)).toBe(true);

    // Held button during cooldown must NOT fire again.
    world.stepMany(5);
    expect(world.projectiles().length).toBeLessThanOrEqual(1);
  });

  it('fires along the player heading', () => {
    const world = arenaWorld();
    world.addPlayer('a', profile);
    place(world, 'a', 0, 0, Math.PI / 2); // facing +X
    world.setInput('a', { seq: 1, moveX: 0, moveZ: 0, sprint: false, buttons: BUTTON_PRIMARY });

    world.step();
    const projectile = world.projectiles()[0];
    expect(projectile).toBeDefined();
    expect(projectile!.vx).toBeGreaterThan(10);
    expect(Math.abs(projectile!.vz)).toBeLessThan(1e-9);
  });

  it('does not fire while knocked out', () => {
    const world = arenaWorld();
    const a = world.addPlayer('a', profile);
    a.effects = { ko: 1000 };
    world.setInput('a', { seq: 1, moveX: 0, moveZ: 0, sprint: false, buttons: BUTTON_PRIMARY });

    world.step();
    expect(world.projectiles()).toHaveLength(0);
  });
});

describe('projectiles: flight and hits', () => {
  it('expires at end of lifetime', () => {
    const world = arenaWorld();
    world.addPlayer('a', profile);
    place(world, 'a', -25, -25);
    world.setInput('a', { seq: 1, moveX: 0, moveZ: 0, sprint: false, buttons: BUTTON_PRIMARY });
    world.step();
    world.setInput('a', { seq: 2, moveX: 0, moveZ: 0, sprint: false, buttons: 0 });

    world.stepMany(45);
    expect(world.projectiles()).toHaveLength(0);
  });

  it('is absorbed by obstacles', () => {
    const blocked = new World({
      seed: 3,
      config: makeSimConfig({
        obstacleCount: 1,
        obstacleMinHalfExtent: 3,
        obstacleMaxHalfExtent: 3,
        pickupCount: 0,
        arenaHalfExtentX: 30,
        arenaHalfExtentZ: 30,
        projectiles: { enabled: true, lifetimeTicks: 200 },
      }),
    });
    const obstacle = blocked.obstacles[0];
    expect(obstacle).toBeDefined();

    // Fire in +X straight at the obstacle centre from just outside it.
    blocked.addPlayer('a', profile);
    const player = blocked.getPlayer('a')!;
    Object.assign(player, {
      x: obstacle!.x - 8,
      z: obstacle!.z,
      vx: 0,
      vz: 0,
      heading: Math.PI / 2,
    });
    blocked.setInput('a', { seq: 1, moveX: 0, moveZ: 0, sprint: false, buttons: BUTTON_PRIMARY });
    blocked.step();
    expect(blocked.projectiles()).toHaveLength(1);

    blocked.setInput('a', { seq: 2, moveX: 0, moveZ: 0, sprint: false, buttons: 0 });
    blocked.stepMany(30);
    expect(blocked.projectiles()).toHaveLength(0);
  });

  it('damages and knocks back the player it hits', () => {
    const world = arenaWorld();
    world.addPlayer('a', profile);
    world.addPlayer('b', profile);
    place(world, 'a', 0, 0); // facing +Z
    place(world, 'b', 0, 5);
    world.setInput('a', { seq: 1, moveX: 0, moveZ: 0, sprint: false, buttons: BUTTON_PRIMARY });

    world.step();
    world.setInput('a', { seq: 2, moveX: 0, moveZ: 0, sprint: false, buttons: 0 });
    world.stepMany(12);

    const b = world.getPlayer('b')!;
    expect(b.hp).toBe(1);
    expect(b.z).toBeGreaterThan(5); // pushed away from the shooter
    expect(world.projectiles()).toHaveLength(0); // consumed by the hit
  });

  it('never hits its owner and never hits teammates', () => {
    const world = arenaWorld({ teams: { count: 2 } });
    world.addPlayer('a', profile); // team 0
    world.addPlayer('c', profile); // team 1
    world.addPlayer('b', profile); // team 0 — sorted order a,b,c; joins decide teams
    const a = world.getPlayer('a')!;
    const b = world.getPlayer('b')!;
    expect(a.team).toBe(0);
    expect(b.team).toBe(0);

    place(world, 'a', 0, 0);
    place(world, 'b', 0, 5); // teammate directly in the line of fire
    place(world, 'c', 25, 25); // enemy far away
    world.setInput('a', { seq: 1, moveX: 0, moveZ: 0, sprint: false, buttons: BUTTON_PRIMARY });

    world.step();
    world.setInput('a', { seq: 2, moveX: 0, moveZ: 0, sprint: false, buttons: 0 });
    world.stepMany(10);

    expect(b.hp).toBe(2); // untouched
  });

  it('KOs through zero hp and credits the shooter', () => {
    const world = arenaWorld({ combat: { enabled: true, maxHp: 1, koScore: 1 } });
    world.addPlayer('a', profile);
    world.addPlayer('b', profile);
    place(world, 'a', 0, 0);
    place(world, 'b', 0, 5);
    world.setInput('a', { seq: 1, moveX: 0, moveZ: 0, sprint: false, buttons: BUTTON_PRIMARY });

    world.step();
    world.setInput('a', { seq: 2, moveX: 0, moveZ: 0, sprint: false, buttons: 0 });
    world.stepMany(12);

    expect(hasEffect(world.getPlayer('b')!, 'ko', world.tick)).toBe(true);
    expect(world.getPlayer('a')!.score).toBe(1);
  });
});
