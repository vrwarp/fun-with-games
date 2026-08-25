import { describe, expect, it } from 'vitest';
import {
  angleDelta,
  approach,
  bodyAcceleration,
  bodyAttitude,
  brakeGlowStep,
  steerFromYaw,
  wheelSpinDelta,
} from '@/render/cardynamics.js';

/**
 * The car's visible motion, recovered from state the renderer already has.
 *
 * Signs are the entire hazard here. A wheel spinning backward, a body leaning
 * INTO a corner, a steering wheel counter-rotating the wrong way — none of
 * them look broken in a screenshot, all of them look wrong in motion, and
 * every one is a single flipped minus. So the signs are pinned as facts, not
 * checked by eye.
 */

describe('angle differencing', () => {
  it('takes the short way round', () => {
    expect(angleDelta(0.1, 0.3)).toBeCloseTo(0.2, 10);
    expect(angleDelta(0.3, 0.1)).toBeCloseTo(-0.2, 10);
  });

  it('survives the wrap at PI, where a lap crosses it every time', () => {
    // A car turning through the heading wrap must not read as a full spin the
    // other way — that one frame would slam the steering estimate to full
    // opposite lock mid-corner.
    expect(angleDelta(Math.PI - 0.05, -Math.PI + 0.05)).toBeCloseTo(0.1, 10);
    expect(angleDelta(-Math.PI + 0.05, Math.PI - 0.05)).toBeCloseTo(-0.1, 10);
  });
});

describe('steering recovered from yaw', () => {
  it('inverts the bicycle model exactly', () => {
    // The sim runs yawRate = v * tan(lock) / L. Feed that yaw rate back in and
    // the original lock must come out — this is an inverse, not a heuristic.
    const wheelbase = 3.4;
    for (const lock of [0.05, 0.2, -0.3]) {
      for (const speed of [5, 15, 25]) {
        const yawRate = (speed * Math.tan(lock)) / wheelbase;
        expect(steerFromYaw(yawRate, speed, wheelbase, 0.6)).toBeCloseTo(lock, 6);
      }
    }
  });

  it('never exceeds the lock the rack itself has', () => {
    expect(steerFromYaw(100, 10, 3.4, 0.6)).toBe(0.6);
    expect(steerFromYaw(-100, 10, 3.4, 0.6)).toBe(-0.6);
  });

  it('reads straight-ahead on a car that is barely moving', () => {
    // A shunted car can rotate with almost no speed; dividing by that speed
    // would show full lock on a parked car.
    expect(steerFromYaw(2, 0.2, 3.4, 0.6)).toBe(0);
  });
});

describe('wheel spin', () => {
  it('is distance over radius', () => {
    // 10 m/s on a 0.5m wheel for a tenth of a second: 2 radians.
    expect(wheelSpinDelta(10, 0.5, 0.1)).toBeCloseTo(2, 10);
  });

  it('rolls backward in reverse', () => {
    expect(wheelSpinDelta(-4, 0.5, 0.1)).toBeLessThan(0);
  });

  it('smaller wheels spin faster for the same speed', () => {
    expect(wheelSpinDelta(10, 0.4, 0.1)).toBeGreaterThan(wheelSpinDelta(10, 0.6, 0.1));
  });
});

describe('body acceleration', () => {
  it('splits into the car frame, not the world frame', () => {
    // Heading +X (heading = PI/2), gaining speed along +X: pure forward accel.
    const gain = bodyAcceleration(Math.PI / 2, 12, 0, 10, 0, 0.1);
    expect(gain.forward).toBeCloseTo(20, 6);
    expect(gain.lateral).toBeCloseTo(0, 6);
    // Same heading, velocity swinging toward +Z (the car's LEFT): lateral.
    const turn = bodyAcceleration(Math.PI / 2, 10, 1, 10, 0, 0.1);
    expect(turn.lateral).toBeCloseTo(-10, 6);
    expect(turn.forward).toBeCloseTo(0, 6);
  });

  it('returns nothing for a degenerate frame', () => {
    expect(bodyAcceleration(0, 5, 5, 1, 1, 0)).toEqual({ forward: 0, lateral: 0 });
  });
});

describe('body attitude', () => {
  it('dives the nose under braking and lifts it under power', () => {
    // Babylon fact this leans on: positive rotation.x pitches the nose (+Z)
    // DOWN. So braking (negative forward accel) must produce POSITIVE pitch,
    // and the two must be opposite.
    const braking = bodyAttitude(-20, 0);
    const accelerating = bodyAttitude(15, 0);
    expect(braking.pitch).toBeGreaterThan(0);
    expect(accelerating.pitch).toBeLessThan(0);
  });

  it('rolls OUT of the corner, not into it like a motorcycle', () => {
    // Cornering left means lateral acceleration to the left (negative, in the
    // right-positive convention). The sprung mass leans the other way.
    const left = bodyAttitude(0, -20);
    const right = bodyAttitude(0, 20);
    expect(left.roll).toBeGreaterThan(0);
    expect(right.roll).toBeLessThan(0);
    expect(left.roll).toBeCloseTo(-right.roll, 10);
  });

  it('clamps to a stiff car, not a boat', () => {
    const extreme = bodyAttitude(-1000, 1000);
    expect(Math.abs(extreme.pitch)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(extreme.roll)).toBeLessThanOrEqual(0.05);
  });
});

describe('brake glow', () => {
  it('heats instantly and cools slowly', () => {
    const hot = brakeGlowStep(0, -20, 20, 0.033);
    expect(hot).toBeGreaterThan(0.5);
    // Off the brakes: the glow fades over the next second, it does not vanish.
    const cooling = brakeGlowStep(hot, 0, 20, 0.1);
    expect(cooling).toBeLessThan(hot);
    expect(cooling).toBeGreaterThan(hot - 0.2);
  });

  it('ignores coasting drag and a parked car', () => {
    // Lift-off drag decelerates a car a few m/s^2; that is not braking, and
    // rims that glowed every time the driver lifted would mean nothing.
    expect(brakeGlowStep(0, -3, 20, 0.033)).toBe(0);
    expect(brakeGlowStep(0, -30, 0.5, 0.033)).toBe(0);
  });

  it('saturates instead of overflowing on a wall hit', () => {
    expect(brakeGlowStep(0, -500, 20, 0.033)).toBe(1);
  });
});

describe('frame-rate independent approach', () => {
  it('converges without overshooting at any frame rate', () => {
    for (const dt of [1 / 240, 1 / 60, 1 / 5, 1]) {
      let value = 0;
      for (let i = 0; i < 200; i++) value = approach(value, 1, 8, dt);
      expect(value).toBeGreaterThan(0.95);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('covers the same ground in one big step as in many small ones', () => {
    // The property that makes it frame-rate independent: 10 steps of 10ms and
    // one step of 100ms land in the same place.
    let stepped = 0;
    for (let i = 0; i < 10; i++) stepped = approach(stepped, 1, 8, 0.01);
    const single = approach(0, 1, 8, 0.1);
    expect(stepped).toBeCloseTo(single, 10);
  });
});
