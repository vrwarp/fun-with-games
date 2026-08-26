import { describe, expect, it } from 'vitest';
import { GAME_MODE_IDS, modeConfig } from '@/sim/presets.js';
import {
  TYRES_PER_STACK,
  TYRE_RADIUS,
  createTyres,
  resetTyres,
  tyreStackSpots,
  updateTyres,
} from '@/sim/systems/tyrestacks.js';
import { sampleTrack } from '@/sim/track.js';
import { makePlayer, makeStepContext } from '../../helpers/factories.js';
import { makeSimConfig, type SimConfigOverrides } from '@/sim/config.js';
import type { TyreState } from '@/sim/types.js';

/**
 * The tyre walls as per-tyre bodies: where they stand, and what a hit does.
 *
 * Placement mirrors what the old scenery drew — outside of corners, inside
 * the barrier line — but a wrong position is now a collider on the racing
 * line. The physics half pins two properties the feature exists for: the
 * mass asymmetry (light tyres, heavy car), and the BURST — one hit must give
 * a standing stack's three coincident tyres three different velocities, or
 * the stack flies off in formation and still reads as a welded unit.
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

describe('tyre placement', () => {
  it('lines the corners of a real circuit, three tyres per spot', () => {
    const config = modeConfig('grandprix');
    const spots = tyreStackSpots(config);
    const tyres = createTyres(config);
    expect(spots.length).toBeGreaterThan(10);
    expect(tyres.length).toBe(spots.length * TYRES_PER_STACK);
    // Stack-major: each spot's three tyres start coincident on it.
    spots.forEach((spot, stack) => {
      for (let tier = 0; tier < TYRES_PER_STACK; tier++) {
        const tyre = tyres[stack * TYRES_PER_STACK + tier];
        expect(tyre?.x).toBe(spot.x);
        expect(tyre?.z).toBe(spot.z);
      }
    });
  });

  it('keeps every stack off the road', () => {
    const config = modeConfig('grandprix');
    for (const spot of tyreStackSpots(config)) {
      const lateral = sampleTrack(config.trackPath, spot.x, spot.z).lateral;
      expect(lateral).toBeGreaterThan(config.track.halfWidth + TYRE_RADIUS);
    }
  });

  it('places nothing when there is no circuit', () => {
    expect(createTyres(makeSimConfig({}))).toEqual([]);
  });

  it('stays under the protocol ceiling on every registered mode', () => {
    // The wire validator rejects snapshots with more than 768 tyres as
    // hostile. A circuit that legitimately produced more would make every
    // client drop every snapshot — so the two limits meet here, where adding
    // an over-long circuit fails a test instead of silently killing a lobby.
    for (const id of GAME_MODE_IDS) {
      expect(tyreStackSpots(modeConfig(id)).length * TYRES_PER_STACK).toBeLessThanOrEqual(768);
    }
  });
});

describe('a car hitting a stack', () => {
  function collide() {
    const config = makeSimConfig(CIRCUIT);
    const tyres = createTyres(config);
    const first = tyres[0];
    if (!first) throw new Error('circuit produced no tyres');

    // Park the car overlapping the stack, closing at speed along +x.
    const player = makePlayer({
      id: 'car',
      x: first.x - (config.playerRadius + TYRE_RADIUS) * 0.8,
      z: first.z,
      vx: 20,
      vz: 0,
    });
    const ctx = makeStepContext({
      config: CIRCUIT,
      players: [player],
      ctx: { tyres },
    });
    updateTyres(ctx);
    return { player, tyres, config };
  }

  it('bursts the stack: three tyres, three different velocities', () => {
    const { tyres } = collide();
    const stack = tyres.slice(0, TYRES_PER_STACK);
    const headings = stack.map((tyre) => Math.atan2(tyre.vx, tyre.vz));
    const speeds = stack.map((tyre) => Math.hypot(tyre.vx, tyre.vz));
    // Every tyre moves, no two alike — in direction AND in speed. Identical
    // kicks would launch the stack in formation, which is the welded-unit
    // look this rework exists to kill.
    for (const speed of speeds) expect(speed).toBeGreaterThan(3);
    expect(new Set(headings.map((h) => h.toFixed(3))).size).toBe(TYRES_PER_STACK);
    expect(new Set(speeds.map((s) => s.toFixed(2))).size).toBe(TYRES_PER_STACK);
  });

  it('costs the car a thump and no more', () => {
    const { player, tyres } = collide();
    const wallSpeed = tyres.reduce((sum, tyre) => sum + Math.hypot(tyre.vx, tyre.vz), 0);
    // The car keeps most of its speed while the light tyres carry far more
    // away than the car shed.
    expect(player.vx).toBeLessThan(20);
    expect(player.vx).toBeGreaterThan(12);
    expect(wallSpeed).toBeGreaterThan((20 - player.vx) * 2);
  });
});

describe('a loose tyre', () => {
  it('grinds to a complete stop, exactly', () => {
    const config = makeSimConfig(CIRCUIT);
    const tyres = createTyres(config);
    const tyre = tyres[0];
    if (!tyre) throw new Error('circuit produced no tyres');
    tyre.vx = 8;
    tyre.vz = -3;

    const ctx = makeStepContext({ config: CIRCUIT, ctx: { tyres } });
    for (let i = 0; i < 400; i++) updateTyres(ctx);

    // Exact zero, not merely small: the sleep threshold is what keeps a
    // parked wall out of the checksum noise and cheap on the wire.
    expect(tyre.vx).toBe(0);
    expect(tyre.vz).toBe(0);
  });

  it('shoves whatever it lands against, so one hit scatters a pile', () => {
    const tyres: TyreState[] = [
      { x: 0, z: 0, vx: 6, vz: 0 },
      { x: TYRE_RADIUS * 1.9, z: 0, vx: 0, vz: 0 },
    ];
    const ctx = makeStepContext({ config: CIRCUIT, ctx: { tyres } });
    updateTyres(ctx);
    expect(tyres[1]!.vx).toBeGreaterThan(0);
    const gap = Math.hypot(tyres[1]!.x - tyres[0]!.x, tyres[1]!.z - tyres[0]!.z);
    expect(gap).toBeGreaterThanOrEqual(TYRE_RADIUS * 2 - 1e-9);
  });

  it('never explodes a standing stack: coincident tyres ignore each other', () => {
    const config = makeSimConfig(CIRCUIT);
    const tyres = createTyres(config);
    const before = tyres.map((tyre) => ({ ...tyre }));
    const ctx = makeStepContext({ config: CIRCUIT, ctx: { tyres } });
    for (let i = 0; i < 20; i++) updateTyres(ctx);
    expect(tyres).toEqual(before);
  });
});

describe('the round reset', () => {
  it('restacks the wall on its home spots', () => {
    const config = makeSimConfig(CIRCUIT);
    const tyres = createTyres(config);
    const spots = tyreStackSpots(config);
    const tyre = tyres[TYRES_PER_STACK];
    if (!tyre) throw new Error('circuit produced no tyres');
    tyre.x += 5;
    tyre.z -= 3;
    tyre.vx = 2;

    const ctx = makeStepContext({ config: CIRCUIT, ctx: { tyres } });
    resetTyres(ctx);

    expect(tyre.x).toBe(spots[1]!.x);
    expect(tyre.z).toBe(spots[1]!.z);
    expect(tyre.vx).toBe(0);
    expect(tyre.vz).toBe(0);
  });
});
