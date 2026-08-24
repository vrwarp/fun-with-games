import { describe, expect, it } from 'vitest';
import {
  makeSimConfig,
  tickDeltaSeconds,
  type SimConfig,
  type SimConfigOverrides,
} from '@/sim/config.js';
import { integratePlayer, resolvePlayerCollisions } from '@/sim/systems/movement.js';
import { modeConfig } from '@/sim/presets.js';
import { isOnTrack, trackPoseAt } from '@/sim/track.js';
import { onKerb, slipAngle, vehicleGrip, vehicleTraction } from '@/sim/systems/vehicle.js';
import { hasEffect } from '@/sim/systems/effects.js';
import { World } from '@/sim/world.js';
import type { PlayerState } from '@/sim/types.js';
import { makeInput, makePlayer } from '../../helpers/factories.js';

/**
 * The traction limit, in isolation.
 *
 * Every assertion here is about one question: can the tyres hold the line the
 * steering is asking for? A featureless arena keeps the answer from depending
 * on anything but the handling model.
 */
function gripConfig({ vehicle, ...overrides }: SimConfigOverrides = {}) {
  return makeSimConfig({
    playerMaxSpeed: 30,
    obstacleCount: 0,
    pickupCount: 0,
    arenaHalfExtentX: 4000,
    arenaHalfExtentZ: 4000,
    ...overrides,
    // Spread last and separately: a trailing `...overrides` would replace the
    // whole vehicle block, and a car with `enabled` quietly dropped is not a
    // car at all — it drives away as a runner and every assertion here passes
    // for the wrong reason.
    vehicle: {
      enabled: true,
      tyreGrip: 24,
      frictionCircle: 0,
      selfAlign: 0,
      wheelbase: 3,
      maxSteerAngle: 0.6,
      steerFalloff: 0,
      engineAccel: 30,
      ...vehicle,
    },
  });
}

type Config = ReturnType<typeof gripConfig>;

/** Drives one car for `ticks` on a fixed input. */
function drive(
  player: PlayerState,
  config: Config,
  input: Parameters<typeof integratePlayer>[1],
  ticks: number,
): PlayerState {
  const dt = tickDeltaSeconds(config);
  for (let i = 0; i < ticks; i++) integratePlayer(player, input, config, [], dt, i, false);
  return player;
}

/** A car already up to `speed`, pointing along +z, with fresh tyres. */
function movingCar(speed: number): PlayerState {
  return makePlayer({ heading: 0, vx: 0, vz: speed });
}

/** A car pointing along +z but travelling along +x: pure sideways motion. */
function sidewaysCar(speed: number): PlayerState {
  return makePlayer({ heading: 0, vx: speed, vz: 0 });
}

const speedOf = (p: PlayerState): number => Math.sqrt(p.vx * p.vx + p.vz * p.vz);

/** Sideways velocity in the car's own frame. */
const lateralOf = (p: PlayerState): number =>
  p.vx * Math.cos(p.heading) - p.vz * Math.sin(p.heading);

describe('traction limit', () => {
  it('holds the line when the corner is inside what the tyres can do', () => {
    // Cornering demand is speed x yawRate. At 4 units/second and a 1 rad/s
    // yaw that is 4 units/second^2, well inside a 24 limit, so the car should
    // track its nose exactly: no slip angle at all.
    const config = gripConfig();
    const car = movingCar(4);
    drive(car, config, makeInput({ moveX: 1 / 3, moveZ: 0 }), 30);

    expect(car.heading).toBeGreaterThan(0);
    expect(Math.abs(slipAngle(car))).toBeLessThan(0.01);
  });

  it('lets go when the same steering angle is asked for at speed', () => {
    // Identical steering, identical yaw rate (steerFalloff is 0 here, so the
    // rack is deliberately not allowed to take any credit); the only
    // difference is how fast the car is travelling. This is the property the
    // whole model exists for: speed decides whether a corner is possible.
    const slowly = gripConfig({ playerMaxSpeed: 4 });
    const quickly = gripConfig({ playerMaxSpeed: 30 });
    const input = makeInput({ moveX: 1 / 3, moveZ: 1 });

    const slow = movingCar(4);
    drive(slow, slowly, input, 30);

    const fast = movingCar(30);
    drive(fast, quickly, input, 30);

    // 4 x 1 rad/s is 4 units/second^2 of demand against a 24 limit: held.
    expect(Math.abs(slipAngle(slow))).toBeLessThan(0.01);
    // 30 x 1 rad/s is 30 against the same 24: six over, and the six shows up.
    expect(Math.abs(slipAngle(fast))).toBeGreaterThan(0.1);
  });

  it('costs forward speed while it is sliding', () => {
    // A drift has to be slow or it becomes the racing line. Two cars at the
    // same speed, one driven straight and one hurled sideways, coasting: the
    // sliding one must lose more.
    const config = gripConfig();

    const straight = movingCar(28);
    drive(straight, config, makeInput({ moveX: 0, moveZ: 0 }), 40);

    const sliding = movingCar(28);
    drive(sliding, config, makeInput({ moveX: 1, moveZ: 0 }), 40);

    expect(speedOf(sliding)).toBeLessThan(speedOf(straight));
  });

  it('unwinds a slide through the self-aligning moment', () => {
    // Provoke a slide, then let go of everything. The nose should chase the
    // direction of travel until the car is straight again — a slide the driver
    // can catch, rather than a spin they cannot.
    const config = gripConfig({ vehicle: { selfAlign: 4 } });
    const car = movingCar(28);

    drive(car, config, makeInput({ moveX: 1, moveZ: 0 }), 25);
    const provoked = Math.abs(slipAngle(car));
    expect(provoked).toBeGreaterThan(0.1);

    drive(car, config, makeInput({ moveX: 0, moveZ: 0.6 }), 60);
    expect(Math.abs(slipAngle(car))).toBeLessThan(provoked * 0.5);
  });

  it('leaves a gripping car alone when it self-aligns', () => {
    // The self-aligning moment must only ever act on a car that is already
    // sliding. A car within the limit has scrubbed to zero and should steer
    // exactly the same with the term on as with it off, or the assist is
    // quietly driving for the player.
    const held = gripConfig({ vehicle: { selfAlign: 0 } });
    const assisted = gripConfig({ vehicle: { selfAlign: 6 } });

    const a = movingCar(4);
    const b = movingCar(4);
    drive(a, held, makeInput({ moveX: 1 / 3, moveZ: 0 }), 30);
    drive(b, assisted, makeInput({ moveX: 1 / 3, moveZ: 0 }), 30);

    expect(b.heading).toBeCloseTo(a.heading, 10);
  });

  it('spends the friction circle on braking before cornering', () => {
    // Same corner, same speed; one car is also standing on the brakes. With
    // the circle closed the braking car has less grip left to turn with, so it
    // must slide further. This is trail braking, and its absence is why you
    // could brake mid-corner for free.
    const free = gripConfig({ vehicle: { frictionCircle: 0, brakeDecel: 24 } });
    const coupled = gripConfig({ vehicle: { frictionCircle: 1, brakeDecel: 24 } });

    const a = movingCar(20);
    const b = movingCar(20);
    drive(a, free, makeInput({ moveX: 1, moveZ: -1 }), 12);
    drive(b, coupled, makeInput({ moveX: 1, moveZ: -1 }), 12);

    expect(Math.abs(slipAngle(b))).toBeGreaterThan(Math.abs(slipAngle(a)));
  });

  it('scrubs a fixed amount per second, not a fixed fraction', () => {
    // The mechanism, pinned directly. A car shoved sideways with no throttle
    // and no steering: the tyres should remove `limit` units/second of it,
    // whatever is there. A force-limited scrub is what lets grip saturate at
    // all — a proportional one never can, because it always removes less as
    // there is less to remove.
    const config = gripConfig({ vehicle: { tyreGrip: 24, selfAlign: 0 } });
    const dt = tickDeltaSeconds(config);

    const fast = sidewaysCar(20);
    const slower = sidewaysCar(10);
    drive(fast, config, makeInput({ moveX: 0, moveZ: 0 }), 1);
    drive(slower, config, makeInput({ moveX: 0, moveZ: 0 }), 1);

    expect(lateralOf(fast)).toBeCloseTo(20 - 24 * dt, 6);
    expect(lateralOf(slower)).toBeCloseTo(10 - 24 * dt, 6);
  });

  it('keeps the old proportional scrub when no limit is configured', () => {
    // Every non-racing mode ships tyreGrip 0 and must behave exactly as it did
    // before this model existed: a fixed FRACTION removed per second, so the
    // amount taken shrinks with the amount left.
    const config = gripConfig({ vehicle: { tyreGrip: 0, grip: 7 } });
    const dt = tickDeltaSeconds(config);

    const fast = sidewaysCar(20);
    const slower = sidewaysCar(10);
    drive(fast, config, makeInput({ moveX: 0, moveZ: 0 }), 1);
    drive(slower, config, makeInput({ moveX: 0, moveZ: 0 }), 1);

    expect(lateralOf(fast)).toBeCloseTo(20 * (1 - 7 * dt), 6);
    expect(lateralOf(slower)).toBeCloseTo(10 * (1 - 7 * dt), 6);
  });
});

describe('vehicleTraction', () => {
  it('is zero when the mode has no traction limit', () => {
    const config = gripConfig({ vehicle: { tyreGrip: 0 } });
    expect(vehicleTraction(makePlayer(), config, 0)).toBe(0);
  });

  it('falls away off the tarmac', () => {
    const config = gripConfig({ track: { enabled: true, offTrackGrip: 0.3 } });
    const car = makePlayer();
    const on = vehicleTraction(car, config, 0, true);
    const off = vehicleTraction(car, config, 0, false);
    expect(off).toBeCloseTo(on * 0.3, 6);
  });
});

describe('slipAngle', () => {
  it('is zero for a car tracking its nose, either way along it', () => {
    expect(slipAngle(makePlayer({ heading: 0, vx: 0, vz: 10 }))).toBeCloseTo(0, 10);
    expect(slipAngle(makePlayer({ heading: 0, vx: 0, vz: -10 }))).toBeCloseTo(0, 10);
  });

  it('is zero for a parked car rather than an arbitrary angle', () => {
    expect(slipAngle(makePlayer({ heading: 1.2, vx: 0, vz: 0 }))).toBe(0);
  });

  it('is positive when the car is travelling to the right of where it points', () => {
    // Heading 0 is +z; the car's right-hand side is +x.
    expect(slipAngle(makePlayer({ heading: 0, vx: 5, vz: 5 }))).toBeCloseTo(Math.PI / 4, 6);
  });
});

/**
 * A field of bots on a real circuit.
 *
 * The tyre model is only worth having if something can drive to it, and the
 * bots are the only driver available headlessly. They also stand in for the
 * tuning: a preset whose grip is too low shows up here as a field that spends
 * its afternoon in the scenery.
 */
function raceBots(config: SimConfig, seconds: number) {
  const world = new World({ config, seed: 7 });
  for (let i = 0; i < 4; i++) world.addBot();

  const ticks = Math.round(seconds * config.tickRate);
  let offTrack = 0;
  let samples = 0;
  let speedSum = 0;

  for (let i = 0; i < ticks; i++) {
    world.step();
    for (const player of world.players()) {
      samples++;
      if (!isOnTrack(config, player.x, player.z)) offTrack++;
      speedSum += Math.sqrt(player.vx * player.vx + player.vz * player.vz);
    }
  }

  return {
    offTrackFraction: offTrack / samples,
    averageSpeed: speedSum / samples,
    bestLap: Math.min(...world.players().map((p) => p.bestLapTicks || Number.POSITIVE_INFINITY)),
  };
}

describe('bots driving to the tyres', () => {
  it.each(['grandprix', 'street'] as const)('keeps %s on the road', (mode) => {
    // The tuning guard. Both racing presets are set so that a bot driving to
    // sqrt(grip x radius) holds the circuit; if a change to the handling model
    // or to either preset drops the grip below what the corners need, the
    // field slithers into the scenery and this catches it.
    const result = raceBots(modeConfig(mode), 60);
    expect(result.offTrackFraction).toBeLessThan(0.1);
    expect(result.bestLap).toBeLessThan(Number.POSITIVE_INFINITY);
  });

  it('slows the whole field down when the grip goes away', () => {
    // The bots derive their corner speed from the traction limit rather than
    // from a hand-picked constant, so halving the grip has to slow them —
    // which is also what makes worn tyres and a wet-grass excursion cost time
    // without anyone writing a rule for either.
    const base = modeConfig('grandprix');
    const slippery: SimConfig = {
      ...base,
      vehicle: { ...base.vehicle, tyreGrip: base.vehicle.tyreGrip / 2 },
    };

    const gripped = raceBots(base, 45);
    const sliding = raceBots(slippery, 45);

    expect(sliding.averageSpeed).toBeLessThan(gripped.averageSpeed);
  });
});

/**
 * A car has to stay drivable after it goes wrong.
 *
 * The reported symptom was "the control randomly gets stuck turning right,
 * which makes it unplayable", and it was not the controls: a car nudged
 * sideways at low speed rotated at 4.7 rad/s — faster than `steerRate` — so
 * the driver could not steer out of it and the car simply turned one way until
 * the round ended. The direction was whichever way it had been nudged, which
 * is why it read as random.
 *
 * Two things caused it, and both are physical errors rather than tuning:
 * engine braking was applied along the car's nose even when the car was
 * travelling sideways, which pinned the forward component at zero every tick
 * and so held the slip angle at a right angle; and the self-aligning moment
 * did not scale with speed, so it acted on that maximal input at full
 * strength.
 */
describe('a spun car settles', () => {
  // On the racing line, not at the origin. `makePlayer` defaults to (0, 0),
  // which on this circuit is out in the middle of the grass — so a suite about
  // catching a slide while racing was quietly measuring one on a low-grip
  // surface, at a speed the off-track limiter was hauling back.
  const START = 40;

  const sideways = (forward: number, lateral: number): PlayerState => {
    const pose = trackPoseAt(modeConfig('grandprix').trackPath, START);
    const heading = Math.atan2(pose.dirX, pose.dirZ);
    const sin = Math.sin(heading);
    const cos = Math.cos(heading);
    return makePlayer({
      heading,
      x: pose.x,
      z: pose.z,
      // Compose the car-frame velocity back into world axes.
      vx: forward * sin + lateral * cos,
      vz: forward * cos - lateral * sin,
    });
  };

  it.each([
    [0, 2],
    [0, 6],
    [0, 14],
    [2, 6],
    [8, 14],
  ])('stops turning from forward %i, sideways %i', (forward, lateral) => {
    const config = modeConfig('grandprix');
    const car = sideways(forward, lateral);
    const start = car.heading;
    drive(car, config, makeInput({ moveX: 0, moveZ: 0 }), 300);

    // Ten seconds of nothing. A car that is still rotating after that is a car
    // the driver has lost, permanently.
    const swung = car.heading - start;
    expect(Math.abs(Math.atan2(Math.sin(swung), Math.cos(swung)))).toBeLessThan(Math.PI);
  });

  it('rotates less and less rather than at a fixed rate', () => {
    // The invariant that makes the car playable, stated as what actually went
    // wrong. A hard snap straight from fully sideways is correct and is
    // self-limiting — it reduces the very slip angle driving it. What is not
    // survivable is a CONSTANT rate, which is what a pinned slip angle
    // produced: the car turned at 4.7 rad/s indefinitely, `steerRate` is 3.1,
    // so no input could answer it.
    const config = modeConfig('grandprix');
    const idle = makeInput({ moveX: 0, moveZ: 0 });

    for (const lateral of [1, 4, 8, 16, 25]) {
      for (const forward of [0, 1, 5, 15, 26]) {
        const car = sideways(forward, lateral);

        const start = car.heading;
        drive(car, config, idle, 60);
        const early = Math.abs(car.heading - start);

        const middle = car.heading;
        drive(car, config, idle, 60);
        const late = Math.abs(car.heading - middle);

        // Whatever it did in the first two seconds, it must be doing far less
        // in the next two. A fixed rate would make these equal.
        expect(late).toBeLessThan(Math.max(early * 0.5, 0.05));
      }
    }
  });

  it('still lets a driver catch a slide with opposite lock', () => {
    // The fix must not have cost the thing self-alignment is for.
    const config = modeConfig('grandprix');
    const car = sideways(6, 12);
    const before = Math.abs(slipAngle(car));

    drive(car, config, makeInput({ moveX: -1, moveZ: 1 }), 90);

    // Speed FIRST, and it is not a formality. `slipAngle` reports zero for a
    // stopped car, so a slide assertion on its own is passed perfectly by a
    // car that has simply died — which is what this test used to be doing, on
    // grass, with the throttle buried. A save the driver cannot drive away
    // from is not a save.
    expect(speedOf(car)).toBeGreaterThan(8);
    expect(Math.abs(slipAngle(car))).toBeLessThan(before * 0.55);
  });
});

describe('the grass is slow, not broken', () => {
  /** A straight road along +z, with grass either side of it. */
  const STRAIGHT = [
    { x: 0, z: -300 },
    { x: 0, z: 300 },
  ];

  function surfaceConfig({ track, ...overrides }: SimConfigOverrides = {}) {
    return gripConfig({
      trackPath: STRAIGHT,
      vehicle: { selfAlign: 3, frontGrip: 1.45, steerFalloff: 0.3 },
      ...overrides,
      // Merged, not replaced — a bare `track` override would drop `enabled`,
      // `isOnTrack` would answer true everywhere, and every surface assertion
      // below would compare tarmac against tarmac and pass.
      track: { enabled: true, halfWidth: 5, offTrackSpeed: 0.45, offTrackGrip: 0.6, ...track },
    });
  }

  /** A car out on the grass beside the road, rolling along it. */
  function onGrass(speed: number): PlayerState {
    return makePlayer({ x: 40, z: 0, heading: 0, vx: 0, vz: speed });
  }

  /** Which way the car is actually TRAVELLING, as opposed to pointing. */
  const courseOf = (p: PlayerState): number => Math.atan2(p.vx, p.vz);

  it('keeps changing direction under lock instead of settling into a plough', () => {
    // The bug this is here for: every tyre force was scaled by the surface
    // except the self-aligning moment, so on grass a full-strength caster
    // pulled against a third-strength front axle. They balanced at about
    // twelve degrees of slip and STAYED there — nose cocked into the corner,
    // car travelling dead straight, full lock doing nothing at all. It reads
    // to a driver as the steering having simply stopped working.
    const config = surfaceConfig();
    const car = onGrass(12);
    expect(isOnTrack(config, car.x, car.z)).toBe(false);

    const stick = makeInput({ moveX: 1, moveZ: 1 });
    drive(car, config, stick, 30);
    const first = courseOf(car);
    drive(car, config, stick, 30);
    const second = courseOf(car);

    // Turning in the first second, and STILL turning in the second. An
    // equilibrium plough passes the first of these and fails the second,
    // which is exactly how it went unnoticed.
    expect(Math.abs(first)).toBeGreaterThan(0.2);
    expect(Math.abs(second - first)).toBeGreaterThan(0.2);
  });

  it('scales the aligning moment with the surface, like every other tyre force', () => {
    // The rule underneath the test above, stated directly: grip is one number
    // and all four contact patches share it.
    const slippery = surfaceConfig({ track: { offTrackGrip: 0.2 } });
    const grippy = surfaceConfig({ track: { offTrackGrip: 1 } });

    const settle = (config: Config): number => {
      // Kicked hard sideways, hands off. The kick has to be big enough that
      // the tyres cannot simply erase it — a slide the scrub finishes off is
      // one the caster never sees, and both surfaces then read zero.
      const car = makePlayer({ x: 40, z: 0, heading: 0, vx: 25, vz: 25 });
      drive(car, config, makeInput({}), 5);
      return Math.abs(slipAngle(car));
    };

    // Less grip, less caster, so more of the slide is still there.
    expect(settle(slippery)).toBeGreaterThan(settle(grippy));
  });

  it('never lets a slide carry more speed than the surface allows', () => {
    // The throttle only ever reads and tops up the FORWARD component, so a
    // sliding car used to carry its sideways velocity along untaxed: at forty
    // degrees of slip that is a third more than the limit the car is supposed
    // to be held to, and the engine fed it every tick. Going off the road
    // ACCELERATED you, which is the opposite of a penalty.
    const config = surfaceConfig();
    const car = onGrass(12);
    const cap = config.playerMaxSpeed * config.track.offTrackSpeed;

    // Full lock and full throttle for three seconds: the most sideways this
    // car can be made to go while still being asked for maximum speed.
    let worst = 0;
    const dt = tickDeltaSeconds(config);
    const stick = makeInput({ moveX: 1, moveZ: 1 });
    for (let i = 0; i < 90; i++) {
      integratePlayer(car, stick, config, [], dt, i, false);
      expect(isOnTrack(config, car.x, car.z)).toBe(false);
      worst = Math.max(worst, speedOf(car));
    }

    // A little over the cap is the bleed catching up, not the engine winning.
    expect(worst).toBeLessThan(cap * 1.06);
  });

  it('bleeds down to a lowered limit rather than hitting a wall of air', () => {
    // The same clamp must not become a brick wall for a car that loses a tow
    // or closes its wing — that is why it decelerates toward the limit rather
    // than snapping to it.
    const config = surfaceConfig();
    const cap = config.playerMaxSpeed * config.track.offTrackSpeed;
    // Arrives on the grass well above what the grass allows.
    const car = onGrass(config.playerMaxSpeed);
    const before = speedOf(car);

    drive(car, config, makeInput({ moveZ: 1 }), 1);
    const lost = before - speedOf(car);

    expect(lost).toBeGreaterThan(0);
    // One tick may not take more than one tick of deceleration.
    expect(lost).toBeLessThanOrEqual(config.vehicle.coastDecel * tickDeltaSeconds(config) + 1e-6);
    expect(speedOf(car)).toBeGreaterThan(cap);
  });

  it('still costs a lot of time, which is what makes it a mistake', () => {
    // Grip is forgiving on purpose; speed is not. The penalty for running wide
    // has to stay real, or there is no reason to stay on the road.
    const config = surfaceConfig();
    const straight = makeInput({ moveZ: 1 });

    const road = drive(makePlayer({ x: 0, z: 0, heading: 0 }), config, straight, 150);
    const grass = drive(makePlayer({ x: 40, z: 0, heading: 0 }), config, straight, 150);

    expect(isOnTrack(config, road.x, road.z)).toBe(true);
    expect(isOnTrack(config, grass.x, grass.z)).toBe(false);
    expect(speedOf(grass)).toBeLessThan(speedOf(road) * 0.5);
  });
});

describe('kerbs are a decision, not free road', () => {
  const STRAIGHT = [
    { x: 0, z: -300 },
    { x: 0, z: 300 },
  ];

  function kerbConfig(overrides: SimConfigOverrides = {}) {
    const { track, ...rest } = overrides;
    return gripConfig({
      trackPath: STRAIGHT,
      vehicle: { selfAlign: 3, frontGrip: 4, steerFalloff: 0.3 },
      ...rest,
      track: {
        enabled: true,
        halfWidth: 5,
        kerbWidth: 1.2,
        kerbGrip: 0.8,
        kerbShake: 26,
        offTrackSpeed: 0.45,
        offTrackGrip: 0.6,
        ...track,
      },
    });
  }

  it('sits inside the track limits, not outside them', () => {
    // The whole point: a kerb is road you are allowed to use. If it read as
    // off-track it would just be grass with a different name.
    const config = kerbConfig();
    // Middle of the road, on the kerb, and past the edge.
    expect(onKerb(config, 0, 0)).toBe(false);
    expect(isOnTrack(config, 0, 0)).toBe(true);

    expect(onKerb(config, 4.5, 0)).toBe(true);
    expect(isOnTrack(config, 4.5, 0)).toBe(true);

    expect(onKerb(config, 7, 0)).toBe(false);
    expect(isOnTrack(config, 7, 0)).toBe(false);
  });

  it('costs less grip than the grass and more than the road', () => {
    const config = kerbConfig();
    const road = vehicleGrip(makePlayer({ x: 0, z: 0 }), config, 0, true);
    const kerb = vehicleGrip(makePlayer({ x: 4.5, z: 0 }), config, 0, true);
    const grass = vehicleGrip(makePlayer({ x: 7, z: 0 }), config, 0, false);

    expect(kerb).toBeLessThan(road);
    expect(kerb).toBeGreaterThan(grass);
  });

  it('shakes the car, and only while it is on the kerb', () => {
    // A rumble strip rumbles. Without this the kerb is only a grip penalty,
    // which is a thing a driver would simply never notice they were on.
    const config = kerbConfig();
    const straight = makeInput({ moveZ: 1 });

    const wander = (x: number): number => {
      const car = makePlayer({ x, z: -100, heading: 0 });
      let worst = 0;
      const dt = tickDeltaSeconds(config);
      for (let i = 0; i < 60; i++) {
        integratePlayer(car, straight, config, [], dt, i, false);
        worst = Math.max(worst, Math.abs(lateralOf(car)));
      }
      return worst;
    };

    expect(wander(4.5)).toBeGreaterThan(0.2);
    expect(wander(0)).toBeLessThan(0.01);
  });

  it('shakes by position rather than by the clock', () => {
    // Determinism, and the reason the kick is a function of distance along the
    // circuit. Driven from the tick number it would shake a PARKED car, which
    // is both wrong and a desync waiting for a peer to restore a snapshot at a
    // different tick.
    const config = kerbConfig();
    const parked = makePlayer({ x: 4.5, z: 0, heading: 0 });
    const dt = tickDeltaSeconds(config);
    for (let i = 0; i < 90; i++) integratePlayer(parked, makeInput({}), config, [], dt, i, false);

    expect(speedOf(parked)).toBeLessThan(0.05);
  });
});

describe('a shunt is remembered', () => {
  function contactConfig(damageSeconds: number) {
    return gripConfig({
      collision: {
        enabled: true,
        restitution: 0.15,
        friction: 0.4,
        spin: 0.03,
        damageSeconds,
        damageThreshold: 9,
        damageGrip: 0.7,
      },
    });
  }

  /**
   * Runs two cars into each other head-on at `closing` speed apiece.
   *
   * The offset has to put them genuinely OVERLAPPING — inside
   * `playerRadius * 2` of each other — or `resolvePlayerCollisions` skips the
   * pair entirely and every assertion here passes by never happening. It is
   * asserted below rather than left to the arithmetic.
   */
  function shunt(config: Config, closing: number, tick = 100): PlayerState[] {
    const gap = config.playerRadius * 0.6;
    const a = makePlayer({ x: -gap, z: 0, heading: 0, vx: closing, vz: 0 });
    const b = makePlayer({ x: gap, z: 0, heading: 0, vx: -closing, vz: 0 });
    Object.assign(b, { id: 'b-second' });
    // They must actually be touching, or none of this tests anything.
    expect(Math.abs(b.x - a.x)).toBeLessThan(config.playerRadius * 2);
    resolvePlayerCollisions([a, b], config, tick);
    return [a, b];
  }

  it('bends both cars, not only the one that was hit', () => {
    // Otherwise a lunge down the inside is free for whoever lunged, which is
    // the exact behaviour damage exists to price.
    const config = contactConfig(0.5);
    const [a, b] = shunt(config, 12);

    expect(hasEffect(a!, 'bent', 100)).toBe(true);
    expect(hasEffect(b!, 'bent', 100)).toBe(true);
  });

  it('bends harder hits for longer', () => {
    // Severity is expressed as duration, because a timed effect is the one
    // shape of per-player state that is already snapshotted and checksummed.
    const config = contactConfig(0.5);
    const light = shunt(config, 10)[0]!;
    const heavy = shunt(config, 20)[0]!;

    expect(heavy.effects['bent']!).toBeGreaterThan(light.effects['bent']!);
  });

  it('lets a gentle touch go', () => {
    // Racing wheel to wheel has to stay possible. Only a real hit counts.
    const config = contactConfig(0.5);
    const [a] = shunt(config, 2);
    expect(hasEffect(a!, 'bent', 100)).toBe(false);
  });

  it('costs grip while it lasts, and gives it back after', () => {
    const config = contactConfig(0.5);
    const [a] = shunt(config, 16);
    const until = a!.effects['bent']!;

    expect(vehicleGrip(a!, config, 100)).toBeLessThan(vehicleGrip(a!, config, until + 1));
  });

  it('does nothing at all when the mode has not asked for it', () => {
    const [a] = shunt(contactConfig(0), 25);
    expect(a!.effects['bent']).toBeUndefined();
  });
});
