import { describe, expect, it } from 'vitest';
import { GAME_MODE_IDS, modeConfig } from '@/sim/presets.js';
import {
  TYRE_STACK_RADIUS,
  createTyreStacks,
  resetTyreStacks,
  tyreStackSpots,
  updateTyreStacks,
} from '@/sim/systems/tyrestacks.js';
import { sampleTrack } from '@/sim/track.js';
import { makePlayer, makeStepContext } from '../../helpers/factories.js';
import { makeSimConfig, type SimConfigOverrides } from '@/sim/config.js';

/**
 * The tyre stacks as bodies: where they stand, and what a hit does.
 *
 * Placement mirrors what the old scenery drew — outside of corners, inside
 * the barrier line — but now a wrong position is worse than odd-looking: it
 * is a collider on the racing line. The physics half pins the asymmetry the
 * feature exists for (light stack, heavy car) and the housekeeping that
 * keeps a wall a wall (friction to a dead stop, round resets).
 */

/** A small closed circuit with four real corners, like the snapshot test's. */
const CIRCUIT: SimConfigOverrides = {
  track: { enabled: true, halfWidth: 2 },
  trackPath: [
    { x: 0, z: -12 },
    { x: 14, z: -12 },
    { x: 14, z: 12 },
    { x: -14, z: 12 },
    { x: -14, z: -12 },
  ],
};

describe('tyre stack placement', () => {
  it('lines the corners of a real circuit, deterministically', () => {
    const config = modeConfig('grandprix');
    const spots = tyreStackSpots(config);
    expect(spots.length).toBeGreaterThan(10);
    expect(tyreStackSpots(config)).toEqual(spots);
  });

  it('keeps every stack off the road', () => {
    const config = modeConfig('grandprix');
    for (const spot of tyreStackSpots(config)) {
      const lateral = sampleTrack(config.trackPath, spot.x, spot.z).lateral;
      expect(lateral).toBeGreaterThan(config.track.halfWidth + TYRE_STACK_RADIUS);
    }
  });

  it('places nothing when there is no circuit', () => {
    expect(createTyreStacks(makeSimConfig({}))).toEqual([]);
  });

  it('stays under the protocol ceiling on every registered mode', () => {
    // The wire validator rejects snapshots with more than 512 stacks as
    // hostile. A circuit that legitimately produced more would make every
    // client drop every snapshot — so the two limits meet here, where adding
    // an over-long circuit fails a test instead of silently killing a lobby.
    for (const id of GAME_MODE_IDS) {
      expect(tyreStackSpots(modeConfig(id)).length).toBeLessThanOrEqual(512);
    }
  });
});

describe('a car hitting a stack', () => {
  function collide() {
    const config = makeSimConfig(CIRCUIT);
    const stacks = createTyreStacks(config);
    const stack = stacks[0];
    if (!stack) throw new Error('circuit produced no stacks');

    // Park the car overlapping the stack, closing at speed along +x.
    const player = makePlayer({
      id: 'car',
      x: stack.x - (config.playerRadius + TYRE_STACK_RADIUS) * 0.8,
      z: stack.z,
      vx: 20,
      vz: 0,
    });
    const ctx = makeStepContext({
      config: CIRCUIT,
      players: [player],
      ctx: { tyreStacks: stacks },
    });
    updateTyreStacks(ctx);
    return { player, stack, stacks, config };
  }

  it('sends the wall flying and only thumps the car', () => {
    const { player, stacks } = collide();
    // The struck stack may hand its speed straight down the wall — the
    // neighbours are within one tick's travel — so the honest measure is the
    // whole wall's momentum, not the first stack's.
    const wallSpeed = stacks.reduce((sum, s) => sum + s.vx, 0);
    expect(wallSpeed).toBeGreaterThan(15);
    // The car keeps most of its speed: a thump, not a bollard. And because
    // the stacks are light, the wall gains far more speed than the car shed.
    expect(player.vx).toBeLessThan(20);
    expect(player.vx).toBeGreaterThan(12);
    expect(wallSpeed).toBeGreaterThan((20 - player.vx) * 2);
  });

  it('separates the two so the contact does not repeat for free', () => {
    const { player, stack, config } = collide();
    const gap = Math.hypot(stack.x - player.x, stack.z - player.z);
    expect(gap).toBeGreaterThanOrEqual(config.playerRadius + TYRE_STACK_RADIUS - 1e-9);
  });
});

describe('a loose stack', () => {
  it('grinds to a complete stop, exactly', () => {
    const config = makeSimConfig(CIRCUIT);
    const stacks = createTyreStacks(config);
    const stack = stacks[0];
    if (!stack) throw new Error('circuit produced no stacks');
    stack.vx = 8;
    stack.vz = -3;

    const ctx = makeStepContext({ config: CIRCUIT, ctx: { tyreStacks: stacks } });
    for (let i = 0; i < 400; i++) updateTyreStacks(ctx);

    // Exact zero, not merely small: the sleep threshold is what keeps a
    // parked wall out of the checksum noise and cheap on the wire.
    expect(stack.vx).toBe(0);
    expect(stack.vz).toBe(0);
  });

  it('shoves its neighbours, so one hit scatters the wall', () => {
    const stacks = [
      { x: 0, z: 0, vx: 6, vz: 0 },
      { x: TYRE_STACK_RADIUS * 1.9, z: 0, vx: 0, vz: 0 },
    ];
    const ctx = makeStepContext({ config: CIRCUIT, ctx: { tyreStacks: stacks } });
    updateTyreStacks(ctx);
    expect(stacks[1]!.vx).toBeGreaterThan(0);
    const gap = Math.hypot(stacks[1]!.x - stacks[0]!.x, stacks[1]!.z - stacks[0]!.z);
    expect(gap).toBeGreaterThanOrEqual(TYRE_STACK_RADIUS * 2 - 1e-9);
  });
});

describe('the round reset', () => {
  it('stands the wall back up on its home spots', () => {
    const config = makeSimConfig(CIRCUIT);
    const stacks = createTyreStacks(config);
    const spots = tyreStackSpots(config);
    const stack = stacks[0];
    if (!stack) throw new Error('circuit produced no stacks');
    stack.x += 5;
    stack.z -= 3;
    stack.vx = 2;

    const ctx = makeStepContext({ config: CIRCUIT, ctx: { tyreStacks: stacks } });
    resetTyreStacks(ctx);

    expect(stack.x).toBe(spots[0]!.x);
    expect(stack.z).toBe(spots[0]!.z);
    expect(stack.vx).toBe(0);
    expect(stack.vz).toBe(0);
  });
});
