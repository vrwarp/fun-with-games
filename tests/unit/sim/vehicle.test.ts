import { describe, expect, it } from 'vitest';
import { makeSimConfig, tickDeltaSeconds, type SimConfigOverrides } from '@/sim/config.js';
import { integratePlayer } from '@/sim/systems/movement.js';
import { addEffect } from '@/sim/systems/effects.js';
import { isInPitLane, tyreLife, vehicleGrip, vehicleTopSpeed } from '@/sim/systems/vehicle.js';
import { isOnTrack } from '@/sim/track.js';
import { BUTTON_SECONDARY, type PlayerState } from '@/sim/types.js';
import { makeInput, makePlayer } from '../../helpers/factories.js';

/**
 * Straight, flat, empty. Every assertion here is about the handling model, so
 * the world around it is deliberately featureless.
 */
function carConfig(overrides: SimConfigOverrides = {}) {
  return makeSimConfig({
    vehicle: { enabled: true },
    playerMaxSpeed: 20,
    obstacleCount: 0,
    pickupCount: 0,
    arenaHalfExtentX: 400,
    arenaHalfExtentZ: 400,
    ...overrides,
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

describe('vehicle handling', () => {
  it('accelerates along its nose, not along the stick', () => {
    const config = carConfig();
    const car = makePlayer({ heading: 0 }); // facing +Z
    // Stick hard right. A runner would strafe; a car has to turn first.
    drive(car, config, makeInput({ moveX: 1, moveZ: 0 }), 3);

    expect(car.heading).toBeGreaterThan(0); // turning toward the stick
    expect(car.heading).toBeLessThan(Math.PI / 2); // but nowhere near there yet
    // Almost all of the speed is still along the original heading.
    expect(car.vz).toBeGreaterThan(car.vx);
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

  it('steers less at speed than at a standstill', () => {
    const config = carConfig();
    const parked = makePlayer({ heading: 0 });
    const flying = makePlayer({ heading: 0, vz: config.playerMaxSpeed });

    const stick = makeInput({ moveX: 1, moveZ: 0 });
    drive(parked, config, stick, 1);
    drive(flying, config, stick, 1);

    // Understeer: this is what forces a driver to brake for the corner.
    expect(flying.heading).toBeGreaterThan(0);
    expect(flying.heading).toBeLessThan(parked.heading);
    expect(flying.heading).toBeCloseTo(parked.heading * (1 - config.vehicle.steerFalloff), 2);
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

  it('reads a stick pulled back past the nose as braking', () => {
    const config = carConfig();
    const braked = makePlayer({ heading: 0, vz: 15 });
    const held = makePlayer({ heading: 0, vz: 15 });

    // Facing +Z at speed, stick pushed to -Z: an instant U-turn is not on
    // offer, so the request is read as "slow down" instead.
    drive(braked, config, makeInput({ moveZ: -1 }), 10);
    drive(held, config, makeInput({ moveZ: 1 }), 10);
    expect(speedOf(braked)).toBeLessThan(speedOf(held));
  });

  it('turns a stopped car around rather than stranding it', () => {
    const config = carConfig();
    const car = makePlayer({ heading: 0 });
    // Deliberate: a real car cannot pivot, but a player who has spun on a
    // phone has one thumb and no reverse gear worth using. Two seconds of
    // stick gets them pointed the other way and going again.
    drive(car, config, makeInput({ moveZ: -1 }), 60);
    expect(Math.abs(Math.abs(car.heading) - Math.PI)).toBeLessThan(0.2);
    expect(car.vz).toBeLessThan(-1);
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
      makeInput({ moveX: 1 }),
      40,
    );
    const onGrass = drive(
      makePlayer({ x: 0, z: -18, ...along }),
      config,
      makeInput({ moveX: 1 }),
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
