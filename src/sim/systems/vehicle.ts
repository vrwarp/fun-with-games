import { clamp, distanceSq2 } from '../../shared/math.js';
import type { SimConfig } from '../config.js';
import { isOnTrack } from '../track.js';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, type PlayerInput, type PlayerState } from '../types.js';
import { effectRemaining, hasEffect, isImmobilized } from './effects.js';

/**
 * Car handling.
 *
 * This is the one place where the kit's movement model changes shape: a car
 * does not strafe, and it is not *aimed*. Every other mode reads the stick as
 * a direction in the world — push where you want to be. A car reads its two
 * axes as **two separate controls in the car's own frame**:
 *
 * ```
 *   moveX  −1 … +1   steering, full left to full right
 *   moveZ  +1 … −1   throttle, then coast at 0, then brake and reverse
 * ```
 *
 * They are independent, which is the point: a driver holds a steering angle
 * through a corner while deciding separately how much throttle to carry. A
 * single "point there" vector cannot express that — it conflates the two, and
 * because it is measured against the camera it also behaves differently in
 * every view, and feeds back through the chase camera's own lag. Reading raw
 * axes instead makes the controls identical in all five views: a car is
 * steered relative to itself, and where the camera happens to be is not the
 * car's business.
 *
 * The rest of what makes racing feel like racing falls out of the handling:
 *
 *  - **No strafing.** Speed only ever exists along the car's own axis, so the
 *    only way to change direction is to turn and wait.
 *  - **Understeer.** `steerFalloff` takes steering authority away with speed,
 *    which is what forces a driver to brake *before* the corner rather than
 *    in it.
 *  - **Slides.** Sideways velocity is scrubbed off at `grip` per second
 *    instead of instantly, so a car that turns harder than the tyres allow
 *    washes wide, and a car on grass or on worn rubber washes wider.
 *
 * Steering is live whatever the throttle is doing, so a spun car can be
 * turned around on the spot and driven away — unrecoverable is not a state a
 * thumbstick player should be able to reach.
 *
 * ## Why it lives on the movement path
 *
 * `integratePlayer` delegates here, which means this function runs on the
 * host AND inside every client's prediction replay. That is deliberate and
 * load-bearing: a car is fast, so an unpredicted metre is a visible metre.
 * Everything read here is therefore either config, the player's own state, or
 * an effect (which arrives in the snapshot) — never another player, and never
 * a clock.
 */

/** Deflection below which an axis reads as centred, not as a light touch. */
const INPUT_DEADZONE = 0.05;
/** Speeds below this are snapped to a standstill so a parked car stays parked. */
const REST_SPEED = 0.02;

/** Bit for a configured button name; 0 when the action is unbound. */
function buttonBit(name: 'primary' | 'secondary' | 'none'): number {
  if (name === 'primary') return BUTTON_PRIMARY;
  if (name === 'secondary') return BUTTON_SECONDARY;
  return 0;
}

/**
 * Tyre life left, from 1 (fresh) down to 0 (gone).
 *
 * Wear is the `tyre` effect's remaining duration, which means it is already
 * snapshotted, already on the wire and already checksummed — a set of tyres
 * costs exactly one map entry. With `tyreStintTicks` at 0 there is no wear
 * and this is always 1, which is the case for every non-racing mode.
 */
export function tyreLife(player: PlayerState, config: SimConfig, tick: number): number {
  const stint = config.race.tyreStintTicks;
  if (stint <= 0) return 1;
  return clamp(effectRemaining(player, 'tyre', tick) / stint, 0, 1);
}

/** True when this position is inside a pit-lane zone. */
export function isInPitLane(config: SimConfig, x: number, z: number): boolean {
  for (const zone of config.zones) {
    if (zone.kind !== 'pit') continue;
    if (distanceSq2(x, z, zone.x, zone.z) <= zone.radius * zone.radius) return true;
  }
  return false;
}

/**
 * Top speed right now, folding in every multiplier that can touch a car.
 *
 * Exported because the bots and the HUD both want to know how fast a car
 * *could* be going, and because deriving it twice is how the two quietly
 * disagree.
 */
export function vehicleTopSpeed(
  player: PlayerState,
  config: SimConfig,
  tick: number,
  onTrack = true,
): number {
  let top = config.playerMaxSpeed;

  if (hasEffect(player, 'speed', tick)) top *= config.powerups.speedMultiplier;
  if (hasEffect(player, 'drs', tick)) top *= config.race.drsMultiplier;
  if (hasEffect(player, 'tow', tick)) top *= config.race.slipstreamMultiplier;
  if (player.isBot) top *= config.bots.speedMultiplier;
  if (!onTrack) top *= config.track.offTrackSpeed;

  // Worn rubber is slower in a straight line as well as slipperier — without
  // the speed term a driver would never feel the need to pit.
  const life = tyreLife(player, config, tick);
  top *= config.race.tyreWornSpeed + (1 - config.race.tyreWornSpeed) * life;

  return top;
}

/** Lateral scrub rate right now: the surface and the tyres both scale it. */
export function vehicleGrip(
  player: PlayerState,
  config: SimConfig,
  tick: number,
  onTrack = true,
): number {
  let grip = config.vehicle.grip;
  if (!onTrack) grip *= config.track.offTrackGrip;

  const life = tyreLife(player, config, tick);
  grip *= config.race.tyreWornGrip + (1 - config.race.tyreWornGrip) * life;

  return grip;
}

/**
 * Advances one car's heading and velocity by one step, in place.
 *
 * Position, obstacles and arena bounds are NOT handled here — `integratePlayer`
 * owns those and they are identical for cars and runners. Keeping the split
 * means a car collides with a wall, another car and the arena edge through
 * exactly the code every other mode is already tested against.
 */
export function steerVehicle(
  player: PlayerState,
  input: PlayerInput,
  config: SimConfig,
  dt: number,
  tick: number,
  movementLocked: boolean,
): void {
  const car = config.vehicle;

  // Acknowledged before anything can return early. The host echoes this back
  // in the snapshot, and it is what lets a client drop inputs it no longer
  // needs to replay — so skipping it during a countdown would leave every
  // client replaying four seconds of grid-bound input the moment the lights
  // went out, which is the worst possible moment for a correction.
  if (input.seq > player.lastInputSeq) player.lastInputSeq = input.seq;

  // Decompose velocity into the car's own axes. `heading` is measured the same
  // way the rest of the kit measures it: atan2(x, z), so forward is
  // (sin h, cos h) and the car's right-hand side is (cos h, -sin h).
  const sin = Math.sin(player.heading);
  const cos = Math.cos(player.heading);
  let forward = player.vx * sin + player.vz * cos;
  let lateral = player.vx * cos - player.vz * sin;

  const immobile = movementLocked || isImmobilized(player, tick);
  const onTrack = isOnTrack(config, player.x, player.z);
  const top = vehicleTopSpeed(player, config, tick, onTrack);

  if (immobile) {
    // Lights-out discipline: a car on the grid neither creeps nor rotates, so
    // the grid a player looks at during the countdown is the grid they start
    // from. Bleeding rather than zeroing keeps a shunt from teleporting.
    const decay = Math.max(0, 1 - 12 * dt);
    forward *= decay;
    lateral *= decay;
    writeBack(player, forward, lateral, sin, cos);
    return;
  }

  const steer = centred(clamp(input.moveX, -1, 1));
  const pedal = centred(clamp(input.moveZ, -1, 1));

  // --- Steering -------------------------------------------------------------
  // Live regardless of the throttle: a driver steers through a corner they are
  // braking into, and a stationary car still has to be able to point itself.
  if (steer !== 0) {
    // Authority falls away with speed. `top` rather than a constant, so a
    // car in the tow or with DRS open is correspondingly harder to place.
    const speedFraction = top > 0 ? Math.min(1, Math.abs(forward) / top) : 0;
    const authority = 1 - car.steerFalloff * speedFraction;
    player.heading += steer * car.steerRate * authority * dt;
  }

  // --- Throttle and brakes --------------------------------------------------
  const brakeHeld = (input.buttons & buttonBit(car.brakeButton)) !== 0;
  const braking = brakeHeld || pedal < 0;
  const throttle = braking ? 0 : pedal;

  if (braking) {
    if (forward > 0) {
      forward = Math.max(0, forward - car.brakeDecel * dt);
    } else {
      // Stopped and still asking to go backwards: reverse out, gently.
      const reverseTop = top * car.reverseFraction;
      forward = Math.max(-reverseTop, forward - car.engineAccel * 0.6 * dt);
    }
  } else if (throttle > 0) {
    const target = top * throttle;
    if (forward < target) {
      forward = Math.min(target, forward + car.engineAccel * throttle * dt);
    } else {
      // Above the current ceiling: DRS just closed, the tow ran out, or all
      // four wheels found the grass. Bleed it off rather than clamping, so
      // losing a boost coasts down instead of hitting a wall of air.
      forward = Math.max(target, forward - car.coastDecel * dt);
    }
  } else {
    // Hands off: engine braking, toward a standstill from either direction.
    forward =
      forward > 0
        ? Math.max(0, forward - car.coastDecel * dt)
        : Math.min(0, forward + car.coastDecel * dt);
  }

  // --- Grip -----------------------------------------------------------------
  // Sideways speed decays rather than vanishing, which IS the slide.
  lateral *= Math.max(0, 1 - vehicleGrip(player, config, tick, onTrack) * dt);

  // --- Pit limiter ----------------------------------------------------------
  // Predicted on the client like everything else here, so the limiter bites at
  // the same metre on every screen instead of rubber-banding at the pit entry.
  if (config.race.pitSpeedLimit > 0 && isInPitLane(config, player.x, player.z)) {
    forward = Math.min(forward, config.race.pitSpeedLimit);
    lateral = clamp(lateral, -config.race.pitSpeedLimit, config.race.pitSpeedLimit);
  }

  writeBack(player, forward, lateral, sin, cos);
}

/** Treats a barely-touched axis as centred, so a resting thumb does nothing. */
function centred(value: number): number {
  return Math.abs(value) < INPUT_DEADZONE ? 0 : value;
}

/** Recomposes car-local velocity back into world axes. */
function writeBack(
  player: PlayerState,
  forward: number,
  lateral: number,
  sin: number,
  cos: number,
): void {
  const vx = forward * sin + lateral * cos;
  const vz = forward * cos - lateral * sin;
  player.vx = Math.abs(vx) < REST_SPEED ? 0 : vx;
  player.vz = Math.abs(vz) < REST_SPEED ? 0 : vz;
}
