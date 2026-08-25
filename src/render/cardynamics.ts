/**
 * What a car's body and wheels are visibly doing, derived after the fact.
 *
 * ## Why this exists at all
 *
 * A parked screenshot of the car looks right; the car in MOTION gives the
 * whole game away, because nothing on it moves. Wheels that do not spin, a
 * front axle that never steers, a body that never leans — the eye reads all of
 * that long before it reads a material, and no amount of shading fixes a
 * statue.
 *
 * ## Why it is derived rather than transmitted
 *
 * None of this is simulation state and none of it goes on the wire. The
 * renderer already receives position, heading and velocity for every car;
 * everything visible here is a pure function of those over time:
 *
 *   - wheel spin IS distance over radius;
 *   - the steering angle falls out of the bicycle model run BACKWARD — the
 *     simulation turns lock into yaw rate, so yaw rate turns back into lock;
 *   - pitch and roll are the acceleration, which is the velocity differenced;
 *   - brake glow is longitudinal deceleration held briefly, because metal
 *     cools slower than it heats.
 *
 * Adding any of it to the protocol would be paying bandwidth for numbers every
 * peer can already compute, and would tie presentation polish to a
 * PROTOCOL_VERSION bump.
 *
 * ## Why it is pure
 *
 * Sign conventions are the whole hazard: a wheel spinning backward or a car
 * leaning INTO a corner both look "off" without looking wrong, and a
 * screenshot cannot catch either. Pure functions over numbers can be pinned in
 * milliseconds — which way the nose dips under braking is a unit test, not a
 * squint at a video.
 */

/** Difference between two angles, wrapped to (-PI, PI]. */
export function angleDelta(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

/**
 * The steering lock implied by how fast the car is actually yawing.
 *
 * The simulation's kinematic bicycle model is `yawRate = v * tan(lock) / L`,
 * so the inverse is exact, not an approximation: `lock = atan(yawRate * L / v)`.
 * Below a walking pace the division blows up — a car rotating in place from a
 * shunt would show full lock — so the estimate fades to straight-ahead instead,
 * which is also what real wheels read as when a car is barely moving.
 */
export function steerFromYaw(
  yawRate: number,
  speed: number,
  wheelbase: number,
  maxLock: number,
): number {
  if (speed < 0.5) return 0;
  const lock = Math.atan((yawRate * wheelbase) / speed);
  return Math.max(-maxLock, Math.min(maxLock, lock));
}

/**
 * How far a wheel turns this frame, in radians about its axle.
 *
 * Distance over radius; positive speed rolls the wheel forward. The one
 * subtlety is that this must come from SPEED and not from slip-corrected
 * anything — a locked-wheel skid is invisible at this scale, and a wheel that
 * visibly stops while the car moves reads as a glitch rather than as a skid.
 */
export function wheelSpinDelta(speed: number, radius: number, deltaSeconds: number): number {
  if (radius <= 0) return 0;
  return (speed / radius) * deltaSeconds;
}

/** Acceleration split into the car's own axes, from two velocity samples. */
export function bodyAcceleration(
  heading: number,
  vx: number,
  vz: number,
  previousVx: number,
  previousVz: number,
  deltaSeconds: number,
): { forward: number; lateral: number } {
  if (deltaSeconds <= 0) return { forward: 0, lateral: 0 };
  const ax = (vx - previousVx) / deltaSeconds;
  const az = (vz - previousVz) / deltaSeconds;
  const sin = Math.sin(heading);
  const cos = Math.cos(heading);
  // Forward is (sin h, cos h), matching the simulation; right is (cos h, -sin h).
  return { forward: ax * sin + az * cos, lateral: ax * cos - az * sin };
}

/**
 * Radians of body lean per unit of acceleration, and the most it will show.
 *
 * A grand prix car is the stiffest thing on wheels, so the amounts are small —
 * the cue matters, not the amplitude. Anything past a few degrees reads as a
 * boat, and worse, the cockpit camera is bolted to the car, so excessive pitch
 * becomes excessive HORIZON movement for the driver.
 */
const LEAN_PER_ACCEL = 0.004;
const MAX_LEAN = 0.05;

/**
 * Body attitude from acceleration: the sprung mass leaning on its suspension.
 *
 * Signs, spelled out because they are the entire content of this function:
 * the body tilts AGAINST acceleration. Accelerating (forward > 0) squats the
 * tail, which pitches the nose UP — negative rotation about X for a +Z-facing
 * car. Braking dives the nose. A left turn (lateral < 0) rolls the body OUT of
 * the corner, to the right. Getting either backward produces a car that leans
 * into corners like a motorcycle, which is the single most common way this
 * effect is shipped wrong.
 */
export function bodyAttitude(
  forwardAccel: number,
  lateralAccel: number,
): { pitch: number; roll: number } {
  const clamp = (value: number): number => Math.max(-MAX_LEAN, Math.min(MAX_LEAN, value));
  return {
    pitch: clamp(-forwardAccel * LEAN_PER_ACCEL),
    roll: clamp(-lateralAccel * LEAN_PER_ACCEL),
  };
}

/** Deceleration (m/s^2) at which the rims begin to glow. */
const GLOW_THRESHOLD = 6;
/** Deceleration at which the glow saturates. */
const GLOW_FULL = 22;
/** How fast the glow cools, per second. Heating is instant; cooling is not. */
const GLOW_COOL_RATE = 1.4;

/**
 * Brake glow, stepped one frame: hot instantly under braking, cooling slowly.
 *
 * The asymmetry is the realism. Discs heat in the second they are used and
 * shed it over many; a glow that vanished the instant the brake lifted would
 * flicker with every stab of trail braking instead of telling the story of a
 * heavy stop. Coasting drag sits well under the threshold, so cruising never
 * glows.
 */
export function brakeGlowStep(
  current: number,
  forwardAccel: number,
  speed: number,
  deltaSeconds: number,
): number {
  const braking = speed > 2 && forwardAccel < -GLOW_THRESHOLD;
  const target = braking
    ? Math.min(1, (-forwardAccel - GLOW_THRESHOLD) / (GLOW_FULL - GLOW_THRESHOLD))
    : 0;
  if (target > current) return target;
  return Math.max(target, current - GLOW_COOL_RATE * deltaSeconds);
}

/**
 * Exponential approach: moves `current` toward `target` at `rate` per second.
 *
 * Frame-rate independent, which matters here more than usual — this game runs
 * anywhere from 120fps to the single digits of a software rasteriser, and a
 * naive `lerp(a, b, 0.1)` per frame would lean the car ten times harder on the
 * fast machine.
 */
export function approach(
  current: number,
  target: number,
  rate: number,
  deltaSeconds: number,
): number {
  const blend = 1 - Math.exp(-rate * deltaSeconds);
  return current + (target - current) * blend;
}
