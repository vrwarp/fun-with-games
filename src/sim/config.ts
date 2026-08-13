/**
 * Every tunable number in the simulation lives here.
 *
 * Rules of the road for agents: gameplay code reads from a `SimConfig` that is
 * passed in, it never imports `DEFAULT_SIM_CONFIG` directly. Tests build tiny
 * bespoke configs (a 4x4 arena with one pickup) to make assertions obvious,
 * and that only works if nothing reaches for the global default.
 */
export interface SimConfig {
  /** Fixed simulation steps per second. The wire protocol assumes this too. */
  readonly tickRate: number;
  /** Snapshots are broadcast every N ticks. 2 => 15 Hz at a 30 Hz tick rate. */
  readonly snapshotIntervalTicks: number;

  /** Arena is an axis-aligned box centred on the origin. */
  readonly arenaHalfExtentX: number;
  readonly arenaHalfExtentZ: number;

  readonly playerRadius: number;
  readonly playerAcceleration: number;
  readonly playerMaxSpeed: number;
  readonly playerSprintMultiplier: number;
  /** Velocity decay per second when there is no input, as a fraction. */
  readonly playerFriction: number;

  readonly pickupCount: number;
  readonly pickupRadius: number;
  readonly pickupRespawnTicks: number;
  readonly pickupScore: number;

  readonly obstacleCount: number;
  readonly obstacleMinHalfExtent: number;
  readonly obstacleMaxHalfExtent: number;

  /** Rounds ends after this many ticks; 0 disables the timer. */
  readonly roundDurationTicks: number;
}

export const DEFAULT_SIM_CONFIG: SimConfig = {
  tickRate: 30,
  snapshotIntervalTicks: 2,

  arenaHalfExtentX: 24,
  arenaHalfExtentZ: 24,

  playerRadius: 0.5,
  playerAcceleration: 55,
  playerMaxSpeed: 9,
  playerSprintMultiplier: 1.6,
  playerFriction: 8,

  pickupCount: 14,
  pickupRadius: 0.7,
  pickupRespawnTicks: 90,
  pickupScore: 1,

  obstacleCount: 10,
  obstacleMinHalfExtent: 1,
  obstacleMaxHalfExtent: 3,

  roundDurationTicks: 0,
};

/** Seconds per tick — the `dt` every system integrates with. */
export function tickDeltaSeconds(config: SimConfig): number {
  return 1 / config.tickRate;
}

export function makeSimConfig(overrides: Partial<SimConfig> = {}): SimConfig {
  return { ...DEFAULT_SIM_CONFIG, ...overrides };
}
