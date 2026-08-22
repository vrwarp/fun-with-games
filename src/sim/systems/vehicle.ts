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
 *  - **A traction limit.** `tyreGrip` is the most lateral acceleration the
 *    tyres can make. Holding a line costs `speed × yawRate`, so the same
 *    steering angle that grips at walking pace lets go at racing pace. The
 *    driver is never denied the steering angle — physics decides whether the
 *    car follows it, which is the difference between understeer by fiat and
 *    understeer you can feel arriving.
 *  - **Drift.** Whatever the tyres cannot erase survives as sideways velocity.
 *    It costs forward speed while it lasts and unwinds through the
 *    self-aligning moment, so a slide is catchable, punishing, and never the
 *    quick way round.
 *  - **The friction circle.** Braking and cornering come out of the same
 *    budget, which is where trail braking and power oversteer come from.
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
/** Below this speed the front tyres have nothing to lose, so the yaw cap lifts. */
const YAW_CAP_SPEED = 1;
/**
 * Speed at which the self-aligning moment reaches full strength.
 *
 * Below it the term fades away with the car, which is both what a real
 * steering rack does and what stops a barely-moving car being spun by its own
 * tyres.
 */
const SELF_ALIGN_FULL_SPEED = 12;

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

/**
 * Peak lateral acceleration the tyres can supply right now.
 *
 * The traction limit, scaled by the same surface and wear terms as the
 * residual scrub — grass and worn rubber let go sooner, which is the whole
 * reason to stay on the road and to pit before the tyres are gone.
 */
export function vehicleTraction(
  player: PlayerState,
  config: SimConfig,
  tick: number,
  onTrack = true,
): number {
  let traction = config.vehicle.tyreGrip;
  if (traction <= 0) return 0;
  if (!onTrack) traction *= config.track.offTrackGrip;

  const life = tyreLife(player, config, tick);
  traction *= config.race.tyreWornGrip + (1 - config.race.tyreWornGrip) * life;

  return traction;
}

/**
 * Slip angle: the angle between where the car points and where it is going.
 *
 * Zero means the car is tracking its nose. Large means it is sideways, and the
 * sign says which way — positive when the car is travelling to the right of
 * where it is pointed. This is the number a driver reads off the seat of their
 * trousers, and the renderer and the bots both want it.
 */
export function slipAngle(player: PlayerState): number {
  const sin = Math.sin(player.heading);
  const cos = Math.cos(player.heading);
  const forward = player.vx * sin + player.vz * cos;
  const lateral = player.vx * cos - player.vz * sin;
  if (Math.abs(forward) < REST_SPEED && Math.abs(lateral) < REST_SPEED) return 0;
  return Math.atan2(lateral, Math.abs(forward));
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
  const traction = vehicleTraction(player, config, tick, onTrack);

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
    //
    // With a traction limit configured this is a light touch — the steering
    // rack is not what stops a car cornering, the tyres are, and taking the
    // authority away here would pre-empt the physics below with a fiat.
    const speedFraction = top > 0 ? Math.min(1, Math.abs(forward) / top) : 0;
    const authority = 1 - car.steerFalloff * speedFraction;
    let yaw = steer * car.steerRate * authority * dt;

    // The rack can out-ask the tyres, but a front axle that has lost grip does
    // not rotate the car — it washes out, and the car goes straight on. Cap
    // the demand at the yaw the tyres can actually hold (w = a / v), times the
    // rope the mode is willing to give the driver. Below walking pace there is
    // no grip to lose, so the cap lifts and a car can still be turned around
    // on the spot.
    const rolling = Math.abs(forward);
    if (traction > 0 && car.frontGrip > 0 && rolling > YAW_CAP_SPEED) {
      const holdable = (traction / rolling) * car.frontGrip * dt;
      yaw = clamp(yaw, -holdable, holdable);
    }

    player.heading += yaw;

    // Turning the car turns its frame, not its momentum. Re-express the same
    // world velocity in the heading we just arrived at, so the tyres below act
    // in the frame the car is actually in. Skipping this is not merely less
    // tidy: it leaves the velocity a tick behind the nose, which reads as a
    // permanent couple of degrees of slip on a car that is gripping perfectly.
    const c = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const rotatedForward = forward * c + lateral * sy;
    lateral = lateral * c - forward * sy;
    forward = rotatedForward;
  }

  // --- Throttle and brakes --------------------------------------------------
  const brakeHeld = (input.buttons & buttonBit(car.brakeButton)) !== 0;
  const braking = brakeHeld || pedal < 0;
  const throttle = braking ? 0 : pedal;

  // How hard the tyres are working lengthways this tick. The friction circle
  // below spends what is left of them on cornering. Every branch below sets
  // it, so it deliberately starts unassigned rather than at a zero no path
  // ever reads.
  let longitudinalLoad: number;

  // How much of the car's motion is along its own nose.
  //
  // Engine braking and drag act on a car that is ROLLING, and a car travelling
  // sideways is not: at ninety degrees of slip there is nothing for them to
  // work against. Applying them at full strength anyway pins `forward` at zero
  // every single tick — the decel is far larger than the speed the tyres put
  // back — which holds the slip angle at a right angle, and a right angle is
  // the largest input the self-aligning moment can be handed. The car then
  // turns at more than `steerRate` for ever and the driver cannot steer out of
  // it, which is a car that has simply stopped being drivable.
  const travelSpeed = Math.sqrt(forward * forward + lateral * lateral);
  const rollingShare = travelSpeed > REST_SPEED ? Math.abs(forward) / travelSpeed : 1;
  const coastDecel = car.coastDecel * rollingShare;

  if (braking) {
    if (forward > 0) {
      longitudinalLoad = car.brakeDecel;
      forward = Math.max(0, forward - car.brakeDecel * dt);
    } else {
      // Stopped and still asking to go backwards: reverse out, gently.
      const reverseTop = top * car.reverseFraction;
      longitudinalLoad = car.engineAccel * 0.6;
      forward = Math.max(-reverseTop, forward - car.engineAccel * 0.6 * dt);
    }
  } else if (throttle > 0) {
    const target = top * throttle;
    if (forward < target) {
      longitudinalLoad = car.engineAccel * throttle;
      forward = Math.min(target, forward + car.engineAccel * throttle * dt);
    } else {
      // Above the current ceiling: DRS just closed, the tow ran out, or all
      // four wheels found the grass. Bleed it off rather than clamping, so
      // losing a boost coasts down instead of hitting a wall of air.
      longitudinalLoad = coastDecel;
      forward = Math.max(target, forward - coastDecel * dt);
    }
  } else {
    // Hands off: engine braking, toward a standstill from either direction.
    longitudinalLoad = coastDecel;
    forward =
      forward > 0 ? Math.max(0, forward - coastDecel * dt) : Math.min(0, forward + coastDecel * dt);
  }

  // --- Tyres ----------------------------------------------------------------
  // Steering above rotated the car. It did NOT rotate the car's momentum:
  // velocity is decomposed and written back in the heading the tick began
  // with, so a turn leaves the old velocity pointing slightly across the new
  // nose. That leftover is `lateral`, and what the tyres can do about it is
  // the whole of the handling model.
  if (traction > 0) {
    // The friction circle. One contact patch has to serve both stopping and
    // turning, so what the brakes are already using is not available to the
    // front end — which is what makes trail braking a real technique and
    // standing on the brakes mid-corner a real mistake.
    const spent = Math.min(1, (longitudinalLoad / traction) * car.frictionCircle);
    const limit = traction * Math.sqrt(Math.max(0, 1 - spent * spent));

    // Holding a line costs `speed × yawRate` of lateral acceleration. Below
    // the limit the tyres erase the leftover completely and the car tracks its
    // nose; above it they erase what they can and the surplus survives as
    // sideways velocity. That surplus IS the slide, and because the demand
    // scales with speed the same steering angle grips slowly and lets go fast.
    const scrub = limit * dt;
    if (Math.abs(lateral) <= scrub) {
      lateral = 0;
    } else {
      lateral -= Math.sign(lateral) * scrub;
      const slip = Math.atan2(lateral, Math.abs(forward));

      // Self-aligning moment. A real steering rack is pulled straight by the
      // caster in proportion to how sideways the car is, and that is what
      // makes a slide catchable rather than terminal. It only ever acts on a
      // car that is ALREADY sliding — a gripping car has scrubbed to zero
      // above and gets none of this — so it assists the driver without
      // driving for them.
      //
      // Like the steering above, this re-expresses the velocity in the frame
      // the rotation produced. Rotating the car without doing so would carry
      // its momentum around with it, which leaves the slip angle exactly where
      // it started and spins the car on the spot for ever.
      if (car.selfAlign > 0) {
        // Scaled by how fast the car is actually travelling, because the
        // aligning moment comes from the tyres ROLLING: a car barely moving
        // has none, and a parked one certainly has none.
        //
        // Without that scaling a car nudged sideways at walking pace is
        // rotated several radians a second for ever. Engine braking zeroes the
        // forward component every tick — it is far larger than the speed the
        // rotation puts back — so the slip angle is pinned at a right angle,
        // which is the largest input this term can be given, and it acts on it
        // happily. The result spins faster than `steerRate`, so the driver
        // cannot steer out of it: the car simply turns one way until the round
        // ends.
        const speed = Math.sqrt(forward * forward + lateral * lateral);
        const rolling = Math.min(1, speed / SELF_ALIGN_FULL_SPEED);
        // And never past the slip it is correcting. Overshoot is a wobble at
        // small angles and a spin at large ones.
        const align = clamp(slip * car.selfAlign * dt * rolling, -Math.abs(slip), Math.abs(slip));
        player.heading += align;
        const ca = Math.cos(align);
        const sa = Math.sin(align);
        const alignedForward = forward * ca + lateral * sa;
        lateral = lateral * ca - forward * sa;
        forward = alignedForward;
      }
    }
  } else {
    // No traction limit configured: the original proportional scrub, which
    // washes wide under load but can never actually let go.
    lateral *= Math.max(0, 1 - vehicleGrip(player, config, tick, onTrack) * dt);
  }

  // --- Pit limiter ----------------------------------------------------------
  // Predicted on the client like everything else here, so the limiter bites at
  // the same metre on every screen instead of rubber-banding at the pit entry.
  if (config.race.pitSpeedLimit > 0 && isInPitLane(config, player.x, player.z)) {
    forward = Math.min(forward, config.race.pitSpeedLimit);
    lateral = clamp(lateral, -config.race.pitSpeedLimit, config.race.pitSpeedLimit);
  }

  // The heading may have moved since `sin`/`cos` were taken, and `forward` and
  // `lateral` were rotated to match, so recompose in the frame we ended in.
  writeBack(player, forward, lateral, Math.sin(player.heading), Math.cos(player.heading));
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
