import { angleDelta, clamp, distance2, normalize2 } from '../../shared/math.js';
import { hashStringToSeed } from '../rng.js';
import type { StepContext } from '../step.js';
import { hasTrack, isOnTrack, sampleTrack, trackPoseAt } from '../track.js';
import {
  BUTTON_PRIMARY,
  BUTTON_SECONDARY,
  EMPTY_INPUT,
  ROLE_IT,
  TEAM_NONE,
  type PlayerInput,
  type PlayerState,
} from '../types.js';
import { isBlocked } from './arena.js';
import { hasEffect, isKnockedOut, isProtected } from './effects.js';
import { isMovementLocked, isRoundActive } from './phase.js';
import { tyreLife, vehicleTraction } from './vehicle.js';

/**
 * Deterministic bots, simulated inside the world.
 *
 * Bots are ordinary players with `isBot: true` whose input is computed here
 * each tick, before integration. They exist so a solo player (or a demo!) has
 * something to play against, and so multiplayer sessions can be filled out.
 *
 * Everything here is a pure function of world state — **no RNG stream use**
 * (wander targets hash the bot id and a time epoch instead), so adding or
 * removing a bot never perturbs arena generation or pickup respawns, and any
 * peer restoring a snapshot computes the identical next input.
 *
 * The behaviour is priority-based and mode-aware: it reads which systems are
 * enabled in the config and does the obvious thing for each. It is
 * deliberately beatable — bots run at `bots.speedMultiplier` of player speed
 * (applied in `movementScale`) and aim only straight ahead.
 */
export function computeBotInput(ctx: StepContext, bot: PlayerState): PlayerInput {
  if (isMovementLocked(ctx.phase) || isKnockedOut(bot, ctx.tick)) {
    return { ...EMPTY_INPUT, seq: ctx.tick };
  }

  const decision = decide(ctx, bot);
  const move = decision.target
    ? steer(ctx, bot, decision.target.x, decision.target.z)
    : { x: 0, z: 0 };

  let buttons = decision.fire ? BUTTON_PRIMARY : 0;
  if (ctx.config.platform.enabled && wantsToJump(ctx, bot, decision.target)) {
    buttons |= ctx.config.platform.jumpButton === 'secondary' ? BUTTON_SECONDARY : BUTTON_PRIMARY;
  }
  // Bots use the wing whenever the race hands it to them, so a solo player
  // sees DRS working from the other side of it too.
  if (hasEffect(bot, 'drsok', ctx.tick)) buttons |= actionBit(ctx.config.race.drsButton);

  // A car reads the two axes as steering and throttle in its own frame, so a
  // bot has to drive rather than point (see `steerVehicle`). Everyone else
  // reads them as a direction, scaled by how much of it the decision wants.
  if (ctx.config.vehicle.enabled) {
    return {
      seq: ctx.tick,
      ...driveAxes(bot, move, decision),
      sprint: decision.sprint,
      buttons,
    };
  }

  const throttle = decision.throttle ?? 1;
  return {
    seq: ctx.tick,
    moveX: move.x * throttle,
    moveZ: move.z * throttle,
    sprint: decision.sprint,
    buttons,
  };
}

/** Radius standing in for "straight": big enough that no car is grip-limited. */
const CORNER_STRAIGHT_RADIUS = 1e4;
/** Fraction of the corner speed a bot will accelerate up to before coasting. */
const BOT_CORNER_MARGIN = 0.9;
/** How far ahead a bot will spot a pit entry and commit to it. */
const PIT_LOOKAHEAD = 42;
/** Tyre life below which a bot stops driving on the ragged edge. */
const WORN_CAUTION = 0.3;
/** Aim distance while off the road: short, so the nose turns back toward it. */
const REJOIN_LOOKAHEAD = 4;
/** Below this speed a car has no steering, because it is not rolling. */
const STUCK_SPEED = 1.5;
/**
 * Heading error at which a bot asks for full lock. About 29°, so it squares up
 * briskly without sawing at the wheel down a straight.
 */
const FULL_LOCK_ERROR = 0.5;
/** Heading error past which a stopped car cannot simply drive away forwards. */
const STUCK_ANGLE = 1;

/**
 * What tells one bot from another.
 *
 * Without this a field is one driver copied N times: identical corner speeds,
 * identical braking points, and a race that is decided entirely by grid slot.
 * They also run nose to tail all afternoon, which quietly breaks everything
 * downstream that asks "is anyone close?" — the slipstream ends up switched on
 * for most of a lap because the field never spreads out.
 *
 * The numbers are hashed from the bot's id rather than drawn from the RNG,
 * which matters: the shared random stream is part of the simulation's state,
 * and a bot that consumed from it would make every other outcome depend on how
 * many bots happened to be in the room.
 */
interface BotStyle {
  /** Confidence in a corner, as a multiple of what the tyres can hold. */
  readonly corner: number;
  /** How much margin the driver leaves before lifting. */
  readonly margin: number;
  /** Tyre life at which this driver starts looking for the pit entry. */
  readonly pitAt: number;
}

/**
 * One bot's style, derived from its id.
 *
 * Deliberately spread around 1 rather than only below it: a driver who
 * occasionally asks for slightly more than the tyres have is a driver who
 * occasionally runs wide, and a field where nobody ever makes a mistake is a
 * field nobody can catch.
 */
function botStyle(id: string): BotStyle {
  const seed = hashStringToSeed(`${id}:style`);
  const a = (seed & 0xffff) / 0x10000;
  const b = ((seed >>> 16) & 0xffff) / 0x10000;
  return {
    corner: 0.86 + a * 0.22,
    margin: BOT_CORNER_MARGIN - 0.06 + b * 0.12,
    // Spread so the field does not all queue in the pit lane on the same lap,
    // which is what makes a stop a strategy rather than a scheduled event.
    //
    // Well clear of nothing left, too: a driver who waits until the rubber is
    // gone has to reach the entry on tyres that can no longer be steered with,
    // and mostly ends up in the run-off instead of the pit lane.
    pitAt: 0.3 + a * 0.22,
  };
}

/**
 * The pit entry to aim at, or nothing.
 *
 * Only ever a box that is both close and genuinely ahead: a pit lane sits off
 * the racing line, so a car that turned toward one behind it would drive back
 * up the circuit. Everything else about stopping falls out of the existing
 * rules — the limiter is a zone, and fresh rubber is granted for being in one.
 */
function pitEntry(ctx: StepContext, bot: PlayerState): { x: number; z: number } | null {
  let best: { x: number; z: number; distance: number } | null = null;

  for (const zone of ctx.config.zones) {
    if (zone.kind !== 'pit') continue;
    const dx = zone.x - bot.x;
    const dz = zone.z - bot.z;
    const distance = Math.hypot(dx, dz);
    if (distance > PIT_LOOKAHEAD) continue;
    // In front, not behind: the dot of the offset with where the nose points.
    if (Math.sin(bot.heading) * dx + Math.cos(bot.heading) * dz <= 0) continue;
    if (!best || distance < best.distance) best = { x: zone.x, z: zone.z, distance };
  }

  return best ? { x: best.x, z: best.z } : null;
}

/** Turns a wanted world direction into the axes a car actually understands. */
function driveAxes(
  bot: PlayerState,
  direction: { x: number; z: number },
  decision: Decision,
): { moveX: number; moveZ: number } {
  const pedal = decision.reverse || decision.brake ? -1 : (decision.throttle ?? 1);
  if (direction.x === 0 && direction.z === 0) return { moveX: 0, moveZ: pedal };

  const wanted = Math.atan2(direction.x, direction.z);
  const off = angleDelta(bot.heading, wanted);
  const lock = decision.reverse ? -steeringFor(off) : steeringFor(off);
  // Mirrored while backing up: the same lock swings the nose the other way
  // when the car is rolling backwards, exactly as it does in a car park.
  return { moveX: lock, moveZ: pedal };
}

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
function steeringFor(error: number): number {
  return clamp(error / FULL_LOCK_ERROR, -1, 1);
}

/** Bit for a configured button name; 0 when the action is unbound. */
function actionBit(name: 'primary' | 'secondary' | 'none'): number {
  if (name === 'primary') return BUTTON_PRIMARY;
  if (name === 'secondary') return BUTTON_SECONDARY;
  return 0;
}

/**
 * Jump when the objective is above us, or when something is in the way.
 *
 * Deliberately crude: a real platforming AI wants path planning, and this kit
 * would rather have a bot that reliably makes progress than one that is
 * clever. Releasing the button between hops falls out of the press-edge rule
 * in `integrateVertical` — the bot re-asks every tick and the latch decides.
 */
function wantsToJump(
  ctx: StepContext,
  bot: PlayerState,
  target: { x: number; z: number } | null,
): boolean {
  if (!bot.grounded) return false;

  // Something to climb: probe just ahead at knee height.
  const ahead = ctx.config.playerRadius * 2;
  const probeX = bot.x + Math.sin(bot.heading) * ahead;
  const probeZ = bot.z + Math.cos(bot.heading) * ahead;
  const blockedAhead = isBlocked(
    probeX,
    probeZ,
    ctx.config.playerRadius,
    ctx.obstacles,
    bot.y + 0.3,
  );
  if (blockedAhead) return true;

  // Something worth reaching overhead: a shard resting on a ledge above.
  const reachable = ctx.pickups.some(
    (pickup) =>
      pickup.active &&
      pickup.y > bot.y + 0.5 &&
      distance2(bot.x, bot.z, pickup.x, pickup.z) < ctx.config.playerRadius * 6,
  );
  if (reachable) return true;

  return target !== null && distance2(bot.x, bot.z, target.x, target.z) < 1;
}

interface Decision {
  target: { x: number; z: number } | null;
  sprint: boolean;
  fire: boolean;
  /** Stick deflection in [0, 1]; for a car this is the throttle. Default 1. */
  throttle?: number;
  /** Stand on the brake pedal. Only meaningful with `vehicle.enabled`. */
  brake?: boolean;
  /**
   * Back out of trouble rather than driving out of it.
   *
   * A car yaws because its wheels are rolling, so one that has stopped facing
   * a barrier cannot steer its way out — there is nothing to steer WITH. The
   * way out of that in a real car is reverse, and reversing swings the nose
   * the opposite way for a given lock, so the steering has to be mirrored too.
   */
  reverse?: boolean;
}

function decide(ctx: StepContext, bot: PlayerState): Decision {
  const active = isRoundActive(ctx.phase, ctx.config);

  // --- Tag: chase as "it", flee otherwise -----------------------------------
  if (ctx.config.tag.enabled && active) {
    if (bot.role === ROLE_IT) {
      const prey = nearestPlayer(
        ctx,
        bot,
        (p) => p.role !== ROLE_IT && !isProtected(p, ctx.tick) && !isKnockedOut(p, ctx.tick),
      );
      if (prey) return { target: prey, sprint: true, fire: false };
    } else {
      const threat = nearestPlayer(ctx, bot, (p) => p.role === ROLE_IT);
      if (threat && distance2(bot.x, bot.z, threat.x, threat.z) < 9) {
        return { target: fleeFrom(ctx, bot, threat.x, threat.z), sprint: true, fire: false };
      }
    }
  }

  // --- Items: deliver, keep away, or fetch ----------------------------------
  const carried = ctx.items.find((item) => item.carrierId === bot.id);
  if (carried) {
    const spec = ctx.config.items[carried.id];
    if (spec?.kind === 'flag') {
      const base = ctx.config.zones.find((z) => z.kind === 'base' && z.team === bot.team);
      if (base) return { target: base, sprint: true, fire: false };
    } else {
      const hunter = nearestPlayer(ctx, bot, (p) => !isKnockedOut(p, ctx.tick));
      if (hunter) {
        return { target: fleeFrom(ctx, bot, hunter.x, hunter.z), sprint: true, fire: false };
      }
    }
  } else if (ctx.items.length > 0) {
    const wanted = ctx.items.find((item) => {
      const spec = ctx.config.items[item.id];
      if (!spec) return false;
      if (spec.kind === 'flag') return spec.team !== bot.team;
      return true; // crown: always worth chasing, carried or not
    });
    if (wanted) {
      const carrier = ctx.players.find((p) => p.id === wanted.carrierId);
      const spot = carrier ?? wanted;
      return { target: { x: spot.x, z: spot.z }, sprint: true, fire: false };
    }
  }

  // --- Ball: get behind it and push it at the enemy goal --------------------
  if (ctx.config.ball.enabled && ctx.ball) {
    const ball = ctx.ball;
    const goal = ctx.config.zones.find((z) => z.kind === 'goal' && z.team !== bot.team);
    if (goal) {
      const push = normalize2(goal.x - ball.x, goal.z - ball.z);
      const standoff = ctx.config.ball.radius + ctx.config.playerRadius + 0.4;
      const approach = { x: ball.x - push.x * standoff, z: ball.z - push.y * standoff };
      const nearApproach = distance2(bot.x, bot.z, approach.x, approach.z) < 1.2;
      const target = nearApproach ? { x: ball.x + push.x, z: ball.z + push.y } : approach;
      return { target, sprint: true, fire: false };
    }
    return { target: { x: ball.x, z: ball.z }, sprint: true, fire: false };
  }

  // --- Circuit racing: follow the road, and lift for what is coming ---------
  if (hasTrack(ctx.config)) return drive(ctx, bot);

  // --- Race: head for the next checkpoint -----------------------------------
  const nextCheckpoint = ctx.config.zones.find(
    (z) => z.kind === 'checkpoint' && z.order === bot.checkpoint,
  );
  if (nextCheckpoint) {
    return { target: nextCheckpoint, sprint: true, fire: false };
  }

  // --- King of the hill: stand on it, and shove whoever else does -----------
  const hill = ctx.config.zones.find((z) => z.kind === 'hill');
  if (hill) {
    const far = distance2(bot.x, bot.z, hill.x, hill.z) > hill.radius;
    return {
      target: { x: hill.x, z: hill.z },
      sprint: far,
      fire: ctx.config.projectiles.enabled && hasShotLinedUp(ctx, bot, 6),
    };
  }

  // --- Projectiles: hunt the nearest enemy, fire when lined up --------------
  if (ctx.config.projectiles.enabled) {
    const enemy = nearestPlayer(
      ctx,
      bot,
      (p) =>
        !isKnockedOut(p, ctx.tick) &&
        (bot.team === TEAM_NONE || p.team !== bot.team) &&
        !isProtected(p, ctx.tick),
    );
    if (enemy) {
      const dist = distance2(bot.x, bot.z, enemy.x, enemy.z);
      const toEnemy = normalize2(enemy.x - bot.x, enemy.z - bot.z);
      const facing = Math.sin(bot.heading) * toEnemy.x + Math.cos(bot.heading) * toEnemy.y;
      const fire = dist < 10 && facing > 0.92 && !hasEffect(bot, 'reload', ctx.tick);
      return { target: { x: enemy.x, z: enemy.z }, sprint: dist > 6, fire };
    }
  }

  // --- Otherwise: collect pickups, or wander --------------------------------
  const pickup = nearestPickup(ctx, bot);
  if (pickup) return { target: pickup, sprint: false, fire: false };

  return { target: wanderTarget(ctx, bot), sprint: false, fire: false };
}

/**
 * Drives the circuit.
 *
 * Aiming at the next checkpoint — which is what every other race mode does —
 * makes a car cut every corner and spend the lap in the run-off, because a
 * gate is a point and a corner is an arc. So the target is the road itself, a
 * speed-dependent distance ahead, and the throttle comes off for however much
 * the road bends beyond it.
 *
 * The bend is measured between two **chords** (here → aim, aim → beyond)
 * rather than between two segment tangents. A tangent is piecewise constant
 * along a polyline, so it reports a corner as a step change and a bot reading
 * it brakes in stutters; a chord rotates smoothly as the car moves, which is
 * what a driver actually sees coming.
 */
function drive(ctx: StepContext, bot: PlayerState): Decision {
  const path = ctx.config.trackPath;
  const speed = Math.hypot(bot.vx, bot.vz);
  const here = sampleTrack(path, bot.x, bot.z);

  // Look further ahead the faster you are going: the distance that matters is
  // the one you cannot stop inside.
  //
  // Unless the car is not on the road at all, in which case the opposite is
  // wanted. A long lookahead points ALONG the circuit, so a car that has ended
  // up on the infield aims at a aim point that is also on the infield and
  // drives happily parallel to the tarmac for the rest of the race. Pulling
  // the aim point right in turns the nose back toward the road, which is what
  // rejoining is.
  // Checked before anything else about driving, and before the rejoin branch
  // in particular — that one returns a forward throttle, which is exactly what
  // a car in this state cannot use.
  //
  // Stopped and pointed somewhere that will not get it going again: with a car
  // that yaws only while rolling there is no steering out of it, because there
  // is nothing to steer with. Backing out is what a driver does, and it is the
  // reason the model can afford to be honest about a stationary car not
  // turning at all.
  if (speed < STUCK_SPEED) {
    const escape = trackPoseAt(path, here.progress + REJOIN_LOOKAHEAD);
    const wanted = Math.atan2(escape.x - bot.x, escape.z - bot.z);
    if (Math.abs(angleDelta(bot.heading, wanted)) > STUCK_ANGLE) {
      return { target: { x: escape.x, z: escape.z }, sprint: false, fire: false, reverse: true };
    }
  }

  const strayed = here.lateral > ctx.config.track.halfWidth;
  const lookahead = strayed ? REJOIN_LOOKAHEAD : Math.max(7, speed * 0.85);
  const rejoinTarget = strayed ? trackPoseAt(path, here.progress + REJOIN_LOOKAHEAD) : null;

  if (rejoinTarget) {
    // Rejoining is its own job, and the cornering model must not be asked to
    // do it: that model reads the bend over the aim distance, and an aim
    // distance this short reads as a hairpin whatever the road is doing. A
    // stranded car would then creep back at walking pace and spend the rest of
    // the race doing it. A steady half-throttle back toward the tarmac is both
    // simpler and what a driver does.
    return {
      target: { x: rejoinTarget.x, z: rejoinTarget.z },
      sprint: false,
      fire: false,
      throttle: 0.7,
    };
  }
  const aim = trackPoseAt(path, here.progress + lookahead);
  const beyond = trackPoseAt(path, here.progress + lookahead * 2);

  const toAim = Math.atan2(aim.x - bot.x, aim.z - bot.z);
  const onward = Math.atan2(beyond.x - aim.x, beyond.z - aim.z);
  const bend = Math.abs(angleDelta(toAim, onward));

  const onTrack = isOnTrack(ctx.config, bot.x, bot.z);
  const traction = vehicleTraction(bot, ctx.config, ctx.tick, onTrack);
  const life = tyreLife(bot, ctx.config, ctx.tick);

  if (traction > 0) {
    // Drive to the tyres rather than to a hand-picked constant.
    //
    // The road ahead turns through `bend` radians over the `lookahead` units
    // we just looked down, so its radius is one divided by the other, and a
    // tyre-limited car holds that radius at sqrt(grip x radius) — the same
    // sum a driver does by feel on the way to a corner. Deriving the number
    // means the bots re-learn the circuit for free whenever the grip changes,
    // on worn rubber, and on the grass.
    const radius = bend > 1e-3 ? lookahead / bend : CORNER_STRAIGHT_RADIUS;
    // Style is what makes this a field rather than one driver five times over:
    // the brave carry more speed in and sometimes run wide, the cautious brake
    // early and lose a tenth doing it.
    const style = botStyle(bot.id);
    // Bravado is for a car that is working. Off the tarmac, or on rubber that
    // has gone, the grip is already marginal and asking for more than it has
    // is how a bot ends up in the scenery for the rest of the afternoon: once
    // off, the surface multiplier makes the slide self-sustaining and nothing
    // it does gets it back. A driver who can feel the car going backs off, so
    // this one does too.
    const composed = onTrack && life > WORN_CAUTION;
    const bravado = composed ? style.corner : Math.min(style.corner, 0.9);
    const corner = Math.sqrt(traction * Math.min(radius, CORNER_STRAIGHT_RADIUS)) * bravado;

    // Worn out and the entry is coming up: peel off. Without this the tyre
    // rules exist but nothing ever uses them, and a race long enough to need a
    // stop just leaves the whole field crawling to the flag.
    if (life < style.pitAt) {
      const pit = pitEntry(ctx, bot);
      if (pit) return { target: pit, sprint: true, fire: false, throttle: 1 };
    }

    return {
      target: { x: aim.x, z: aim.z },
      sprint: true,
      fire: false,
      // Full throttle with margin in hand, coast through the band, and stand
      // on the pedal once the corner is genuinely too fast to make. The band
      // matters: braking the instant you are one unit over turns every sweeper
      // into a stutter.
      throttle: speed < corner * style.margin ? 1 : 0,
      brake: speed > corner,
    };
  }

  const cruising = ctx.config.playerMaxSpeed * ctx.config.bots.speedMultiplier;

  return {
    target: { x: aim.x, z: aim.z },
    sprint: true,
    fire: false,
    throttle: clamp(1 - bend * 0.55, 0.45, 1),
    // The pedal, not just the lift: coasting sheds speed far too slowly to
    // make a hairpin from the end of a straight.
    brake: bend > 0.6 && speed > cruising * 0.55,
  };
}

// ---------------------------------------------------------------------------
// Steering
// ---------------------------------------------------------------------------

/**
 * Direction toward a target with one-step obstacle avoidance: when the direct
 * probe is blocked, the first unblocked rotation (±35°, ±70°) wins. Purely a
 * function of static geometry, so identical on every peer.
 */
function steer(
  ctx: StepContext,
  bot: PlayerState,
  tx: number,
  tz: number,
): { x: number; z: number } {
  const direct = normalize2(tx - bot.x, tz - bot.z);
  if (direct.x === 0 && direct.y === 0) return { x: 0, z: 0 };

  const lookahead = ctx.config.playerRadius * 2.5;
  const candidates = [0, 0.6, -0.6, 1.2, -1.2];

  for (const angle of candidates) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const dx = direct.x * cos - direct.y * sin;
    const dz = direct.x * sin + direct.y * cos;
    const probeX = bot.x + dx * lookahead;
    const probeZ = bot.z + dz * lookahead;
    if (!isBlocked(probeX, probeZ, ctx.config.playerRadius, ctx.obstacles, bot.y)) {
      return { x: dx, z: dz };
    }
  }
  return { x: direct.x, z: direct.y };
}

function fleeFrom(
  ctx: StepContext,
  bot: PlayerState,
  x: number,
  z: number,
): { x: number; z: number } {
  const away = normalize2(bot.x - x, bot.z - z);
  // Aim well past arm's length so `steer` has a real target to path toward.
  return {
    x: clampToArena(bot.x + away.x * 8, ctx.config.arenaHalfExtentX),
    z: clampToArena(bot.z + away.y * 8, ctx.config.arenaHalfExtentZ),
  };
}

function clampToArena(value: number, halfExtent: number): number {
  const limit = halfExtent - 1.5;
  return value < -limit ? -limit : value > limit ? limit : value;
}

/** A rival is in range and roughly ahead — worth spending the cooldown. */
function hasShotLinedUp(ctx: StepContext, bot: PlayerState, range: number): boolean {
  if (hasEffect(bot, 'reload', ctx.tick)) return false;
  const enemy = nearestPlayer(
    ctx,
    bot,
    (p) =>
      !isKnockedOut(p, ctx.tick) &&
      (bot.team === TEAM_NONE || p.team !== bot.team) &&
      !isProtected(p, ctx.tick),
  );
  if (!enemy) return false;
  if (distance2(bot.x, bot.z, enemy.x, enemy.z) > range) return false;
  const toEnemy = normalize2(enemy.x - bot.x, enemy.z - bot.z);
  return Math.sin(bot.heading) * toEnemy.x + Math.cos(bot.heading) * toEnemy.y > 0.7;
}

function nearestPlayer(
  ctx: StepContext,
  bot: PlayerState,
  eligible: (player: PlayerState) => boolean,
): PlayerState | null {
  let best: PlayerState | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const player of ctx.players) {
    if (player.id === bot.id || !eligible(player)) continue;
    const dist = distance2(bot.x, bot.z, player.x, player.z);
    if (dist < bestDist) {
      best = player;
      bestDist = dist;
    }
  }
  return best;
}

function nearestPickup(ctx: StepContext, bot: PlayerState): { x: number; z: number } | null {
  let best: { x: number; z: number } | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const pickup of ctx.pickups) {
    if (!pickup.active) continue;
    const dist = distance2(bot.x, bot.z, pickup.x, pickup.z);
    if (dist < bestDist) {
      best = { x: pickup.x, z: pickup.z };
      bestDist = dist;
    }
  }
  return best;
}

/**
 * A pseudo-random roam point that changes every ~4 seconds. Hashed from the
 * bot id and a time epoch rather than drawn from the world RNG, so bot
 * behaviour never perturbs the shared random stream.
 */
function wanderTarget(ctx: StepContext, bot: PlayerState): { x: number; z: number } {
  const epoch = Math.floor(ctx.tick / 120);
  const seed = hashStringToSeed(`${bot.id}:${epoch}`);
  const a = ((seed & 0xffff) / 0x10000) * 2 - 1;
  const b = (((seed >>> 16) & 0xffff) / 0x10000) * 2 - 1;
  return {
    x: a * (ctx.config.arenaHalfExtentX - 2),
    z: b * (ctx.config.arenaHalfExtentZ - 2),
  };
}
