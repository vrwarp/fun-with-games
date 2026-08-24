import { describe, expect, it } from 'vitest';
import {
  INPUT_DEADZONE,
  axesForDirection,
  centred,
  steeringFor,
  usesVehicleAxes,
} from '@/sim/controls.js';
import { makeSimConfig } from '@/sim/config.js';
import { modeConfig } from '@/sim/presets.js';
import { GAME_MODES } from '@/shared/modes.js';
import { World } from '@/sim/world.js';
import { sampleTrack, trackLength, trackPoseAt } from '@/sim/track.js';
import type { SimConfig } from '@/sim/config.js';
import type { PlayerState } from '@/sim/types.js';

/**
 * The control contract that a bot's brain and a player's thumb both write to.
 *
 * The reason this module exists at all is that the answer to "what do these two
 * axes mean?" used to be worked out independently in `systems/bots.ts` and in
 * `main.ts`. Two independent answers to one question is a bug that hides: the
 * half that is wrong passes every test the other half runs. So the contract is
 * one function, both callers ask it, and this file checks it directly — plus,
 * at the bottom, drives a HUMAN's control surface headlessly, which is the
 * thing that could not be tested before.
 */

const car = (): SimConfig =>
  makeSimConfig({ vehicle: { enabled: true }, playerMaxSpeed: 20, obstacleCount: 0 });
const runner = (): SimConfig => makeSimConfig({ obstacleCount: 0 });

describe('which contract a mode is on', () => {
  it('agrees with the mode presets, one answer per mode', () => {
    // Not an interesting assertion on its own — the point is that there is a
    // single function to assert against, so the renderer, the bots and the
    // input pipeline cannot each hold a different opinion.
    for (const mode of GAME_MODES) {
      const config = modeConfig(mode.id);
      expect(usesVehicleAxes(config)).toBe(config.vehicle.enabled);
    }
  });

  it('is what decides whether a device gets rotated by the camera', () => {
    // The render layer's only question. A car must never be rotated into the
    // camera's frame or the chase camera's own lag feeds back into the front
    // axle; a runner always must, or "up" stops meaning "away from me".
    expect(usesVehicleAxes(modeConfig('grandprix'))).toBe(true);
    expect(usesVehicleAxes(modeConfig('street'))).toBe(true);
    expect(usesVehicleAxes(modeConfig('tag'))).toBe(false);
  });
});

describe('a direction becomes the axes the mode reads', () => {
  it('passes a world direction straight through on foot', () => {
    // A person is steered like a cursor: the direction IS the input.
    const axes = axesForDirection(runner(), 1.2, { x: 0, z: 1 });
    expect(axes.moveX).toBeCloseTo(0, 6);
    expect(axes.moveZ).toBeCloseTo(1, 6);
  });

  it('scales a walk by how much of the direction is wanted', () => {
    const axes = axesForDirection(runner(), 0, { x: 0, z: 1 }, { throttle: 0.5 });
    expect(axes.moveZ).toBeCloseTo(0.5, 6);
  });

  it('ignores the body heading on foot, and reads it in a car', () => {
    // The distinction the whole module is about. Same request, same direction,
    // two headings: a runner does not care which way it was facing, a car does
    // because "steering" is only meaningful relative to the nose.
    const straight = { x: 0, z: 1 };
    expect(axesForDirection(runner(), 0, straight)).toEqual(
      axesForDirection(runner(), 2.5, straight),
    );
    expect(axesForDirection(car(), 0, straight).moveX).not.toBe(
      axesForDirection(car(), 2.5, straight).moveX,
    );
  });

  it('winds on lock toward the wanted heading, and unwinds when square', () => {
    const config = car();
    // Pointing along +z, asked for +x: a right-hand turn is positive.
    expect(axesForDirection(config, 0, { x: 1, z: 0 }).moveX).toBeGreaterThan(0);
    expect(axesForDirection(config, 0, { x: -1, z: 0 }).moveX).toBeLessThan(0);
    // Already pointing there: no correction at all.
    expect(axesForDirection(config, 0, { x: 0, z: 1 }).moveX).toBeCloseTo(0, 6);
  });

  it('leaves the pedal free when there is no steering to do', () => {
    // A car with no direction still has a throttle: "nowhere in particular"
    // means straight on, not stop.
    const axes = axesForDirection(car(), 0, { x: 0, z: 0 }, { throttle: 0.6 });
    expect(axes.moveX).toBe(0);
    expect(axes.moveZ).toBeCloseTo(0.6, 6);
  });

  it('mirrors the lock in reverse, the way a car park does', () => {
    const config = car();
    const wanted = { x: 1, z: 0 };
    const forwards = axesForDirection(config, 0, wanted).moveX;
    const backwards = axesForDirection(config, 0, wanted, { reverse: true }).moveX;

    expect(backwards).toBeCloseTo(-forwards, 6);
    // And reverse means the pedal is pulled back, whatever the throttle said.
    expect(axesForDirection(config, 0, wanted, { reverse: true, throttle: 1 }).moveZ).toBe(-1);
  });

  it('puts the brake ahead of the throttle', () => {
    expect(axesForDirection(car(), 0, { x: 1, z: 0 }, { brake: true, throttle: 1 }).moveZ).toBe(-1);
  });
});

describe('the deadzone floor', () => {
  it('centres a resting thumb and passes anything deliberate', () => {
    expect(centred(0)).toBe(0);
    expect(centred(INPUT_DEADZONE * 0.9)).toBe(0);
    expect(centred(-INPUT_DEADZONE * 0.9)).toBe(0);
    expect(centred(0.4)).toBe(0.4);
    expect(centred(-0.4)).toBe(-0.4);
  });

  it('is small enough to leave a light touch usable', () => {
    // A floor set too high is not a safety measure, it is a control with a
    // notch in it — the first tenth of the wheel's travel doing nothing.
    expect(INPUT_DEADZONE).toBeGreaterThan(0);
    expect(INPUT_DEADZONE).toBeLessThan(0.1);
  });
});

describe('steeringFor', () => {
  it('is proportional up to full lock and clamped past it', () => {
    expect(steeringFor(0)).toBe(0);
    expect(steeringFor(0.25)).toBeCloseTo(0.5, 6);
    expect(steeringFor(5)).toBe(1);
    expect(steeringFor(-5)).toBe(-1);
  });

  it('is symmetric', () => {
    for (const error of [0.1, 0.3, 0.7, 2]) {
      expect(steeringFor(-error)).toBeCloseTo(-steeringFor(error), 6);
    }
  });
});

/**
 * A human's control surface, driven headlessly.
 *
 * This is the payoff for having one contract instead of two. `driveLikeAPlayer`
 * is a competent thumb: it looks a little way up the road and asks to go there,
 * exactly as a person does, and it reaches the simulation through the SAME
 * function a bot does and the same one `main.ts` writes to. So an inverted
 * axis, a mirrored lock, or a contract that quietly moved now fails here — on
 * the player's path — in about a second, instead of surviving until somebody
 * picks up a phone.
 */
function driveLikeAPlayer(config: SimConfig, player: PlayerState, lookahead: number) {
  const length = trackLength(config.trackPath);
  const here = sampleTrack(config.trackPath, player.x, player.z);
  const aim = trackPoseAt(config.trackPath, (here.progress + lookahead) % length);

  const dx = aim.x - player.x;
  const dz = aim.z - player.z;
  const span = Math.hypot(dx, dz) || 1;
  const direction = { x: dx / span, z: dz / span };

  // Lift in proportion to the lock being wound on, which is what a person does
  // and all a person can do — no radius solved for, no grip budget consulted.
  // Deliberately NOT the bots' cornering model: borrowing that would make this
  // a test of the bots rather than of the controls they share.
  const lock = Math.abs(axesForDirection(config, player.heading, direction).moveX);
  return axesForDirection(config, player.heading, direction, { throttle: 1 - 0.55 * lock });
}

describe('the same controls carry a player, not just a bot', () => {
  /**
   * Races one hand-driven, NON-bot car and reports the most laps it ever held.
   *
   * The peak rather than the final value, because a grand prix that is won
   * inside the window starts a fresh round and puts the counter back to zero —
   * a driver who did the job perfectly would otherwise read as one who never
   * left the grid.
   */
  function raceAHuman(
    config: SimConfig,
    seconds: number,
    thumb: (axes: { moveX: number; moveZ: number }) => { moveX: number; moveZ: number } = (a) => a,
  ): number {
    const world = new World({ config, seed: 5 });
    // Deliberately NOT a bot. Nothing in `systems/bots.ts` runs for this car;
    // the inputs below are the ones a person's device would have produced.
    world.addPlayer('a-human', { name: 'Driver', color: '#fff' });
    // A second car, so the round has enough starters to go green.
    world.addBot();

    let best = 0;
    for (let i = 0; i < config.tickRate * seconds; i++) {
      const player = world.getPlayer('a-human')!;
      const axes = thumb(driveLikeAPlayer(config, player, 14));
      world.setInput('a-human', { seq: i, ...axes, sprint: false, buttons: 0 });
      world.step();
      best = Math.max(best, world.getPlayer('a-human')!.lap);
    }
    return best;
  }

  it.each(['grandprix', 'street'] as const)('gets a human round %s', (mode) => {
    expect(raceAHuman(modeConfig(mode), 60)).toBeGreaterThan(2);
  });

  it('would notice the steering being inverted', () => {
    // The guard rail proving the test above has teeth. Same control function,
    // same everything, with only the lock flipped — the single mistake most
    // likely to be made in the render layer, and one that was invisible to
    // every bot test before this module existed.
    const inverted = raceAHuman(modeConfig('grandprix'), 60, (axes) => ({
      moveX: -axes.moveX,
      moveZ: axes.moveZ,
    }));
    expect(inverted).toBe(0);
  });

  it('would notice the throttle and the wheel being swapped', () => {
    // The other way the contract can move: a device writing a direction where
    // the car expects steering-and-throttle. It is the exact failure that
    // rotating a car's axes into the camera frame would produce.
    const swapped = raceAHuman(modeConfig('grandprix'), 60, (axes) => ({
      moveX: axes.moveZ,
      moveZ: axes.moveX,
    }));
    expect(swapped).toBe(0);
  });
});
