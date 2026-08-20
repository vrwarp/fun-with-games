import { describe, expect, it } from 'vitest';
import { makeSimConfig } from '@/sim/config.js';
import { modeConfig } from '@/sim/presets.js';
import { ROLE_IT } from '@/sim/types.js';
import { World } from '@/sim/world.js';

const profile = { name: 'p', color: '#4cc9f0' };

describe('bots: lifecycle', () => {
  it('adds bots up to the configured cap, then refuses', () => {
    const world = new World({
      seed: 1,
      config: makeSimConfig({ pickupCount: 0, bots: { maxCount: 2 } }),
    });

    expect(world.addBot()).not.toBeNull();
    expect(world.addBot()).not.toBeNull();
    expect(world.addBot()).toBeNull();
    expect(world.bots()).toHaveLength(2);

    expect(world.removeBot()).toBe(true);
    expect(world.bots()).toHaveLength(1);
  });

  it('gives bots ids that sort after realistic peer ids', () => {
    const world = new World({ seed: 1, config: makeSimConfig({ pickupCount: 0 }) });
    const bot = world.addBot()!;
    // Trystero peer ids are alphanumeric; 'zz-' sorts after all of them, so a
    // bot can never look like the lowest peer id (the would-be host).
    expect(bot.id > 'zfffffffffffffff').toBe(true);
    expect(bot.isBot).toBe(true);
  });
});

describe('bots: behaviour', () => {
  it('seeks pickups in gather mode', () => {
    const world = new World({
      seed: 9,
      config: makeSimConfig({ obstacleCount: 0, pickupCount: 5 }),
    });
    const bot = world.addBot()!;
    const start = { x: bot.x, z: bot.z };

    world.stepMany(120);

    // It moved with purpose, and with pickups everywhere it collects some.
    const travelled = Math.hypot(bot.x - start.x, bot.z - start.z);
    const collected = bot.score > 0;
    expect(travelled).toBeGreaterThan(1);
    expect(collected || world.pickups().some((p) => !p.active)).toBe(true);
  });

  function tagSetup(): {
    world: World;
    human: ReturnType<World['addPlayer']>;
    bot: ReturnType<World['addPlayer']>;
  } {
    const world = new World({
      seed: 9,
      config: makeSimConfig({
        obstacleCount: 0,
        pickupCount: 0,
        arenaHalfExtentX: 30,
        arenaHalfExtentZ: 30,
        tag: { enabled: true },
      }),
    });
    const human = world.addPlayer('aa-human', profile);
    const bot = world.addBot()!;
    world.step(); // let the system assign roles once, then force them below
    return { world, human, bot };
  }

  it('flees the it player in tag mode', () => {
    const { world, human, bot } = tagSetup();
    for (const player of world.players()) player.role = 0;
    human.role = ROLE_IT; // the stationary human is it; the bot must run
    Object.assign(human, { x: -2, z: 0, vx: 0, vz: 0 });
    Object.assign(bot, { x: 4, z: 0, vx: 0, vz: 0 });

    const gapBefore = Math.hypot(human.x - bot.x, human.z - bot.z);
    world.stepMany(30);
    const gapAfter = Math.hypot(human.x - bot.x, human.z - bot.z);
    expect(gapAfter).toBeGreaterThan(gapBefore);
  });

  it('chases prey as the it player in tag mode', () => {
    const { world, human, bot } = tagSetup();
    for (const player of world.players()) player.role = 0;
    bot.role = ROLE_IT;
    Object.assign(human, { x: -2, z: 0, vx: 0, vz: 0 });
    Object.assign(bot, { x: 4, z: 0, vx: 0, vz: 0 });

    const gapBefore = Math.hypot(human.x - bot.x, human.z - bot.z);
    world.stepMany(10); // short: long enough to close in, not to tag
    const gapAfter = Math.hypot(human.x - bot.x, human.z - bot.z);
    expect(gapAfter).toBeLessThan(gapBefore);
  });

  it('fires at enemies in arena mode', () => {
    const world = new World({ seed: 2, config: modeConfig('arena') });
    const target = world.addPlayer('aa-human', profile);
    const bot = world.addBot()!;
    // Arena preset needs 2 players; run the countdown out first.
    world.stepMany(world.config.phases.countdownTicks + 5);

    Object.assign(target, { x: 0, z: 0, vx: 0, vz: 0 });
    Object.assign(bot, { x: 0, z: 6, vx: 0, vz: 0, heading: Math.PI }); // facing -Z
    world.stepMany(40);

    expect(target.hp).toBeLessThan(world.config.combat.maxHp);
  });

  it('keeps two identical worlds identical (no hidden randomness)', () => {
    const build = (): World => {
      const world = new World({ seed: 77, config: modeConfig('tag') });
      world.addPlayer('aa-human', profile);
      world.addBot();
      world.addBot();
      return world;
    };

    const a = build();
    const b = build();
    a.stepMany(400);
    b.stepMany(400);

    expect(a.checksum()).toBe(b.checksum());
  });
});
