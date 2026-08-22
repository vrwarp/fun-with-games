import { describe, expect, it } from 'vitest';
import { dopplerRatio, engineHz, engineLoad, gearFor } from '@/render/enginesound.js';

/**
 * The maths behind the engine note.
 *
 * All of it is deliberately pure and free of WebAudio, because the parts that
 * are easy to get wrong — which way a Doppler shift goes, whether the pitch
 * drops on a shift — are exactly the parts a browser test could only tell you
 * about by ear.
 */

/** A body at rest at the origin, for tests that only care about one mover. */
const still = { x: 0, z: 0, vx: 0, vz: 0 };

describe('dopplerRatio', () => {
  it('raises the pitch of a car coming toward you', () => {
    // Source ahead on +z, travelling back down -z at 30: closing.
    const approaching = { x: 0, z: 40, vx: 0, vz: -30 };
    expect(dopplerRatio(still, approaching)).toBeGreaterThan(1);
  });

  it('drops the pitch of a car pulling away', () => {
    const receding = { x: 0, z: 40, vx: 0, vz: 30 };
    expect(dopplerRatio(still, receding)).toBeLessThan(1);
  });

  it('is symmetric about a pass, and steeper the faster the car', () => {
    const slowIn = { x: 0, z: 40, vx: 0, vz: -10 };
    const fastIn = { x: 0, z: 40, vx: 0, vz: -30 };
    expect(dopplerRatio(still, fastIn)).toBeGreaterThan(dopplerRatio(still, slowIn));

    const slowOut = { x: 0, z: 40, vx: 0, vz: 10 };
    const fastOut = { x: 0, z: 40, vx: 0, vz: 30 };
    expect(dopplerRatio(still, fastOut)).toBeLessThan(dopplerRatio(still, slowOut));
  });

  it('leaves a car crossing your path unshifted', () => {
    // Directly ahead, travelling straight across at speed. None of that motion
    // is along the line between the two, so no wavefront arrives any sooner —
    // which is the instant a passing car's pitch audibly falls through.
    const crossing = { x: 0, z: 40, vx: 30, vz: 0 };
    expect(dopplerRatio(still, crossing)).toBeCloseTo(1, 10);
  });

  it('counts the listener’s own motion too', () => {
    // Chasing a car that is holding station: closing, so the pitch rises.
    const chasing = { x: 0, z: 0, vx: 0, vz: 25 };
    const ahead = { x: 0, z: 40, vx: 0, vz: 0 };
    expect(dopplerRatio(chasing, ahead)).toBeGreaterThan(1);

    // Two cars nose to tail at identical speed never shift at all, however
    // fast they are both going — which is why a slipstream sounds steady.
    const together = { x: 0, z: 40, vx: 0, vz: 25 };
    expect(dopplerRatio(chasing, together)).toBeCloseTo(1, 10);
  });

  it('matches the textbook figure', () => {
    // f' = f (c + vr) / (c + vs). Stationary listener, source closing at 30
    // with c = 343: 343 / (343 - 30).
    const approaching = { x: 0, z: 10, vx: 0, vz: -30 };
    expect(dopplerRatio(still, approaching, 343)).toBeCloseTo(343 / 313, 10);
  });

  it('refuses to divide by a supersonic source or a zero distance', () => {
    const onTop = { x: 0, z: 0, vx: 40, vz: 0 };
    expect(dopplerRatio(still, onTop)).toBe(1);

    const supersonic = { x: 0, z: 10, vx: 0, vz: 400 };
    expect(Number.isFinite(dopplerRatio(still, supersonic, 343))).toBe(true);
  });

  it('stays within bounds however silly the velocities get', () => {
    const absurd = { x: 0, z: 5, vx: 0, vz: -340 };
    const ratio = dopplerRatio(still, absurd, 343);
    expect(ratio).toBeLessThanOrEqual(2);
    expect(ratio).toBeGreaterThanOrEqual(0.5);
  });
});

describe('gearFor', () => {
  it('climbs through the rev range and drops on the shift', () => {
    // The point of having a gearbox at all: without one the pitch would rise
    // monotonically with speed and the car would sound like a siren.
    const revs: number[] = [];
    const gears: number[] = [];
    for (let i = 0; i <= 100; i++) {
      const { gear, rev } = gearFor(i / 100);
      revs.push(rev);
      gears.push(gear);
    }

    expect(gears[0]).toBe(0);
    expect(gears[gears.length - 1]).toBeGreaterThan(0);

    // Somewhere in there the revs must fall while the speed rises.
    const dropped = revs.some((rev, i) => i > 0 && rev < revs[i - 1]!);
    expect(dropped).toBe(true);
  });

  it('shifts up, never down, as the car speeds up', () => {
    let previous = 0;
    for (let i = 0; i <= 200; i++) {
      const { gear } = gearFor(i / 200);
      expect(gear).toBeGreaterThanOrEqual(previous);
      previous = gear;
    }
  });

  it('keeps low gears shorter than high ones', () => {
    // A real box is spread that way, and it is why pulling away sounds busy
    // and a straight sounds relaxed.
    const spanOf = (gear: number): number => {
      let lo = 1;
      let hi = 0;
      for (let i = 0; i <= 2000; i++) {
        const s = i / 2000;
        if (gearFor(s).gear !== gear) continue;
        lo = Math.min(lo, s);
        hi = Math.max(hi, s);
      }
      return hi - lo;
    };
    expect(spanOf(0)).toBeLessThan(spanOf(5));
  });

  it('is defined at both ends and never leaves [0, 1]', () => {
    for (const speed of [-1, 0, 0.5, 1, 2]) {
      const { gear, rev } = gearFor(speed);
      expect(rev).toBeGreaterThanOrEqual(0);
      expect(rev).toBeLessThanOrEqual(1);
      expect(gear).toBeGreaterThanOrEqual(0);
      expect(gear).toBeLessThan(6);
    }
  });
});

describe('engineHz', () => {
  it('idles low and screams at the redline', () => {
    expect(engineHz(0)).toBeLessThan(engineHz(1));
    expect(engineHz(0)).toBeGreaterThan(0);
  });

  it('rises monotonically through the range', () => {
    let previous = 0;
    for (let i = 0; i <= 20; i++) {
      const hz = engineHz(i / 20);
      expect(hz).toBeGreaterThan(previous);
      previous = hz;
    }
  });
});

describe('engineLoad', () => {
  it('reads hard acceleration as load and a lift as none', () => {
    const pulling = engineLoad(22, 22);
    const coasting = engineLoad(0, 22);
    const braking = engineLoad(-26, 22);

    expect(pulling).toBeGreaterThan(coasting);
    expect(coasting).toBeGreaterThan(braking);
  });

  it('stays inside [0, 1] however hard the car is hit', () => {
    for (const accel of [-500, -22, 0, 22, 500]) {
      const load = engineLoad(accel, 22);
      expect(load).toBeGreaterThanOrEqual(0);
      expect(load).toBeLessThanOrEqual(1);
    }
  });

  it('has an answer for a mode with no engine figure', () => {
    expect(Number.isFinite(engineLoad(5, 0))).toBe(true);
  });
});
