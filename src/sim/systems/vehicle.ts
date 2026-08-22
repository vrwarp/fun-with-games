import { angleDelta, clamp, distanceSq2, length2 } from '../../shared/math.js';
import type { SimConfig } from '../config.js';
import { isOnTrack } from '../track.js';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, type PlayerInput, type PlayerState } from '../types.js';
import { effectRemaining, hasEffect, isImmobilized } from './effects.js';

/**
 * Car handling.
 *
 * This is the one place where the kit's movement model changes shape: a car
 * does not strafe. The thumbstick stops being a velocity and becomes a
 * *heading request* — the direction you want to be pointing — and the car
 * rotates toward it at a rate that shrinks as it speeds up. Everything that
 * makes racing feel like racing falls out of that one substitution:
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
 * Pulling the stick back past 90° from the car's nose brakes rather than
 * requesting an impossible instant U-turn, which is both what a player
 * expects and what stops a spin from becoming unrecoverable.
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

/** Stick deflection below which the driver is treated as hands-off. */
const INPUT_DEADZONE = 0.05;
/** Stick alignment below which "forward" is really a request to slow down. */
const BRAKE_ALIGNMENT = -0.25;
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

  const rawX = clamp(input.moveX, -1, 1);
  const rawZ = clamp(input.moveZ, -1, 1);
  const magnitude = Math.min(1, length2(rawX, rawZ));
  const steering = magnitude > INPUT_DEADZONE;

  // --- Steering -------------------------------------------------------------
  let alignment = 1;
  if (steering) {
    const desired = Math.atan2(rawX, rawZ);
    const delta = angleDelta(player.heading, desired);

    // Authority falls away with speed. `top` rather than a constant, so a
    // car in the tow or with DRS open is correspondingly harder to place.
    const speedFraction = top > 0 ? Math.min(1, Math.abs(forward) / top) : 0;
    const authority = 1 - car.steerFalloff * speedFraction;
    const maxTurn = car.steerRate * authority * dt;

    player.heading += clamp(delta, -maxTurn, maxTurn);
    // Measured against the heading we ended up with, not the one we asked
    // for: a car mid-turn is still going where it is pointed.
    alignment = Math.cos(angleDelta(player.heading, desired));
  }

  // --- Throttle and brakes --------------------------------------------------
  const brakeHeld = (input.buttons & buttonBit(car.brakeButton)) !== 0;
  const stickBack = steering && alignment < BRAKE_ALIGNMENT;
  const braking = brakeHeld || stickBack;
  const throttle = steering && !braking ? magnitude : 0;

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

  // Inputs can arrive out of order over an unreliable channel; never regress.
  if (input.seq > player.lastInputSeq) player.lastInputSeq = input.seq;
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
