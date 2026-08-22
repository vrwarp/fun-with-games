import type { PickupKind } from './types.js';

/**
 * Every tunable number in the simulation lives here.
 *
 * Rules of the road for agents: gameplay code reads from a `SimConfig` that is
 * passed in, it never imports `DEFAULT_SIM_CONFIG` directly. Tests build tiny
 * bespoke configs (a 4x4 arena with one pickup) to make assertions obvious,
 * and that only works if nothing reaches for the global default.
 *
 * The config doubles as the game-mode switchboard: every system in
 * `src/sim/systems/` is driven entirely by its section here and is inert at
 * the defaults. `src/sim/presets.ts` composes these sections into named game
 * modes — most "new game" requests are a preset, not new code. See
 * `docs/GAME_KIT.md`.
 */

// ---------------------------------------------------------------------------
// Section types
// ---------------------------------------------------------------------------

/** Match flow: lobby → countdown → playing → ended → countdown → … */
export interface PhasesConfig {
  /** Off = one endless, untimed round (the sandbox default). */
  readonly enabled: boolean;
  /** Players (bots count) needed to leave the lobby. */
  readonly minPlayers: number;
  /** Length of the pre-round freeze. */
  readonly countdownTicks: number;
  /** Round length; 0 = until a win condition fires. */
  readonly playTicks: number;
  /** How long the winner screen shows before the next countdown. */
  readonly endTicks: number;
  /** First score to reach this wins the round; 0 = no score limit. */
  readonly targetScore: number;
  /** Reset all scores when a round starts. */
  readonly resetScoresOnRoundStart: boolean;
}

export interface TeamsConfig {
  /** 0 = free-for-all. 2+ assigns joiners to the smallest team. */
  readonly count: number;
}

export interface CombatConfig {
  readonly enabled: boolean;
  readonly maxHp: number;
  /** Ticks between KO and respawn. */
  readonly respawnTicks: number;
  /** Tag/damage immunity after respawning. */
  readonly spawnProtectionTicks: number;
  /** 0 = infinite respawns. >0 = elimination when they run out. */
  readonly lives: number;
  /** Points awarded to the attacker per KO. */
  readonly koScore: number;
}

export interface ProjectileConfig {
  readonly enabled: boolean;
  /** World units per second. */
  readonly speed: number;
  readonly radius: number;
  readonly damage: number;
  /** Impulse applied to a hit player, in world units/second. */
  readonly knockback: number;
  readonly cooldownTicks: number;
  readonly lifetimeTicks: number;
  /** Hard cap on simultaneous projectiles, as a safety valve. */
  readonly maxLive: number;
}

export interface TagConfig {
  readonly enabled: boolean;
  /**
   * `transfer`: classic tag — the tag moves to whoever was touched.
   * `spread`: infection — the touched player ALSO becomes it.
   */
  readonly variant: 'transfer' | 'spread';
  /** Immunity after being tagged, so the tag cannot instantly bounce back. */
  readonly graceTicks: number;
  /** Points per second for NOT being it. */
  readonly survivorScorePerSecond: number;
  /** Points the tagger earns per tag. */
  readonly tagScore: number;
}

export interface BallConfig {
  readonly enabled: boolean;
  readonly radius: number;
  /** Velocity decay per second, as a fraction (like player friction). */
  readonly friction: number;
  /** Energy kept when bouncing off walls and obstacles, in [0, 1]. */
  readonly restitution: number;
  /** Speed a touching player imparts, in world units/second. */
  readonly kickImpulse: number;
  readonly maxSpeed: number;
}

/**
 * A zone is a static circle on the arena floor. What it does is its `kind`:
 *
 * - `hill`: king-of-the-hill — sole occupant (or sole occupying team) owns it
 *   and earns `zoneRules.hillScorePerSecond`.
 * - `goal`: a ball entering it scores for the OTHER team (`team` here is the
 *   team defending this goal).
 * - `base`: where `team` delivers carried flags / where its flags live.
 * - `checkpoint`: race gates, crossed in `order` (0, 1, 2, …).
 * - `drs`: a stretch where a car close enough to the one ahead may open its
 *   wing (`race.drsGapSeconds`). Purely a trigger area — see `systems/race.ts`.
 * - `pit`: the pit lane. Speed is limited to `race.pitSpeedLimit` inside it
 *   and tyres are refitted, so it trades lap time for grip.
 */
export interface ZoneSpec {
  readonly kind: 'hill' | 'goal' | 'base' | 'checkpoint' | 'drs' | 'pit';
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  /** Owning/defending team, or -1 for neutral. */
  readonly team: number;
  /** Sequence for checkpoints; ignored by other kinds. */
  readonly order: number;
}

export interface ZoneRulesConfig {
  readonly hillScorePerSecond: number;
  readonly goalScore: number;
  /** Points per completed lap. A race to 3 laps = targetScore 3, lapScore 1. */
  readonly lapScore: number;
}

/**
 * A carryable item. `flag` belongs to a team, is picked up by the other team,
 * and scores when delivered to the carrier's own `base` zone. `crown` is
 * neutral: anyone may take it (including stealing by touching the carrier),
 * and carrying it pays `carryScorePerSecond`.
 */
export interface ItemSpec {
  readonly kind: 'flag' | 'crown';
  readonly homeX: number;
  readonly homeZ: number;
  /** Owning team for flags; -1 for a neutral crown. */
  readonly team: number;
}

export interface ItemRulesConfig {
  /** How long a dropped item lies before snapping home. */
  readonly returnTicks: number;
  /** Movement multiplier while carrying (1 = no slowdown). */
  readonly carrySpeedMultiplier: number;
  /** Points per second while carrying a crown. */
  readonly carryScorePerSecond: number;
  /** Points for delivering a flag. */
  readonly deliverScore: number;
  /** Immunity after taking/stealing an item, so it cannot ping-pong. */
  readonly stealGraceTicks: number;
}

export interface BotsConfig {
  /** Upper bound on host-added bots. */
  readonly maxCount: number;
  /** Bots move at this fraction of player speed — beatable on a thumbstick. */
  readonly speedMultiplier: number;
}

/**
 * Gravity, jumping and standable geometry — everything that turns the plane
 * into a platformer.
 *
 * Off by default: with `enabled: false` every player's `y` stays 0 and the
 * simulation behaves exactly as a flat, top-down world (which is the right
 * model for tag, soccer, hill, racing and every other mode that ships).
 */
export interface PlatformConfig {
  readonly enabled: boolean;
  /** Downward acceleration, world units/second². */
  readonly gravity: number;
  /** Launch speed of a jump, world units/second. */
  readonly jumpVelocity: number;
  /** Jumps allowed before touching a surface again. 2 = double jump. */
  readonly maxJumps: number;
  /** Steering authority while airborne, as a fraction of ground control. */
  readonly airControl: number;
  /** Fall-speed cap, world units/second. */
  readonly terminalVelocity: number;
  /** Which action button jumps. */
  readonly jumpButton: 'primary' | 'secondary';
  /**
   * Side-scroller mode: pin players to the z = 0 plane and ignore all depth
   * input, so the game is genuinely two-dimensional. Pair it with
   * `view: 'side'` in the mode metadata.
   */
  readonly lockZ: boolean;
}

/**
 * A hand-placed box: a wall when it sits on the floor, a jumpable platform
 * when `baseY` lifts it. Appended to the seed-generated obstacles, so it
 * blocks, supports and renders exactly like them.
 */
export interface PlatformSpec {
  readonly x: number;
  readonly z: number;
  readonly halfX: number;
  readonly halfZ: number;
  /** Bottom of the box; 0 rests it on the floor. */
  readonly baseY: number;
  /** Top surface — the height players stand on. */
  readonly top: number;
}

/**
 * Car handling: what turns a free-floating avatar into something that has to
 * be driven.
 *
 * Off by default, and when off not one line of it runs — `integratePlayer`
 * keeps the omnidirectional model every other mode uses. Switched on, the
 * differences are the ones that make a car a car: you go where you are
 * pointed (no strafing), turning takes time and gets harder with speed, and
 * momentum carries you wide when you ask for too much.
 *
 * Top speed is `playerMaxSpeed`, shared with everything else, so effects
 * (`speed` pickups, DRS, the slipstream, worn tyres) scale a car exactly the
 * way they scale a runner.
 */
export interface VehicleConfig {
  readonly enabled: boolean;
  /** Acceleration at full throttle, world units/second². */
  readonly engineAccel: number;
  /** Deceleration under braking, world units/second². */
  readonly brakeDecel: number;
  /** Engine braking when the throttle is released, world units/second². */
  readonly coastDecel: number;
  /** Top reverse speed, as a fraction of the forward top speed. */
  readonly reverseFraction: number;
  /** Steering rate at a standstill, radians/second. */
  readonly steerRate: number;
  /**
   * Fraction of steering authority lost at top speed, in [0, 1).
   *
   * This is the understeer knob: 0 corners like a shopping trolley at any
   * speed, 0.6 means a flat-out car turns at 40% of its parked rate and the
   * driver has to brake for the corner.
   */
  readonly steerFalloff: number;
  /**
   * How quickly sideways velocity is scrubbed off, per second. High is
   * go-kart grip; low slides. Multiplied by the surface and the tyres.
   *
   * This is the *residual* scrub, used below the traction limit and to settle
   * a car that is already straight. What decides whether the car slides at all
   * is `tyreGrip`.
   */
  readonly grip: number;
  /**
   * Peak lateral acceleration the tyres can generate, world units/second².
   * Zero keeps the old always-proportional scrub.
   *
   * This is the traction limit, and it is the difference between a car that
   * understeers by fiat and one that actually breaks away. Holding a corner
   * costs `speed × yawRate` of lateral acceleration; ask for more than the
   * tyres can supply and the surplus becomes sideways velocity — a slide the
   * driver has to catch. Because the demand scales with speed, the same steering
   * angle grips at 8 units/second and lets go at 25, which is what makes the
   * brake pedal a real decision rather than a formality.
   */
  readonly tyreGrip: number;
  /**
   * How strongly longitudinal load steals from the lateral budget, in [0, 1].
   *
   * The friction circle: a tyre has one contact patch to spend on stopping and
   * turning both. At 1 a car braking at its limit cannot corner at all; at 0
   * the two axes are independent and you can stand on the brakes mid-corner
   * with no consequence. Trail braking and power oversteer both come from here.
   */
  readonly frictionCircle: number;
  /**
   * How much more yaw the steering rack may ask for than the front tyres can
   * hold, as a multiple. 0 disables the cap entirely.
   *
   * A rack can always be turned further, but a front axle that has lost grip
   * does not rotate the car — it washes out. That is what understeer *is*, and
   * deriving it from the traction limit rather than from a fixed
   * `steerFalloff` means it arrives exactly when the tyres run out. 1 pins the
   * car to pure understeer and it can never be provoked; a little above 1
   * leaves enough rope to hang yourself with, which is where the fun is.
   */
  readonly frontGrip: number;
  /**
   * How quickly a sliding car straightens itself out, per second.
   *
   * The self-aligning moment a real steering rack feels through the caster. It
   * pulls the nose toward the direction of travel in proportion to the slip
   * angle, which is what makes a slide catchable instead of terminal — the car
   * helps you, the way a real one does, and a spin still needs the driver to
   * unwind the lock.
   */
  readonly selfAlign: number;
  /** Which action button brakes. */
  readonly brakeButton: 'primary' | 'secondary' | 'none';
}

/** One point on a circuit's centreline. Order defines the racing direction. */
export interface TrackPoint {
  readonly x: number;
  readonly z: number;
}

/**
 * The tarmac. `trackPath` holds the closed centreline; this holds how wide it
 * is and what happens when you leave it.
 *
 * Track limits are grass, not walls — see `src/sim/track.ts` for why.
 */
export interface TrackConfig {
  readonly enabled: boolean;
  /** Half the road width, in world units. */
  readonly halfWidth: number;
  /** Top-speed multiplier once off the tarmac. */
  readonly offTrackSpeed: number;
  /** Grip multiplier once off the tarmac. */
  readonly offTrackGrip: number;
  /** Cars per row on the starting grid. 2 is the Formula-style staggered grid. */
  readonly gridColumns: number;
  /** Spacing between grid rows, in world units. */
  readonly gridRowSpacing: number;
}

/**
 * Racing rules layered on top of the circuit: the tow, the overtaking aid,
 * the tyres and the pit lane.
 *
 * Every one of these is expressed as a timed effect (`tow`, `drs`, `drsok`,
 * `tyre`) rather than as new player fields, so none of them costs a snapshot
 * field, a protocol change or a checksum line.
 */
export interface RaceConfig {
  readonly enabled: boolean;
  /** How far back the tow reaches, in world units. 0 disables it. */
  readonly slipstreamRange: number;
  /** Top-speed multiplier while in another car's dirty air. */
  readonly slipstreamMultiplier: number;
  /**
   * How closely the two cars must be pointed the same way, as a cosine.
   *
   * A wake sits directly behind a car, so being near one is not the same as
   * being in its tow: through a corner the pair are at an angle and the
   * follower is off to one side of the wake rather than in it. 0 accepts any
   * alignment (the old behaviour, and it leaves the tow switched on for half
   * a lap); around 0.9 is a little over 25 degrees, which is a straight.
   */
  readonly slipstreamAlignment: number;
  /**
   * Gap to the car ahead, in seconds, that arms the wing. 0 disables DRS.
   * Measured along the centreline, so it is a real racing gap, not a radius.
   */
  readonly drsGapSeconds: number;
  /** Top-speed multiplier while the wing is open. */
  readonly drsMultiplier: number;
  /** How long one activation lasts. */
  readonly drsTicks: number;
  /** Which action button opens the wing. */
  readonly drsButton: 'primary' | 'secondary' | 'none';
  /** Length of a set of tyres, in ticks. 0 disables wear entirely. */
  readonly tyreStintTicks: number;
  /** Grip multiplier on completely worn tyres. */
  readonly tyreWornGrip: number;
  /** Top-speed multiplier on completely worn tyres. */
  readonly tyreWornSpeed: number;
  /** Speed limit inside a `pit` zone, in world units/second. */
  readonly pitSpeedLimit: number;
}

/** Spawn weights per pickup kind; 0 disables a kind. */
export type PickupWeights = Readonly<Record<PickupKind, number>>;

export interface PowerupConfig {
  readonly speedTicks: number;
  readonly speedMultiplier: number;
  readonly shieldTicks: number;
  readonly healAmount: number;
}

// ---------------------------------------------------------------------------
// The config
// ---------------------------------------------------------------------------

/**
 * What happens when two bodies touch.
 *
 * The kit has always separated overlapping players and left their velocities
 * alone, which is right for a footrace — you cannot shoulder-barge someone in
 * `tag` and send them into a wall. A car is a different object: two tonnes
 * arriving at 25 units/second has momentum that has to go somewhere, and a
 * racing game in which contact is free is a racing game without defending.
 *
 * `enabled` is therefore off by default and every non-racing mode keeps the
 * historical push-apart. Turning it on adds the physics an impact actually
 * has: momentum swaps across the contact normal, the surfaces scrub along it,
 * and a glancing blow twists the car it lands on.
 */
export interface CollisionConfig {
  /** Exchange momentum on contact. Off keeps push-apart-only separation. */
  readonly enabled: boolean;
  /**
   * Bounciness, in [0, 1]. 0 is a dead thud that leaves the pair travelling
   * together; 1 is a snooker ball. Cars want to be near the thud end — a
   * springy shunt reads as a bug, not as a crash.
   */
  readonly restitution: number;
  /**
   * Sideways bite between the two bodies on contact, in [0, 1].
   *
   * 0 lets them slide past frictionlessly, which is why rubbing along a rival
   * currently costs nothing. Above 0 the pair drag each other toward a common
   * sideways speed, so running wheel-to-wheel scrubs both cars' momentum.
   */
  readonly friction: number;
  /**
   * Yaw imparted by that sideways bite, in radians per unit of scrub.
   *
   * A body is a disc here, so a blow straight through the centre cannot spin
   * it — but a scrape drags one flank and not the other, and that is a torque.
   * This is what makes a late lunge down the inside dangerous for both cars.
   */
  readonly spin: number;
}

export interface SimConfig {
  /** Fixed simulation steps per second. The wire protocol assumes this too. */
  readonly tickRate: number;
  /** Snapshots are broadcast every N ticks. 2 => 15 Hz at a 30 Hz tick rate. */
  readonly snapshotIntervalTicks: number;

  /** Arena is an axis-aligned box centred on the origin. */
  readonly arenaHalfExtentX: number;
  readonly arenaHalfExtentZ: number;

  readonly playerRadius: number;
  /** Standing height, used for head clearance and platform occupancy. */
  readonly playerHeight: number;
  readonly playerAcceleration: number;
  readonly playerMaxSpeed: number;
  readonly playerSprintMultiplier: number;
  /** Velocity decay per second when there is no input, as a fraction. */
  readonly playerFriction: number;

  readonly pickupCount: number;
  readonly pickupRadius: number;
  readonly pickupRespawnTicks: number;
  readonly pickupScore: number;
  readonly pickupWeights: PickupWeights;

  readonly obstacleCount: number;
  readonly obstacleMinHalfExtent: number;
  readonly obstacleMaxHalfExtent: number;

  // ---- game kit sections (each system reads exactly one) -------------------
  readonly vehicle: VehicleConfig;
  readonly collision: CollisionConfig;
  readonly track: TrackConfig;
  /** The circuit's closed centreline. Empty in every non-racing mode. */
  readonly trackPath: readonly TrackPoint[];
  readonly race: RaceConfig;
  readonly platform: PlatformConfig;
  /** Hand-placed boxes appended to the generated obstacles. */
  readonly platforms: readonly PlatformSpec[];
  readonly phases: PhasesConfig;
  readonly teams: TeamsConfig;
  readonly combat: CombatConfig;
  readonly projectiles: ProjectileConfig;
  readonly tag: TagConfig;
  readonly ball: BallConfig;
  readonly zones: readonly ZoneSpec[];
  readonly zoneRules: ZoneRulesConfig;
  readonly items: readonly ItemSpec[];
  readonly itemRules: ItemRulesConfig;
  readonly bots: BotsConfig;
  readonly powerups: PowerupConfig;
}

/**
 * The defaults are the endless shard-gathering sandbox: every kit system is
 * disabled or empty, and the simulation behaves exactly as it did before the
 * kit existed. Presets turn things on — see `src/sim/presets.ts`.
 */
export const DEFAULT_SIM_CONFIG: SimConfig = {
  tickRate: 30,
  snapshotIntervalTicks: 2,

  arenaHalfExtentX: 24,
  arenaHalfExtentZ: 24,

  playerRadius: 0.5,
  playerHeight: 1.7,
  playerAcceleration: 55,
  playerMaxSpeed: 9,
  playerSprintMultiplier: 1.6,
  playerFriction: 8,

  pickupCount: 14,
  pickupRadius: 0.7,
  pickupRespawnTicks: 90,
  pickupScore: 1,
  pickupWeights: { score: 1, speed: 0, shield: 0, heal: 0 },

  obstacleCount: 10,
  obstacleMinHalfExtent: 1,
  obstacleMaxHalfExtent: 3,

  vehicle: {
    enabled: false,
    engineAccel: 20,
    brakeDecel: 34,
    coastDecel: 12,
    reverseFraction: 0.35,
    steerRate: 3.2,
    steerFalloff: 0.55,
    grip: 7,
    tyreGrip: 0,
    frictionCircle: 0,
    frontGrip: 0,
    selfAlign: 0,
    brakeButton: 'secondary',
  },
  collision: {
    enabled: false,
    restitution: 0.2,
    friction: 0.35,
    spin: 0.02,
  },
  track: {
    enabled: false,
    halfWidth: 6,
    offTrackSpeed: 0.45,
    offTrackGrip: 0.35,
    gridColumns: 2,
    gridRowSpacing: 5,
  },
  trackPath: [],
  race: {
    enabled: false,
    slipstreamRange: 9,
    slipstreamMultiplier: 1.12,
    slipstreamAlignment: 0,
    drsGapSeconds: 1,
    drsMultiplier: 1.22,
    drsTicks: 60,
    drsButton: 'primary',
    tyreStintTicks: 0,
    tyreWornGrip: 0.6,
    tyreWornSpeed: 0.88,
    pitSpeedLimit: 8,
  },
  platform: {
    enabled: false,
    gravity: 26,
    jumpVelocity: 9.5,
    maxJumps: 2,
    airControl: 0.65,
    terminalVelocity: 28,
    jumpButton: 'primary',
    lockZ: false,
  },
  platforms: [],
  phases: {
    enabled: false,
    minPlayers: 1,
    countdownTicks: 90,
    playTicks: 0,
    endTicks: 150,
    targetScore: 0,
    resetScoresOnRoundStart: true,
  },
  teams: { count: 0 },
  combat: {
    enabled: false,
    maxHp: 3,
    respawnTicks: 90,
    spawnProtectionTicks: 60,
    lives: 0,
    koScore: 1,
  },
  projectiles: {
    enabled: false,
    speed: 16,
    radius: 0.35,
    damage: 1,
    knockback: 10,
    cooldownTicks: 18,
    lifetimeTicks: 45,
    maxLive: 64,
  },
  tag: {
    enabled: false,
    variant: 'transfer',
    graceTicks: 45,
    survivorScorePerSecond: 1,
    tagScore: 0,
  },
  ball: {
    enabled: false,
    radius: 0.8,
    friction: 0.6,
    restitution: 0.75,
    kickImpulse: 11,
    maxSpeed: 18,
  },
  zones: [],
  zoneRules: {
    hillScorePerSecond: 1,
    goalScore: 1,
    lapScore: 1,
  },
  items: [],
  itemRules: {
    returnTicks: 240,
    carrySpeedMultiplier: 0.85,
    carryScorePerSecond: 1,
    deliverScore: 1,
    stealGraceTicks: 45,
  },
  bots: { maxCount: 8, speedMultiplier: 0.85 },
  powerups: {
    speedTicks: 150,
    speedMultiplier: 1.5,
    shieldTicks: 240,
    healAmount: 2,
  },
};

/** Seconds per tick — the `dt` every system integrates with. */
export function tickDeltaSeconds(config: SimConfig): number {
  return 1 / config.tickRate;
}

/** Converts a duration in seconds to ticks for the given config. */
export function secondsToTicks(config: SimConfig, seconds: number): number {
  return Math.round(seconds * config.tickRate);
}

/**
 * `Partial<SimConfig>`, with the kit sections themselves partial too, so a
 * test or preset can say `{ combat: { enabled: true } }` and keep the other
 * combat numbers at their defaults.
 */
export interface SimConfigOverrides extends Partial<
  Omit<
    SimConfig,
    | 'pickupWeights'
    | 'vehicle'
    | 'collision'
    | 'track'
    | 'race'
    | 'platform'
    | 'phases'
    | 'teams'
    | 'combat'
    | 'projectiles'
    | 'tag'
    | 'ball'
    | 'zoneRules'
    | 'itemRules'
    | 'bots'
    | 'powerups'
  >
> {
  readonly pickupWeights?: Partial<PickupWeights>;
  readonly vehicle?: Partial<VehicleConfig>;
  readonly collision?: Partial<CollisionConfig>;
  readonly track?: Partial<TrackConfig>;
  readonly race?: Partial<RaceConfig>;
  readonly platform?: Partial<PlatformConfig>;
  readonly phases?: Partial<PhasesConfig>;
  readonly teams?: Partial<TeamsConfig>;
  readonly combat?: Partial<CombatConfig>;
  readonly projectiles?: Partial<ProjectileConfig>;
  readonly tag?: Partial<TagConfig>;
  readonly ball?: Partial<BallConfig>;
  readonly zoneRules?: Partial<ZoneRulesConfig>;
  readonly itemRules?: Partial<ItemRulesConfig>;
  readonly bots?: Partial<BotsConfig>;
  readonly powerups?: Partial<PowerupConfig>;
}

/**
 * Builds a full config from overrides. Kit sections merge one level deep, so
 * `makeSimConfig({ combat: { enabled: true } })` keeps the other combat
 * numbers at their defaults instead of dropping them.
 */
export function makeSimConfig(overrides: SimConfigOverrides = {}): SimConfig {
  const base = DEFAULT_SIM_CONFIG;
  return {
    ...base,
    ...overrides,
    pickupWeights: { ...base.pickupWeights, ...overrides.pickupWeights },
    vehicle: { ...base.vehicle, ...overrides.vehicle },
    collision: { ...base.collision, ...overrides.collision },
    track: { ...base.track, ...overrides.track },
    trackPath: overrides.trackPath ?? base.trackPath,
    race: { ...base.race, ...overrides.race },
    platform: { ...base.platform, ...overrides.platform },
    platforms: overrides.platforms ?? base.platforms,
    phases: { ...base.phases, ...overrides.phases },
    teams: { ...base.teams, ...overrides.teams },
    combat: { ...base.combat, ...overrides.combat },
    projectiles: { ...base.projectiles, ...overrides.projectiles },
    tag: { ...base.tag, ...overrides.tag },
    ball: { ...base.ball, ...overrides.ball },
    zones: overrides.zones ?? base.zones,
    zoneRules: { ...base.zoneRules, ...overrides.zoneRules },
    items: overrides.items ?? base.items,
    itemRules: { ...base.itemRules, ...overrides.itemRules },
    bots: { ...base.bots, ...overrides.bots },
    powerups: { ...base.powerups, ...overrides.powerups },
  };
}
