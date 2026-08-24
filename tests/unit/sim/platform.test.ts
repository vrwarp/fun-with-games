import { describe, expect, it } from 'vitest';
import { makeSimConfig, tickDeltaSeconds, type SimConfigOverrides } from '@/sim/config.js';
import { ceilingAbove, supportHeight } from '@/sim/systems/arena.js';
import { integratePlayer, resolvePlayerCollisions } from '@/sim/systems/movement.js';
import { BUTTON_PRIMARY, type Obstacle } from '@/sim/types.js';
import { makeInput as input, makeObstacle, makePlayer } from '../../helpers/factories.js';

function platformConfig(overrides: SimConfigOverrides = {}) {
  return makeSimConfig({
    arenaHalfExtentX: 50,
    arenaHalfExtentZ: 50,
    ...overrides,
    platform: { enabled: true, gravity: 30, jumpVelocity: 10, maxJumps: 2, ...overrides.platform },
  });
}

const config = platformConfig();
const dt = tickDeltaSeconds(config);

/** Runs `ticks` steps, optionally varying the input per tick. */
function run(
  player: ReturnType<typeof makePlayer>,
  ticks: number,
  obstacles: readonly Obstacle[],
  makeTick: (i: number) => Parameters<typeof integratePlayer>[1] = (i) => input({ seq: i + 1 }),
  cfg = config,
): void {
  for (let i = 0; i < ticks; i++) {
    integratePlayer(player, makeTick(i), cfg, obstacles, dt, i);
  }
}

describe('geometry queries', () => {
  const ledge = makeObstacle({ id: 1, x: 0, z: 0, halfX: 2, halfZ: 2, baseY: 3, top: 4 });

  it('finds the floor when nothing else is below', () => {
    expect(supportHeight(20, 20, 0.5, [ledge], Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('finds a platform top the player is above', () => {
    expect(supportHeight(0, 0, 0.5, [ledge], 10)).toBe(4);
  });

  it('ignores a platform above the search ceiling', () => {
    // Standing under the ledge: it is not something you can land on from here.
    expect(supportHeight(0, 0, 0.5, [ledge], 1)).toBe(0);
  });

  it('reports the underside of a platform overhead', () => {
    expect(ceilingAbove(0, 0, 0.5, [ledge], 0)).toBe(3);
    expect(ceilingAbove(20, 20, 0.5, [ledge], 0)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('gravity and landing', () => {
  it('is inert when the platform system is off', () => {
    const flat = makeSimConfig({ arenaHalfExtentX: 50 });
    const player = makePlayer({ y: 5 });
    for (let i = 0; i < 60; i++) {
      integratePlayer(player, input({ seq: i }), flat, [], dt, i);
    }
    expect(player.y).toBe(5);
    expect(player.vy).toBe(0);
  });

  it('falls to the floor and stops there', () => {
    const player = makePlayer({ y: 12 });
    run(player, 90, []);

    expect(player.y).toBe(0);
    expect(player.vy).toBe(0);
    expect(player.grounded).toBe(true);
  });

  it('lands on top of a platform instead of passing through', () => {
    const ledge = makeObstacle({ id: 1, x: 0, z: 0, halfX: 3, halfZ: 3, baseY: 0, top: 4 });
    const player = makePlayer({ y: 12 });
    run(player, 90, [ledge]);

    expect(player.y).toBeCloseTo(4, 6);
    expect(player.grounded).toBe(true);
  });

  it('caps fall speed at terminal velocity', () => {
    const player = makePlayer({ y: 5000 });
    run(player, 600, []);
    expect(Math.abs(player.vy)).toBeLessThanOrEqual(config.platform.terminalVelocity + 1e-6);
  });
});

describe('jumping', () => {
  const held = () => input({ buttons: BUTTON_PRIMARY });

  it('leaves the ground on the button press', () => {
    const player = makePlayer();
    integratePlayer(player, held(), config, [], dt, 0);

    expect(player.vy).toBeGreaterThan(0);
    expect(player.grounded).toBe(false);
    expect(player.jumps).toBe(1);
  });

  it('does not bunny-hop while the button stays held', () => {
    const player = makePlayer();
    // Hold through the whole arc: two jumps max, and the second only because
    // maxJumps allows a double — never a third from one continuous press.
    run(player, 120, [], held);

    expect(player.jumps).toBeLessThanOrEqual(config.platform.maxJumps);
    // Ends back on the floor rather than hovering upward forever.
    expect(player.y).toBe(0);
  });

  it('double jumps on a second press, then refuses a third', () => {
    const player = makePlayer();
    // press, release, press, release, press…
    run(player, 30, [], (i) => input({ seq: i + 1, buttons: i % 2 === 0 ? BUTTON_PRIMARY : 0 }));

    expect(player.jumps).toBe(2);
  });

  it('refills jumps on landing', () => {
    const player = makePlayer();
    run(player, 4, [], held);
    expect(player.jumps).toBe(1);

    run(player, 90, [], () => input({ buttons: 0 }));
    expect(player.grounded).toBe(true);
    expect(player.jumps).toBe(0);
  });

  it('cannot jump while frozen', () => {
    const player = makePlayer({ effects: { frozen: 100 } });
    integratePlayer(player, held(), config, [], dt, 0);

    expect(player.jumps).toBe(0);
    expect(player.vy).toBeLessThanOrEqual(0);
  });

  it('clears the height the platformer level is authored around', () => {
    // `docs/RECIPES.md` tells authors a single jump clears roughly
    // v² / 2g units. If tuning ever breaks that relationship the shipped
    // level silently becomes unjumpable, so pin it here instead of finding
    // out mid-demo.
    const player = makePlayer();
    let peak = 0;
    for (let i = 0; i < 60; i++) {
      integratePlayer(
        player,
        input({ seq: i + 1, buttons: i === 0 ? BUTTON_PRIMARY : 0 }),
        config,
        [],
        dt,
        i,
      );
      peak = Math.max(peak, player.y);
    }

    const theoretical =
      (config.platform.jumpVelocity * config.platform.jumpVelocity) / (2 * config.platform.gravity);
    expect(peak).toBeGreaterThan(theoretical * 0.85);
    expect(player.y).toBe(0); // and comes back down
  });
});

describe('platforms as geometry', () => {
  it('walks underneath a floating platform without being blocked', () => {
    const overhead = makeObstacle({ id: 1, x: 4, z: 0, halfX: 2, halfZ: 4, baseY: 3, top: 4 });
    const player = makePlayer({ x: 0, z: 0 });
    run(player, 90, [overhead], (i) => input({ seq: i + 1, moveX: 1 }));

    // Passed clean through the space beneath it.
    expect(player.x).toBeGreaterThan(6);
    expect(player.y).toBe(0);
  });

  it('is still blocked by a ground-level wall', () => {
    const wall = makeObstacle({ id: 1, x: 4, z: 0, halfX: 1, halfZ: 4, baseY: 0, top: 3 });
    const player = makePlayer({ x: 0, z: 0 });
    run(player, 90, [wall], (i) => input({ seq: i + 1, moveX: 1 }));

    expect(player.x).toBeLessThan(4 - 1);
  });

  it('bonks its head on an overhead platform instead of clipping through', () => {
    const overhead = makeObstacle({ id: 1, x: 0, z: 0, halfX: 3, halfZ: 3, baseY: 3, top: 4 });
    const player = makePlayer();
    run(player, 20, [overhead], (i) =>
      input({ seq: i + 1, buttons: i === 0 ? BUTTON_PRIMARY : 0 }),
    );

    // Head never crosses the underside.
    expect(player.y + config.playerHeight).toBeLessThanOrEqual(3 + 1e-6);
  });
});

describe('side-scroller lock', () => {
  const sideConfig = platformConfig({ platform: { lockZ: true } });

  it('ignores depth input and pins the lane', () => {
    const player = makePlayer({ z: 4 });
    for (let i = 0; i < 30; i++) {
      integratePlayer(player, input({ seq: i + 1, moveX: 1, moveZ: 1 }), sideConfig, [], dt, i);
    }

    expect(player.z).toBe(0);
    expect(player.vz).toBe(0);
    expect(player.x).toBeGreaterThan(0);
  });
});

describe('players on different floors', () => {
  it('do not push each other', () => {
    const cfg = platformConfig();
    const lower = makePlayer({ id: 'a', x: 0, z: 0, y: 0 });
    const upper = makePlayer({ id: 'b', x: 0, z: 0, y: 6 });

    resolvePlayerCollisions([lower, upper], cfg, 0);

    expect(lower.x).toBe(0);
    expect(upper.x).toBe(0);
  });

  it('still collide when sharing a height', () => {
    const cfg = platformConfig();
    const a = makePlayer({ id: 'a', x: 0, z: 0, y: 4 });
    const b = makePlayer({ id: 'b', x: 0.2, z: 0, y: 4 });

    resolvePlayerCollisions([a, b], cfg, 0);

    expect(Math.abs(b.x - a.x)).toBeGreaterThanOrEqual(cfg.playerRadius * 2 - 1e-6);
  });
});
