import { angleDelta, clamp } from '../shared/math.js';
import type { SimConfig } from './config.js';

/**
 * What the two movement axes MEAN — the one place that decides.
 *
 * `PlayerInput.moveX` / `moveZ` carry two different contracts depending on the
 * mode, and until this module existed the choice between them was made
 * independently in two places: once in `systems/bots.ts`, for the bots, and
 * once in `main.ts`, for the human. That is exactly the shape of bug that
 * cannot be caught, because the two halves fail in opposite directions and
 * neither notices:
 *
 *  - A bot drives the car correctly while the player's stick is inverted, so
 *    every headless test passes and only a human at a phone finds out.
 *  - Or the player is fine and the bots quietly drive into the scenery, which
 *    reads as "the AI is bad" rather than "the contract moved".
 *
 * So the contract lives here, both callers ask, and it is unit-tested on its
 * own. Adding a third control scheme means changing one function rather than
 * remembering to change two.
 *
 * The two contracts:
 *
 * ```
 *   on foot   moveX/moveZ  a DIRECTION in the world, rotated by camera yaw
 *   in a car  moveX/moveZ  STEERING and THROTTLE in the car's own frame
 * ```
 *
 * This is `src/sim` and therefore pure: no DOM, no clock, no randomness. That
 * matters, because it is what lets a headless test drive a "player" through
 * the very same function a thumb reaches, and so lets a bot race prove the
 * human's control surface works.
 */

/**
 * True when the axes are a car's — steering and throttle in the car's own
 * frame — rather than a direction in the world.
 *
 * The render layer additionally uses this to decide whether to rotate a
 * device's axes by the camera's yaw. A car must NOT be rotated: steering is
 * steering whatever the camera is doing, which is what makes driving identical
 * in every view and what stops a chase camera's own lag feeding back into the
 * front axle.
 */
export function usesVehicleAxes(config: SimConfig): boolean {
  return config.vehicle.enabled;
}

/**
 * Deflection below which an axis reads as centred rather than as a light touch.
 *
 * Shared with the render layer for the same reason as everything else here.
 * A physical control has its own noise floor, and a device that let a smaller
 * deflection through than the simulation is willing to act on would open a
 * dead band nobody could see: the knob moves, the number changes, and the car
 * does nothing. Devices may round up to their own floor; they must not go
 * under this one.
 */
export const INPUT_DEADZONE = 0.05;

/** Treats a barely-touched axis as centred, so a resting thumb does nothing. */
export function centred(value: number): number {
  return Math.abs(value) < INPUT_DEADZONE ? 0 : value;
}

/**
 * Heading error at which a driver asks for full lock. About 29°, so the nose
 * comes round briskly without sawing at the wheel down a straight.
 */
export const FULL_LOCK_ERROR = 0.5;

/**
 * The lock a driver would wind on to correct a heading error.
 *
 * Deliberately a plain proportional law rather than an inversion of the car's
 * own `omega = speed * tan(angle) / wheelbase`. Both of the cleverer versions
 * were tried and measured worse: asking for the arc that wipes the error out
 * put the field in the scenery 31% of the time, and clamping that request to
 * the grip available made it 77%, because a car that has strayed has almost no
 * grip and so asks for almost no lock — which is precisely when it needs some.
 * A driver does not solve for the radius either; they wind on lock until the
 * nose comes round.
 */
export function steeringFor(error: number): number {
  return clamp(error / FULL_LOCK_ERROR, -1, 1);
}

/** How hard, and which way, the driver wants to go. */
export interface DriveIntent {
  /**
   * How much of the available speed to ask for, in [0, 1]. On foot this scales
   * the stick's deflection; in a car it is the throttle pedal.
   */
  readonly throttle?: number;
  /** Stand on the brake. Only meaningful in a car. */
  readonly brake?: boolean;
  /**
   * Back out rather than driving out.
   *
   * A car yaws because its wheels are rolling, so one stopped facing a barrier
   * cannot steer its way out — there is nothing to steer WITH. The way out in
   * a real car is reverse, and reversing swings the nose the opposite way for
   * a given lock, so the steering is mirrored to match.
   */
  readonly reverse?: boolean;
}

/**
 * Turns a wanted direction in the world into the two axes this mode reads.
 *
 * This is where a bot's brain and a player's thumb meet. A bot decides where
 * it wants to be and comes through here; a human's device produces the axes
 * directly, having already been told by `usesVehicleAxes` which contract it is
 * writing to. Both then hand the identical `PlayerInput` shape to
 * `integratePlayer`, which is why a headless bot race is evidence about the
 * control surface a person uses and not merely about the AI.
 *
 * `direction` is expected normalized; a zero vector means "no steering input",
 * which for a car still leaves the pedal free to drive it straight.
 */
export function axesForDirection(
  config: SimConfig,
  heading: number,
  direction: { readonly x: number; readonly z: number },
  drive: DriveIntent = {},
): { moveX: number; moveZ: number } {
  const throttle = drive.throttle ?? 1;

  if (!usesVehicleAxes(config)) {
    // On foot the axes ARE the direction, scaled by how much of it is wanted.
    // Nothing is read in the body's own frame: a person is steered like a
    // cursor, so the world direction goes straight through.
    return { moveX: direction.x * throttle, moveZ: direction.z * throttle };
  }

  // A car is driven, not pointed. The pedal and the wheel are separate
  // controls, so they are answered separately.
  const pedal = drive.reverse || drive.brake ? -1 : throttle;
  if (direction.x === 0 && direction.z === 0) return { moveX: 0, moveZ: pedal };

  const wanted = Math.atan2(direction.x, direction.z);
  const lock = steeringFor(angleDelta(heading, wanted));
  // Mirrored while backing up: the same lock swings the nose the other way
  // when the car is rolling backwards, exactly as it does in a car park.
  return { moveX: drive.reverse ? -lock : lock, moveZ: pedal };
}
