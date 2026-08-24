import { describe, expect, it } from 'vitest';
import { makeSimConfig, type SimConfigOverrides } from '@/sim/config.js';
import { resolvePlayerCollisions } from '@/sim/systems/movement.js';
import type { PlayerState } from '@/sim/types.js';
import { makePlayer } from '../../helpers/factories.js';

/**
 * Contact between two bodies.
 *
 * Separation has always happened; what is new is that the mode can ask for the
 * velocity half as well. The two halves are tested apart, because every
 * non-racing mode still gets separation alone and that must not drift.
 */
function contactConfig(overrides: SimConfigOverrides = {}) {
  return makeSimConfig({
    playerRadius: 1,
    obstacleCount: 0,
    pickupCount: 0,
    ...overrides,
  });
}

/**
 * Two overlapping bodies on the x axis, `a` on the left. Ids are chosen so
 * that the array is already in the sorted order the resolver requires.
 */
function pair(a: Partial<PlayerState>, b: Partial<PlayerState>): [PlayerState, PlayerState] {
  return [
    makePlayer({ id: 'alpha', x: -0.9, z: 0, ...a }),
    makePlayer({ id: 'bravo', x: 0.9, z: 0, ...b }),
  ];
}

const momentum = (players: readonly PlayerState[]): { x: number; z: number } => ({
  x: players.reduce((sum, p) => sum + p.vx, 0),
  z: players.reduce((sum, p) => sum + p.vz, 0),
});

describe('contact without momentum exchange', () => {
  const config = contactConfig({ collision: { enabled: false } });

  it('pushes overlapping bodies apart', () => {
    const players = pair({}, {});
    resolvePlayerCollisions(players, config, 0);
    const gap = players[1].x - players[0].x;
    expect(gap).toBeCloseTo(2, 6);
  });

  it('leaves velocity completely alone', () => {
    // The historical contract, and the one every footrace mode still relies
    // on: you cannot shove a rival in `tag`.
    const players = pair({ vx: 8 }, { vx: 0 });
    resolvePlayerCollisions(players, config, 0);
    expect(players[0].vx).toBe(8);
    expect(players[1].vx).toBe(0);
  });
});

describe('contact with momentum exchange', () => {
  const config = contactConfig({
    collision: { enabled: true, restitution: 0, friction: 0, spin: 0 },
  });

  it('hands a rear-ender its victim, and keeps the total', () => {
    // A dead-inelastic hit: the pair leave at a common speed along the normal,
    // and nothing appears from nowhere.
    const players = pair({ vx: 10 }, { vx: 0 });
    const before = momentum(players);

    resolvePlayerCollisions(players, config, 0);

    expect(players[0].vx).toBeCloseTo(5, 6);
    expect(players[1].vx).toBeCloseTo(5, 6);
    expect(momentum(players).x).toBeCloseTo(before.x, 6);
  });

  it('bounces them apart when the surface is springy', () => {
    const springy = contactConfig({
      collision: { enabled: true, restitution: 1, friction: 0, spin: 0 },
    });
    const players = pair({ vx: 10 }, { vx: 0 });
    const before = momentum(players);

    resolvePlayerCollisions(players, springy, 0);

    // Perfectly elastic, equal masses: the velocities swap outright.
    expect(players[0].vx).toBeCloseTo(0, 6);
    expect(players[1].vx).toBeCloseTo(10, 6);
    expect(momentum(players).x).toBeCloseTo(before.x, 6);
  });

  it('ignores a pair that is already separating', () => {
    // Overlapping but flying apart: an impulse here would suck them back
    // together and the pair would buzz instead of parting.
    const players = pair({ vx: -4 }, { vx: 4 });
    resolvePlayerCollisions(players, config, 0);
    expect(players[0].vx).toBe(-4);
    expect(players[1].vx).toBe(4);
  });

  it('does not touch bodies that are not overlapping at all', () => {
    const players = pair({ x: -50, vx: 10 }, { x: 50 });
    resolvePlayerCollisions(players, config, 0);
    expect(players[0].vx).toBe(10);
    expect(players[1].vx).toBe(0);
  });
});

describe('side-by-side contact', () => {
  const config = contactConfig({
    collision: { enabled: true, restitution: 0, friction: 1, spin: 0 },
  });

  it('scrubs speed off a car rubbing along a slower one', () => {
    // Wheel to wheel down a straight: `a` is quicker, both are travelling
    // along +z, and they are touching across the x axis. The normal carries no
    // closing speed at all, so without friction this contact would be free.
    const players = pair({ vz: 20 }, { vz: 10 });
    resolvePlayerCollisions(players, config, 0);

    expect(players[0].vz).toBeLessThan(20);
    expect(players[1].vz).toBeGreaterThan(10);
    expect(momentum(players).z).toBeCloseTo(30, 6);
  });

  it('leaves them alone when the surfaces are frictionless', () => {
    const slippery = contactConfig({
      collision: { enabled: true, restitution: 0, friction: 0, spin: 0 },
    });
    const players = pair({ vz: 20 }, { vz: 10 });
    resolvePlayerCollisions(players, slippery, 0);

    expect(players[0].vz).toBe(20);
    expect(players[1].vz).toBe(10);
  });

  it('twists both cars in opposite directions', () => {
    // A scrape drags one flank and not the other, which is a torque. The two
    // must rotate opposite ways — a shared sign would mean the pair is being
    // spun by something outside the contact.
    const spinning = contactConfig({
      collision: { enabled: true, restitution: 0, friction: 1, spin: 0.05 },
    });
    const players = pair({ vz: 20, heading: 0 }, { vz: 10, heading: 0 });
    resolvePlayerCollisions(players, spinning, 0);

    expect(players[0].heading).not.toBe(0);
    expect(Math.sign(players[0].heading)).toBe(-Math.sign(players[1].heading));
  });

  it('does not twist a straight-on hit', () => {
    // The impulse runs through both centres, so there is no moment arm and no
    // reason for either car to rotate.
    const spinning = contactConfig({
      collision: { enabled: true, restitution: 0, friction: 1, spin: 0.05 },
    });
    const players = pair({ vx: 10, heading: 0 }, { vx: 0, heading: 0 });
    resolvePlayerCollisions(players, spinning, 0);

    expect(players[0].heading).toBeCloseTo(0, 10);
    expect(players[1].heading).toBeCloseTo(0, 10);
  });
});

describe('determinism', () => {
  it('resolves a pile-up identically however many times it is run', () => {
    // Three cars in a heap. The resolver is order-sensitive by construction
    // (float addition is not associative), so the guarantee is that the same
    // sorted input always produces the same output — that is what keeps host
    // and client from diverging after a first-corner shunt.
    const config = contactConfig({
      collision: { enabled: true, restitution: 0.2, friction: 0.35, spin: 0.02 },
    });
    const build = (): PlayerState[] => [
      makePlayer({ id: 'alpha', x: -0.8, z: 0, vx: 12, vz: 3, heading: 0.1 }),
      makePlayer({ id: 'bravo', x: 0.4, z: 0.3, vx: -2, vz: 9, heading: -0.2 }),
      makePlayer({ id: 'charlie', x: 1.1, z: -0.5, vx: 5, vz: -4, heading: 0.7 }),
    ];

    const first = build();
    const second = build();
    resolvePlayerCollisions(first, config, 0);
    resolvePlayerCollisions(second, config, 0);

    expect(second.map((p) => [p.x, p.z, p.vx, p.vz, p.heading])).toEqual(
      first.map((p) => [p.x, p.z, p.vx, p.vz, p.heading]),
    );
  });
});
