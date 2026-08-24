import { describe, expect, it } from 'vitest';
import { makeSimConfig, tickDeltaSeconds, type SimConfigOverrides } from '@/sim/config.js';
import { integratePlayer } from '@/sim/systems/movement.js';
import { addEffect } from '@/sim/systems/effects.js';
import {
  axleGrip,
  isInPitLane,
  tyreLife,
  vehicleGrip,
  vehicleTopSpeed,
} from '@/sim/systems/vehicle.js';
import { isOnTrack } from '@/sim/track.js';
import { BUTTON_SECONDARY, type PlayerState } from '@/sim/types.js';
import { makeInput, makePlayer } from '../../helpers/factories.js';

/**
 * Straight, flat, empty. Every assertion here is about the handling model, so
 * the world around it is deliberately featureless.
 */
function carConfig({ vehicle, ...overrides }: SimConfigOverrides = {}) {
  return makeSimConfig({
    playerMaxSpeed: 20,
    obstacleCount: 0,
    pickupCount: 0,
    arenaHalfExtentX: 400,
    arenaHalfExtentZ: 400,
    ...overrides,
    // Spread last, and merged rather than replaced: a trailing `...overrides`
    // silently drops `enabled: true`, and a test that thinks it is measuring a
    // car is then measuring a runner. That has cost an afternoon twice.
    vehicle: { enabled: true, ...vehicle },
  });
}

/** Drives `player` for `ticks`, holding one input. Returns the same player. */
function drive(
  player: PlayerState,
  config: ReturnType<typeof carConfig>,
  input: Parameters<typeof integratePlayer>[1],
  ticks: number,
  tick = 0,
): PlayerState {
  const dt = tickDeltaSeconds(config);
  for (let i = 0; i < ticks; i++) {
    integratePlayer(player, input, config, [], dt, tick + i, false);
  }
  return player;
}

const speedOf = (p: PlayerState): number => Math.hypot(p.vx, p.vz);

/**
 * A car with the tyres and the drivetrain taken out of the picture.
 *
 * Grip high enough that no slip survives a tick, and no coasting, so a car
 * placed at a speed is still doing it when the measurement comes out. What is
 * left is the steering geometry and nothing else — the tyre model has its own
 * tests in `tyres.test.ts`, and measuring both at once would make every radius
 * here a two-variable answer.
 */
function geometryConfig(vehicle: SimConfigOverrides['vehicle'] = {}) {
  return carConfig({ vehicle: { grip: 400, tyreGrip: 400, coastDecel: 0, ...vehicle } });
}

/**
 * Radius of the arc the car actually traces, in world units.
 *
 * Distance travelled over heading turned — the same number you would get by
 * measuring the circle with a tape.
 */
function radiusAt(config: ReturnType<typeof carConfig>, speed: number, stick: number): number {
  const dt = tickDeltaSeconds(config);
  const car = makePlayer({ heading: 0, vx: 0, vz: speed });
  const input = makeInput({ moveX: stick, moveZ: 0 });
  let turned = 0;
  let travelled = 0;
  for (let i = 0; i < 20; i++) {
    const before = car.heading;
    const { x, z } = car;
    integratePlayer(car, input, config, [], dt, i, false);
    turned += car.heading - before;
    travelled += Math.hypot(car.x - x, car.z - z);
  }
  return travelled / turned;
}

describe('vehicle handling', () => {
  it('reads the two axes as separate controls, not as a direction', () => {
    // The whole point of the model: steering is `moveX`, throttle is `moveZ`,
    // and neither implies the other.
    const config = carConfig();

    // Steering alone turns the WHEELS and takes the car nowhere. It does not
    // turn the car either, because a car yaws by rolling — see below.
    const turning = makePlayer({ heading: 0 });
    drive(turning, config, makeInput({ moveX: 1, moveZ: 0 }), 10);
    expect(speedOf(turning)).toBe(0);

    // Throttle alone drives it dead straight.
    const straight = makePlayer({ heading: 0 });
    drive(straight, config, makeInput({ moveX: 0, moveZ: 1 }), 10);
    expect(straight.heading).toBe(0);
    expect(straight.vz).toBeGreaterThan(0);
    expect(straight.vx).toBe(0);
  });

  it('does not turn a parked car, however far the wheel goes over', () => {
    // The property that makes it a car rather than a tank. Turning the wheel
    // of a stationary car turns the wheels; the car has to roll before any of
    // that becomes a change of direction.
    const config = carConfig();
    const parked = makePlayer({ heading: 0.4, vx: 0, vz: 0 });

    drive(parked, config, makeInput({ moveX: 1, moveZ: 0 }), 120);

    expect(parked.heading).toBe(0.4);
    expect(speedOf(parked)).toBe(0);
  });

  it('steers at full lock left and right, symmetrically', () => {
    const config = carConfig();
    const left = makePlayer({ heading: 0, vz: 8 });
    const right = makePlayer({ heading: 0, vz: 8 });
    drive(left, config, makeInput({ moveX: -1, moveZ: 1 }), 5);
    drive(right, config, makeInput({ moveX: 1, moveZ: 1 }), 5);
    expect(left.heading).toBeCloseTo(-right.heading, 6);
    expect(right.heading).toBeGreaterThan(0);
  });

  it('holds a radius set by the lock rather than by the speed', () => {
    // A car on a fixed steering angle traces the same arc whatever speed it
    // is doing — that is what `omega = v tan(d) / L` means, and it is why a
    // corner has a right gear rather than a right amount of steering. It only
    // stops being true when the tyres run out, so this uses a gentle angle
    // that both speeds can hold.
    const config = geometryConfig({ steerFalloff: 0 });

    // Same lock, three times the speed, same arc. `steerFalloff` is off here
    // precisely because it is the one thing that would break this — see below.
    expect(radiusAt(config, 18, 0.25)).toBeCloseTo(radiusAt(config, 6, 0.25), 0);
    // And the arc is the one the geometry predicts: R = L / tan(angle).
    const angle = 0.25 * config.vehicle.maxSteerAngle;
    expect(radiusAt(config, 12, 0.25)).toBeCloseTo(config.vehicle.wheelbase / Math.tan(angle), 0);
  });

  it('carries analog throttle: half the axis is half the speed', () => {
    const config = carConfig();
    const half = makePlayer({ heading: 0 });
    drive(half, config, makeInput({ moveZ: 0.5 }), 300);
    expect(speedOf(half)).toBeCloseTo(config.playerMaxSpeed * 0.5, 1);
  });

  it('ignores a resting thumb on either axis', () => {
    const config = carConfig();
    const car = makePlayer({ heading: 0 });
    drive(car, config, makeInput({ moveX: 0.02, moveZ: 0.02 }), 30);
    expect(car.heading).toBe(0);
    expect(speedOf(car)).toBe(0);
  });

  it('steers while braking — a corner is entered on the brakes', () => {
    const config = carConfig();
    const car = makePlayer({ heading: 0, vz: 15 });
    drive(car, config, makeInput({ moveX: 1, moveZ: -1 }), 10);
    expect(car.heading).toBeGreaterThan(0);
    expect(speedOf(car)).toBeLessThan(15);
  });

  it('cannot strafe: velocity stays on the car axis', () => {
    const config = carConfig();
    const car = makePlayer({ heading: 0, vx: 8, vz: 0 });
    // Sideways velocity is scrubbed off by grip, not steered with.
    drive(car, config, makeInput({ moveX: 0, moveZ: 1 }), 20);
    expect(Math.abs(car.vx)).toBeLessThan(0.5);
  });

  it('reaches its top speed and holds there', () => {
    const config = carConfig();
    const car = makePlayer({ heading: 0 });
    drive(car, config, makeInput({ moveZ: 1 }), 200);
    expect(speedOf(car)).toBeCloseTo(config.playerMaxSpeed, 1);
  });

  it('winds the rack off at speed, so the same stick takes more room', () => {
    // `steerFalloff` is a speed-sensitive rack, not understeer by fiat. The
    // driver is never denied an angle they could hold; what shrinks is the
    // angle the stick ASKS for, because full lock at racing speed would ask
    // for a radius no car could hold and the top half of the control's travel
    // would do nothing but plough. This is why the previous test has to turn
    // it off to see the bicycle model underneath.
    const config = geometryConfig();
    const fast = radiusAt(config, config.playerMaxSpeed, 1);
    const slow = radiusAt(config, 0.2, 1);

    expect(fast).toBeGreaterThan(slow);
    // And it is the rack doing it, not a fudge: the angle scales linearly with
    // speed, so at the top of the range it is exactly the configured fraction.
    const angleAt = (radius: number): number => Math.atan(config.vehicle.wheelbase / radius);
    expect(angleAt(fast)).toBeCloseTo(angleAt(slow) * (1 - config.vehicle.steerFalloff), 1);
  });

  it('brakes in proportion to how far the pedal is pulled', () => {
    // The pedal is analog on a phone now, and a brake that ignored that would
    // make the travel decorative. Half the pedal is half the retardation.
    const config = carConfig();
    const light = drive(makePlayer({ heading: 0, vz: 18 }), config, makeInput({ moveZ: -0.4 }), 6);
    const hard = drive(makePlayer({ heading: 0, vz: 18 }), config, makeInput({ moveZ: -1 }), 6);

    expect(speedOf(light)).toBeGreaterThan(speedOf(hard));
    expect(speedOf(light)).toBeLessThan(18);

    // And it is proportional rather than merely ordered: what each shed over
    // the same six ticks is in the ratio the two pedals were asking for.
    expect((18 - speedOf(light)) / (18 - speedOf(hard))).toBeCloseTo(0.4, 1);
  });

  it('loads the front axle on the brakes and the rear on the power', () => {
    // The change that makes this a car rather than one lumped tyre. Weight
    // moves, and grip follows the weight.
    const car = carConfig().vehicle;
    const traction = 16;

    const braking = axleGrip(car, traction, -car.brakeDecel);
    const neutral = axleGrip(car, traction, 0);
    const power = axleGrip(car, traction, car.engineAccel);

    // Nose down under braking, squatted under power.
    expect(braking.frontLoad).toBeGreaterThan(neutral.frontLoad);
    expect(power.frontLoad).toBeLessThan(neutral.frontLoad);
    // At rest the split is whatever the car was built with.
    expect(neutral.frontLoad).toBeCloseTo(car.weightFront, 6);

    // Neither end ever goes weightless, because an axle with no load has no
    // grip and a car with one of those is a pirouette rather than a car.
    for (const state of [braking, neutral, power]) {
      expect(state.frontLoad).toBeGreaterThan(0.1);
      expect(state.frontLoad).toBeLessThan(0.9);
    }
  });

  it('leaves the rear with almost nothing under heavy braking', () => {
    // The other half of loading the front, and the reason standing on the
    // brakes mid-corner spins a car: the end that was holding the line has
    // just been unweighted AND is spending what is left on stopping.
    const car = carConfig().vehicle;
    const braking = axleGrip(car, 16, -car.brakeDecel);
    const neutral = axleGrip(car, 16, 0);

    expect(braking.front).toBeGreaterThan(braking.rear * 2);
    expect(braking.rear).toBeLessThan(neutral.rear * 0.5);
  });

  it('turns in on the brakes and runs wide on the power', () => {
    // The emergent behaviour, measured through the whole integrator rather
    // than asserted about the axles. Same corner, same lock, same entry
    // speed — only the pedal differs, and it decides where the car goes.
    //
    // This replaces a test that asked whether easing the brake handed grip
    // BACK to the front. Under a lumped tyre that was the only thing braking
    // could do; with real axles braking loads the front, and the trade is a
    // richer one — the front gains what the rear loses.
    const config = carConfig({
      vehicle: {
        tyreGrip: 18,
        frictionCircle: 1,
        frontGrip: 3,
        selfAlign: 3,
        brakeDecel: 18,
        steerFalloff: 0,
      },
    });
    const dt = tickDeltaSeconds(config);

    const turnedUnder = (pedal: number): number => {
      const car = makePlayer({ heading: 0, vx: 0, vz: 18 });
      const input = makeInput({ moveX: 1, moveZ: pedal });
      for (let i = 0; i < 12; i++) integratePlayer(car, input, config, [], dt, i, false);
      return Math.abs(car.heading);
    };

    // A car being asked to accelerate has taken the load off its own nose, so
    // it will not turn — which is why you get the corner done before the
    // throttle, not during it.
    expect(turnedUnder(-0.6)).toBeGreaterThan(turnedUnder(1) * 1.5);
  });

  it('brakes harder on the pedal than off the throttle', () => {
    const config = carConfig();
    const coasting = makePlayer({ heading: 0, vz: 18 });
    const braking = makePlayer({ heading: 0, vz: 18 });

    drive(coasting, config, makeInput({}), 10);
    drive(braking, config, makeInput({ buttons: BUTTON_SECONDARY }), 10);

    expect(speedOf(braking)).toBeLessThan(speedOf(coasting));
    expect(speedOf(coasting)).toBeLessThan(18);
  });

  it('reads a pulled-back axis as the brake pedal', () => {
    const config = carConfig();
    const braked = makePlayer({ heading: 0, vz: 15 });
    const held = makePlayer({ heading: 0, vz: 15 });

    drive(braked, config, makeInput({ moveZ: -1 }), 10);
    drive(held, config, makeInput({ moveZ: 1 }), 10);
    expect(speedOf(braked)).toBeLessThan(speedOf(held));
    expect(braked.heading).toBe(0); // braking is not steering
  });

  it('backs a stopped car out, steering the way a car park does', () => {
    // `CLAUDE.md` requires that a spun car is recoverable, and it used to be
    // because steering worked at a standstill. It does not any more, and it
    // should not: this is what a driver actually does instead. Reversing swings
    // the nose the opposite way for a given lock, which falls out of the model
    // rather than being written down — `forward` is signed, so the yaw is too.
    const config = carConfig();

    const backing = makePlayer({ heading: 0 });
    drive(backing, config, makeInput({ moveX: 1, moveZ: -1 }), 60);

    // It moved, and it came round — the opposite way to the same lock going
    // forwards, which is the bit that makes it feel like a car.
    expect(speedOf(backing)).toBeGreaterThan(0);
    expect(backing.heading).toBeLessThan(-0.2);

    const forwards = makePlayer({ heading: 0 });
    drive(forwards, config, makeInput({ moveX: 1, moveZ: 1 }), 60);
    expect(forwards.heading).toBeGreaterThan(0.2);
  });

  it('backs out at the speed the pedal asks for', () => {
    // Reverse is the way out of a barrier, so it is analog too: ease it to
    // creep off, bury it to get out of the way of a train of cars.
    const config = carConfig();
    const creep = drive(makePlayer({ heading: 0 }), config, makeInput({ moveZ: -0.3 }), 90);
    const quick = drive(makePlayer({ heading: 0 }), config, makeInput({ moveZ: -1 }), 90);

    expect(creep.vz).toBeLessThan(0);
    expect(Math.abs(creep.vz)).toBeLessThan(Math.abs(quick.vz));
    expect(Math.abs(creep.vz)).toBeCloseTo(Math.abs(quick.vz) * 0.3, 1);
  });

  it('reverses on the brake pedal, capped well below the forward top speed', () => {
    const config = carConfig();
    // The brake button alone: no stick, so no steering, so the car really does
    // have to back up.
    const car = makePlayer({ heading: 0 });
    drive(car, config, makeInput({ buttons: BUTTON_SECONDARY }), 90);

    expect(car.heading).toBe(0);
    expect(car.vz).toBeLessThan(0);
    expect(Math.abs(car.vz)).toBeCloseTo(config.playerMaxSpeed * config.vehicle.reverseFraction, 1);
  });

  it('holds its heading through a spin — a car does not snap to its velocity', () => {
    const config = carConfig();
    const car = makePlayer({ heading: 0, vx: 12, vz: 0 });
    drive(car, config, makeInput({}), 1);
    // Sliding sideways at 12 u/s, still pointing where the driver left it.
    expect(car.heading).toBe(0);
  });

  it('acknowledges input even while frozen on the grid', () => {
    // The host echoes `lastInputSeq` back in the snapshot, and that is what
    // lets a client discard inputs it no longer has to replay. Skipping it
    // through a countdown would leave every client replaying four seconds of
    // grid-bound input at the exact moment the lights go out.
    const config = carConfig();
    const car = makePlayer();
    const dt = tickDeltaSeconds(config);

    integratePlayer(car, makeInput({ seq: 42, moveZ: 1 }), config, [], dt, 0, true);
    expect(car.lastInputSeq).toBe(42);

    // Still never regresses on an out-of-order arrival.
    integratePlayer(car, makeInput({ seq: 7, moveZ: 1 }), config, [], dt, 1, true);
    expect(car.lastInputSeq).toBe(42);
  });

  it('stays put while the lights are on, and does not creep or rotate', () => {
    const config = carConfig();
    const car = makePlayer({ heading: 0.4, vz: 6 });
    const dt = tickDeltaSeconds(config);
    for (let i = 0; i < 60; i++) {
      integratePlayer(car, makeInput({ moveX: 1, moveZ: 1 }), config, [], dt, i, true);
    }
    expect(speedOf(car)).toBeLessThan(0.05);
    expect(car.heading).toBe(0.4);
  });
});

describe('surfaces, tyres and the limiter', () => {
  const RECTANGLE = [
    { x: 0, z: -10 },
    { x: 20, z: -10 },
    { x: 20, z: 10 },
    { x: -20, z: 10 },
    { x: -20, z: -10 },
  ];

  it('is slower and slidier off the tarmac', () => {
    const config = carConfig({
      track: { enabled: true, halfWidth: 4, offTrackSpeed: 0.5, offTrackGrip: 0.25 },
      trackPath: RECTANGLE,
    });
    const car = makePlayer();

    expect(vehicleTopSpeed(car, config, 0, true)).toBeCloseTo(20, 6);
    expect(vehicleTopSpeed(car, config, 0, false)).toBeCloseTo(10, 6);
    expect(vehicleGrip(car, config, 0, false)).toBeCloseTo(
      vehicleGrip(car, config, 0, true) * 0.25,
      6,
    );

    // And the integrator actually applies it: same throttle, less speed. Kept
    // short so the on-road car is still on its straight when measured — drive
    // it long enough and it runs off the end and joins the control group.
    // Both already pointed down their own line: a car that starts facing
    // across it curves onto the tarmac and quietly joins the control group.
    const along = { heading: Math.PI / 2 };
    const onRoad = drive(
      makePlayer({ x: 0, z: -10, ...along }),
      config,
      makeInput({ moveZ: 1 }),
      40,
    );
    const onGrass = drive(
      makePlayer({ x: 0, z: -18, ...along }),
      config,
      makeInput({ moveZ: 1 }),
      40,
    );
    expect(isOnTrack(config, onRoad.x, onRoad.z)).toBe(true);
    expect(isOnTrack(config, onGrass.x, onGrass.z)).toBe(false);
    expect(speedOf(onGrass)).toBeLessThan(speedOf(onRoad) * 0.6);
  });

  it('wears tyres down to a floor, and refits by extending the effect', () => {
    const config = carConfig({
      race: { enabled: true, tyreStintTicks: 100, tyreWornSpeed: 0.5, tyreWornGrip: 0.5 },
    });
    const car = makePlayer();

    // No tyres granted yet reads as gone — which is why the race system fits a
    // set before every round rather than waiting for one to be asked for.
    expect(tyreLife(car, config, 0)).toBe(0);

    addEffect(car, 'tyre', 100);
    expect(tyreLife(car, config, 0)).toBe(1);
    expect(tyreLife(car, config, 50)).toBeCloseTo(0.5, 6);
    expect(tyreLife(car, config, 100)).toBe(0);

    // Worn rubber is slower AND slidier; both halve at this configuration.
    expect(vehicleTopSpeed(car, config, 100)).toBeCloseTo(10, 6);
    expect(vehicleGrip(car, config, 100)).toBeCloseTo(config.vehicle.grip * 0.5, 6);
  });

  it('ignores tyre wear entirely when the stint length is zero', () => {
    const config = carConfig({ race: { enabled: true, tyreStintTicks: 0 } });
    const car = makePlayer();
    expect(tyreLife(car, config, 5000)).toBe(1);
    expect(vehicleTopSpeed(car, config, 5000)).toBeCloseTo(20, 6);
  });

  it('limits speed inside the pit lane, and only inside it', () => {
    const config = carConfig({
      race: { enabled: true, pitSpeedLimit: 5 },
      zones: [{ kind: 'pit', x: 0, z: 0, radius: 6, team: -1, order: 0 }],
    });

    expect(isInPitLane(config, 0, 0)).toBe(true);
    expect(isInPitLane(config, 20, 0)).toBe(false);

    const inLane = drive(
      makePlayer({ x: 0, z: 0, heading: 0 }),
      config,
      makeInput({ moveZ: 1 }),
      5,
    );
    expect(speedOf(inLane)).toBeLessThanOrEqual(5.01);

    const outside = drive(
      makePlayer({ x: 30, z: 0, heading: 0 }),
      config,
      makeInput({ moveZ: 1 }),
      60,
    );
    expect(speedOf(outside)).toBeGreaterThan(5);
  });

  it('multiplies the tow and the wing into top speed', () => {
    const config = carConfig({
      race: { enabled: true, slipstreamMultiplier: 1.1, drsMultiplier: 1.25 },
    });
    const plain = makePlayer();
    const towed = makePlayer();
    addEffect(towed, 'tow', 10);
    const winged = makePlayer();
    addEffect(winged, 'drs', 10);

    expect(vehicleTopSpeed(towed, config, 0)).toBeCloseTo(
      vehicleTopSpeed(plain, config, 0) * 1.1,
      6,
    );
    expect(vehicleTopSpeed(winged, config, 0)).toBeCloseTo(
      vehicleTopSpeed(plain, config, 0) * 1.25,
      6,
    );
  });
});
