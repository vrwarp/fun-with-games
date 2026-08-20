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
 */
export interface ZoneSpec {
  readonly kind: 'hill' | 'goal' | 'base' | 'checkpoint';
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
