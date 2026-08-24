import { clamp, distanceSq2 } from '../../shared/math.js';
import type { SimConfig } from '../config.js';
import { centred } from '../controls.js';
import { hasTrack, isOnTrack, sampleTrack } from '../track.js';
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
/** Most of the car's weight that may ever sit on one axle's transfer. */
const MAX_TRANSFER = 0.35;
/** Load floor per axle. A weightless axle has no grip, and no car has one. */
const MIN_AXLE_LOAD = 0.15;
/**
 * Ribs per world unit along a kerb.
 *
 * Chosen so a car at racing speed crosses several a second — fast enough to
 * read as a rumble rather than as a series of separate shoves, and slow enough
 * that the 30Hz tick samples it without aliasing into a slow wobble.
 */
const KERB_RIB_FREQUENCY = 1.7;

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
 * How much of its grip the car has right now, 0-1: surface times wear.
 *
 * Every tyre force has to be scaled by this, and there is exactly one of them
 * for a reason. The traction limit, the lateral scrub and the self-aligning
 * moment are all made by the same four contact patches; if one of them ignores
 * the surface it ends up fighting the others.
 *
 * That is not hypothetical — it is the bug this function was extracted to fix.
 * The aligning moment used to be a flat config number, so on grass a
 * FULL-strength caster pulled against a third-strength front axle. The two
 * balanced at about twelve degrees of slip and stayed there: the nose pointed
 * into the corner, the car travelled dead straight, and full lock did nothing
 * whatsoever. Any term added here later must come through this too.
 */
export function gripFraction(
  player: PlayerState,
  config: SimConfig,
  tick: number,
  onTrack = true,
): number {
  let surface = onTrack ? 1 : config.track.offTrackGrip;
  // A kerb is not the grass. It sits INSIDE the track limits, so a car on one
  // is still racing — it simply has less to race with, and is being shaken
  // while it does. Applied on top of the on-track case rather than as a third
  // branch, because a car half on the kerb and half on the grass has both
  // problems at once and should be told so.
  if (onTrack && onKerb(config, player.x, player.z)) surface *= config.track.kerbGrip;
  // Damage rides the same multiplier as everything else, for the reason on
  // this function: a bent car is a car with less grip, and if that arrived
  // anywhere but here it would fight the terms that do come through.
  if (hasEffect(player, 'bent', tick)) surface *= config.collision.damageGrip;

  const life = tyreLife(player, config, tick);
  return surface * (config.race.tyreWornGrip + (1 - config.race.tyreWornGrip) * life);
}

/**
 * True when this position is on the rumble strip inside the track edge.
 *
 * A band of `kerbWidth` measured inward from the boundary, so widening the
 * road moves the kerb with it rather than leaving it stranded mid-track.
 */
export function onKerb(config: SimConfig, x: number, z: number): boolean {
  const kerb = config.track.kerbWidth;
  if (kerb <= 0 || !hasTrack(config)) return false;
  const edge = config.track.halfWidth;
  const across = Math.abs(sampleTrack(config.trackPath, x, z).lateral);
  return across > edge - kerb && across <= edge;
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
  const traction = config.vehicle.tyreGrip;
  if (traction <= 0) return 0;
  return traction * gripFraction(player, config, tick, onTrack);
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
  return config.vehicle.grip * gripFraction(player, config, tick, onTrack);
}

/** What each axle can still spend on cornering, in world units/second². */
export interface AxleGrip {
  readonly front: number;
  readonly rear: number;
  /** Share of the car's weight over the front axle right now, 0-1. */
  readonly frontLoad: number;
}

/**
 * Splits the car's grip across two axles, under whatever load it is carrying.
 *
 * This is where the handling model stopped being one lumped tyre and became a
 * car. The old version had a single traction figure and two separate fudges
 * standing in for the axles it did not have: `frontGrip` for how much the nose
 * could rotate the car, and `selfAlign` for how hard the back end resisted.
 * Both are still config, but they are now multipliers on real per-axle numbers
 * rather than the numbers themselves.
 *
 * Two things decide what an axle can do:
 *
 *  1. **The load it carries.** Grip is proportional to weight on the tyre, and
 *     weight moves: braking pitches the car onto its nose, accelerating squats
 *     it onto the rear. `weightTransfer` says how much moves at the limit.
 *  2. **What it is already spending.** One contact patch serves stopping and
 *     turning both, so an axle working lengthways has less left for sideways.
 *     Braking is shared by load — that is what a balanced brake bias does —
 *     while drive goes entirely to the rear, because the car is rear-driven.
 *
 * The techniques nobody wrote down fall out of those two together:
 *
 * ```
 *   trail braking     brake loads the front, so it turns in — but the front is
 *                     also spending on stopping, so easing the pedal trades
 *                     one against the other
 *   power oversteer   the driven rear spends its grip on drive and has none
 *                     left to hold the line
 *   lift-off oversteer  lifting moves load OFF the rear, and an unloaded rear
 *                     axle is one that steps out
 * ```
 *
 * `longitudinal` is signed: positive is driving, negative is slowing.
 */
export function axleGrip(
  car: SimConfig['vehicle'],
  traction: number,
  longitudinal: number,
): AxleGrip {
  // Weight transfer, as a fraction of the car. Normalised by the tyres' own
  // limit because that is the scale the car's own accelerations live on — so
  // `weightTransfer` reads as "how much moves when it is trying as hard as it
  // can", which is how the figure is quoted for a real car.
  const shift = clamp((longitudinal / traction) * car.weightTransfer, -MAX_TRANSFER, MAX_TRANSFER);
  // Driving moves it back, slowing moves it forward. Never all the way: an
  // axle at zero load has no grip at all, and a car with one end weightless is
  // not a handling model, it is a pirouette.
  const frontLoad = clamp(car.weightFront - shift, MIN_AXLE_LOAD, 1 - MIN_AXLE_LOAD);
  const rearLoad = 1 - frontLoad;

  // Each axle makes grip in proportion to the load it carries, and the two
  // together still add up to exactly `traction` — the split decides balance,
  // not how much grip the car has in total.
  const frontMax = traction * frontLoad;
  const rearMax = traction * rearLoad;

  // What each is already using lengthways. Braking is shared by load, which is
  // what a brake bias set up properly does; drive is all rear.
  const driving = longitudinal > 0;
  const effort = Math.abs(longitudinal);
  const frontSpend = driving ? 0 : effort * frontLoad;
  const rearSpend = driving ? effort : effort * rearLoad;

  return {
    front: remaining(frontMax, frontSpend, car.frictionCircle),
    rear: remaining(rearMax, rearSpend, car.frictionCircle),
    frontLoad,
  };
}

/**
 * The friction circle for one axle: what is left after longitudinal work.
 *
 * `frictionCircle` at 1 is a true circle — an axle braking at its limit can
 * corner not at all. At 0 the two axes are independent and you can stand on
 * the brakes mid-corner with no consequence.
 */
function remaining(max: number, spent: number, circle: number): number {
  if (max <= 0) return 0;
  const used = Math.min(1, (spent / max) * circle);
  return max * Math.sqrt(Math.max(0, 1 - used * used));
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
  const grip = gripFraction(player, config, tick, onTrack);

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

  // --- Throttle and brakes --------------------------------------------------
  // How hard the brake is being asked for, not merely whether. The bound
  // button is a full press — a key has no travel to read — while a pulled-back
  // axis carries how far the pedal actually went.
  //
  // This is what makes trail braking a technique rather than a word in a
  // comment: `longitudinalLoad` below feeds the friction circle, so easing off
  // the brake hands the front tyres back the grip it was spending and the car
  // turns in. With a binary brake the circle only ever had two states.
  const brakeHeld = (input.buttons & buttonBit(car.brakeButton)) !== 0;
  const brakePressure = brakeHeld ? 1 : Math.max(0, -pedal);
  const braking = brakePressure > 0;
  const throttle = braking ? 0 : pedal;

  // How hard the tyres are working lengthways this tick, and which way. The
  // magnitude is what the friction circle spends; the SIGN is what decides
  // which axle the weight moves onto. Every branch below sets it, so it
  // deliberately starts unassigned rather than at a zero no path ever reads.
  let longitudinalLoad: number;
  /** +1 driving, -1 slowing. Braking and coasting both pitch the car forward. */
  let longitudinalSign: number;

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
  // What the car was doing before the throttle touched it, so the ceiling
  // below can tell how much drag has already been spent this tick.
  const entrySpeed = travelSpeed;

  if (braking) {
    if (forward > 0) {
      longitudinalLoad = car.brakeDecel * brakePressure;
      longitudinalSign = -1;
      forward = Math.max(0, forward - longitudinalLoad * dt);
    } else {
      // Stopped and still asking to go backwards: reverse out, gently. Scaled
      // the same way, so easing the pedal backs out at walking pace and
      // burying it is the quickest way off a barrier.
      const reverseTop = top * car.reverseFraction * brakePressure;
      longitudinalLoad = car.engineAccel * 0.6 * brakePressure;
      // Backing up is the engine driving, so the weight goes where the drive
      // goes — rearward relative to the direction of travel, which is forward
      // relative to the car.
      longitudinalSign = -1;
      forward = Math.max(-reverseTop, forward - longitudinalLoad * dt);
    }
  } else if (throttle > 0) {
    const target = top * throttle;
    if (forward < target) {
      longitudinalLoad = car.engineAccel * throttle;
      longitudinalSign = 1;
      forward = Math.min(target, forward + car.engineAccel * throttle * dt);
    } else {
      // Above the current ceiling: DRS just closed, the tow ran out, or all
      // four wheels found the grass. Bleed it off rather than clamping, so
      // losing a boost coasts down instead of hitting a wall of air.
      longitudinalLoad = coastDecel;
      longitudinalSign = -1;
      forward = Math.max(target, forward - coastDecel * dt);
    }
  } else {
    // Hands off: engine braking, toward a standstill from either direction.
    // Lifting off is a deceleration like any other, and the load it moves onto
    // the nose is exactly what lift-off oversteer is made of.
    longitudinalLoad = coastDecel;
    longitudinalSign = -1;
    forward =
      forward > 0 ? Math.max(0, forward - coastDecel * dt) : Math.min(0, forward + coastDecel * dt);
  }

  // --- Steering -------------------------------------------------------------
  // The stick sets the ANGLE of the front wheels, not a rate of turn. What the
  // car then does about it is physics:
  //
  //     omega = speed * tan(angle) / wheelbase
  //
  // This is the standard kinematic bicycle model, and using it rather than
  // adding the stick straight onto the heading is the difference between a car
  // and a tank. Three things stop being special cases and start being
  // consequences:
  //
  //  - A stationary car does not rotate. Turning the wheel of a parked car
  //    turns the wheels; the car needs to roll before any of that becomes a
  //    change of direction.
  //  - The radius of a corner is set by the lock, not by the speed. Hold an
  //    angle and the car traces the same arc at any speed — until the tyres
  //    run out, which is the traction limit's job below and not this one's.
  //  - Reversing swings the nose the other way, because `forward` is signed
  //    and so is the yaw it produces. Backing out of a barrier steers the way
  //    it does in a car park.
  if (steer !== 0) {
    // A speed-sensitive rack. Full lock at racing speed asks for a radius no
    // car could hold, so without this the top half of the control's travel
    // would do nothing but plough and the usable part would be a sliver.
    const speedFraction = top > 0 ? Math.min(1, Math.abs(forward) / top) : 0;
    const angle = steer * car.maxSteerAngle * (1 - car.steerFalloff * speedFraction);
    let yaw = ((forward * Math.tan(angle)) / car.wheelbase) * dt;

    // The rack can out-ask the tyres, but a front axle that has lost grip does
    // not rotate the car — it washes out, and the car goes straight on. Cap
    // the demand at the yaw the FRONT AXLE can actually hold (w = a / v),
    // times the rope the mode is willing to give the driver.
    //
    // The front axle rather than the car's total grip, and that is the whole
    // point of splitting them. The number varies within a corner now: brake on
    // the way in and the nose is loaded, so the cap lifts and the car turns in
    // — which is trail braking, arriving as a consequence rather than as a
    // rule. Get on the power early and the load leaves the front, the cap
    // drops, and the car runs wide.
    //
    // This is why the throttle and brakes are resolved ABOVE the steering
    // rather than below it, which is the other change here. The pedal decides
    // where the weight is; the weight decides what the front axle can do; the
    // front axle decides how much of the rack's request the car will honour.
    // Reading a load the pedal had not been consulted about yet would put the
    // whole chain a tick behind the driver.
    const rolling = Math.abs(forward);
    if (traction > 0 && car.frontGrip > 0 && rolling > YAW_CAP_SPEED) {
      const front = axleGrip(car, traction, longitudinalLoad * longitudinalSign).front;
      const holdable = (front / rolling) * car.frontGrip * dt;
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

  // --- Tyres ----------------------------------------------------------------
  // Steering above rotated the car. It did NOT rotate the car's momentum:
  // velocity is decomposed and written back in the heading the tick began
  // with, so a turn leaves the old velocity pointing slightly across the new
  // nose. That leftover is `lateral`, and what the tyres can do about it is
  // the whole of the handling model.
  if (traction > 0) {
    const axles = axleGrip(car, traction, longitudinalLoad * longitudinalSign);
    const limit = axles.front + axles.rear;

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
        // And by what the REAR axle has left, which is where the moment
        // actually comes from. A car straightens because the back tyres are
        // resisting being dragged sideways, so an axle busy putting power down
        // — or one the throttle has just unloaded — has less to straighten
        // with. That is power oversteer and lift-off oversteer, and neither is
        // written down anywhere: they are this line reading `axles.rear`.
        //
        // The surface is in there too, via `traction`. Left unscaled it simply
        // out-pulled the steering on grass, and the car ploughed straight on
        // with the wheel hard over.
        //
        // And never past the slip it is correcting. Overshoot is a wobble at
        // small angles and a spin at large ones.
        const rearShare = axles.rear / traction;
        const align = clamp(
          slip * car.selfAlign * dt * rolling * rearShare,
          -Math.abs(slip),
          Math.abs(slip),
        );
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
    lateral *= Math.max(0, 1 - car.grip * grip * dt);
  }

  // --- Kerbs ------------------------------------------------------------------
  // A rumble strip rumbles. The grip penalty above is only half of what a kerb
  // does to a car; the other half is that it will not sit still on one, which
  // is why riding a kerb is a decision rather than free extra road.
  //
  // The shake is a function of WHERE THE CAR IS, not of a clock: the ribs are
  // nailed to the track, so the car crosses them at a rate set by how fast it
  // is going and every peer computes the identical kick for the identical
  // metre. Driving it from the tick number instead would shake a parked car,
  // and driving it from the RNG would put a desync in the shared stream.
  if (config.track.kerbShake > 0 && onTrack && onKerb(config, player.x, player.z)) {
    const along = sampleTrack(config.trackPath, player.x, player.z).progress;
    // Scaled by speed as well: a kerb crossed at walking pace is a bump, and
    // the same kerb at racing speed is what puts a car in the barrier.
    const bite = Math.min(1, Math.abs(forward) / Math.max(1, top));
    lateral += Math.sin(along * KERB_RIB_FREQUENCY) * config.track.kerbShake * bite * dt;
  }

  // --- The speed limit applies to the car, not to its nose --------------------
  // `top` is how fast the car may travel, and a sliding car travels partly
  // sideways. The throttle above only ever reads and tops up `forward`, so
  // without this the sideways component rides along untaxed: a car at forty
  // degrees of slip carries `forward / cos 40°`, a third more than the limit
  // it is supposedly held to — and it does it on grass, where it has least
  // right to. Left alone the engine feeds that every tick, so a slide
  // ACCELERATES, which is why leaving the road read as being fired off across
  // it rather than as a mistake.
  //
  // Bled rather than clamped, and both components together so the direction of
  // travel is untouched. A hard clamp here would put a wall of air in front of
  // anyone who lost a tow or closed the wing, which is exactly what the
  // throttle branch above takes care to avoid.
  const resultant = Math.sqrt(forward * forward + lateral * lateral);
  if (resultant > top && resultant > REST_SPEED) {
    // One tick of drag per tick, however it was spent. The throttle branch
    // above already bleeds `forward` toward a lowered ceiling, so charging a
    // second full helping here would slow a car that arrived on the grass in a
    // straight line twice as fast as one that arrived sideways — backwards,
    // and a wall of air for anyone who merely lost a tow.
    const spent = Math.max(0, entrySpeed - resultant);
    const budget = Math.max(0, car.coastDecel * dt - spent);
    const scale = Math.max(top, resultant - budget) / resultant;
    forward *= scale;
    lateral *= scale;
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
