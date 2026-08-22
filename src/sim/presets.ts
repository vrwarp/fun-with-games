import type { GameModeId } from '../shared/modes.js';
import {
  makeSimConfig,
  type PlatformSpec,
  type SimConfig,
  type SimConfigOverrides,
  type TrackPoint,
  type ZoneSpec,
} from './config.js';
import { trackLength, trackPoseAt } from './track.js';

/**
 * Named game modes: one `SimConfig` per `GameModeId`.
 *
 * A mode is *only* configuration — which systems are on and their numbers.
 * That is the intended way to make "a different game" out of this kit: start
 * from the closest preset below, tweak, and only write new simulation code
 * when no combination of systems expresses the rule you want.
 * `docs/RECIPES.md` walks through both paths.
 *
 * Every peer in a room must run the same config. `main.ts` guarantees that by
 * putting the mode id into the transport room name, so differently-configured
 * clients never meet.
 */

const seconds = (n: number): number => n * 30; // ticks at the 30 Hz tick rate

/**
 * A hand-authored side-scrolling level: a staircase of ledges climbing to the
 * right, one perch that needs the double jump, then a descent and a final
 * climb.
 *
 * Authored, not generated, because a platformer is the one genre where random
 * geometry does not work: every step has to be jumpable, and "jumpable" is
 * arithmetic, not taste. A jump peaks at `jumpVelocity² / 2·gravity` — with
 * this preset's 12 and 30, that is **2.4 units**, about 4.8 with the double
 * jump. Every rise below is 1.8, comfortably inside a single jump, and the
 * one 3-unit step to the high perch is the only place the double jump is
 * required. Horizontal reach is `2·jumpVelocity / gravity × speed` ≈ 6.4
 * units; the widest gap here is 3.5.
 *
 * Retuning `platform` without re-checking those two numbers is how a level
 * silently becomes unfinishable — `tests/unit/sim/platform.test.ts` pins the
 * height relationship for exactly that reason.
 *
 * `halfZ` is generous so the one-lane player can never miss a platform
 * sideways — in a `lockZ` mode depth is not something the player can get wrong.
 */
const PLATFORMER_LEVEL: readonly PlatformSpec[] = [
  // Opening staircase: three 1.8-unit steps, each a single jump.
  { x: -34, z: 0, halfX: 4, halfZ: 3, baseY: 0, top: 1.8 },
  { x: -24, z: 0, halfX: 3.5, halfZ: 3, baseY: 0, top: 3.6 },
  { x: -15, z: 0, halfX: 3, halfZ: 3, baseY: 0, top: 5.4 },
  // The one place the double jump is mandatory: a 3-unit rise.
  { x: -6, z: 0, halfX: 2.5, halfZ: 3, baseY: 0, top: 8.4 },
  // Descending run of floating ledges — jump down, or walk underneath.
  { x: 2, z: 0, halfX: 3, halfZ: 3, baseY: 6, top: 7 },
  { x: 10, z: 0, halfX: 3, halfZ: 3, baseY: 3.5, top: 4.5 },
  { x: 18, z: 0, halfX: 3.5, halfZ: 3, baseY: 0, top: 2.5 },
  // Final climb, back to single-jump steps.
  { x: 27, z: 0, halfX: 3, halfZ: 3, baseY: 0, top: 4.3 },
  { x: 35, z: 0, halfX: 3.5, halfZ: 3, baseY: 0, top: 6.1 },
  { x: 42, z: 0, halfX: 3, halfZ: 3, baseY: 5, top: 8 },
];

// ---------------------------------------------------------------------------
// Circuits
// ---------------------------------------------------------------------------

/**
 * Evenly spaced timing gates around a circuit, gate 0 on the start/finish line.
 *
 * Generated rather than hand-placed because a gate has to sit ON the racing
 * line to be crossable, and "on the line" is arithmetic the centreline already
 * knows. `radius` is deliberately wider than the road: a car that runs wide
 * still trips the loop, so a mistake costs time instead of stranding the
 * driver at a gate they can no longer reach.
 */
function trackGates(path: readonly TrackPoint[], count: number, radius: number): ZoneSpec[] {
  const length = trackLength(path);
  return Array.from({ length: count }, (_, order) => {
    const pose = trackPoseAt(path, (order * length) / count);
    return { kind: 'checkpoint', x: pose.x, z: pose.z, radius, team: -1, order } as const;
  });
}

/**
 * A permanent road course, in the order it is driven.
 *
 * Point 0 is the start/finish line, which is what makes the grid, the gates
 * and every lap time fall out of the list without another number being
 * written down. Read it as a lap: a long main straight, a fast right onto the
 * back straight, a long left sweeper, a chicane that has to be braked for, a
 * hairpin at the far end, and a final corner that spits the car back onto the
 * straight — so the driver arrives at the line with the tow.
 *
 * The line is drawn well down the main straight rather than at the corner
 * exit, because everything behind it is grid: a pole slot on a corner is a
 * pole slot nobody wants.
 */
const AUTODROME: readonly TrackPoint[] = [
  // Main straight, running +X.
  { x: -14, z: -31 }, // start/finish
  { x: 0, z: -31 },
  { x: 12, z: -31 },
  { x: 22, z: -30.5 },
  // Turn 1: a long right onto the back straight.
  { x: 31, z: -29 },
  { x: 38, z: -25 },
  { x: 44, z: -19 },
  { x: 47, z: -11 },
  // Back straight, running +Z.
  { x: 49, z: -2 },
  { x: 49, z: 8 },
  // The long left sweeper across the top of the circuit.
  { x: 46, z: 17 },
  { x: 40, z: 24 },
  { x: 32, z: 28 },
  { x: 23, z: 29 },
  // Chicane: right, then hard left. The one corner that must be braked for.
  { x: 14, z: 27 },
  { x: 7, z: 23 },
  { x: 2, z: 18 },
  { x: -4, z: 19 },
  { x: -9, z: 23 },
  { x: -16, z: 27 },
  { x: -26, z: 29 },
  { x: -35, z: 27 },
  // Hairpin at the far end.
  { x: -43, z: 22 },
  { x: -48, z: 14 },
  { x: -49, z: 5 },
  { x: -49, z: -6 },
  { x: -47, z: -15 },
  // Final corner, back onto the main straight.
  { x: -43, z: -23 },
  { x: -37, z: -28 },
  { x: -33, z: -30 },
  { x: -26, z: -31 },
];

/**
 * A tight city lap: short straights, square corners, no room to hide.
 *
 * Same authoring rules as the autodrome — point 0 is the line, and corners get
 * several points each so the road bends rather than kinks.
 */
const STREET: readonly TrackPoint[] = [
  { x: -14, z: -18 }, // start/finish
  { x: 0, z: -18 },
  { x: 10, z: -18 },
  { x: 18, z: -16 },
  { x: 23, z: -11 },
  { x: 25, z: -4 },
  { x: 24, z: 4 },
  { x: 20, z: 10 },
  { x: 13, z: 14 },
  { x: 5, z: 13 },
  { x: 0, z: 8 },
  { x: -3, z: 3 }, // the tight left-right through the old town
  { x: -8, z: 5 },
  { x: -15, z: 10 },
  { x: -22, z: 13 },
  { x: -28, z: 9 },
  { x: -30, z: 2 },
  { x: -30, z: -6 },
  { x: -28, z: -13 },
  { x: -24, z: -17 },
  { x: -20, z: -18 },
];

const PRESETS: Record<GameModeId, SimConfigOverrides> = {
  /** The untouched sandbox: endless shard collecting. */
  gather: {},

  rush: {
    phases: {
      enabled: true,
      minPlayers: 1,
      playTicks: seconds(90),
      targetScore: 25,
    },
    pickupWeights: { score: 0.85, speed: 0.15, shield: 0, heal: 0 },
  },

  tag: {
    tag: { enabled: true, variant: 'transfer' },
    phases: { enabled: true, minPlayers: 2, playTicks: seconds(90) },
    pickupCount: 6,
    pickupWeights: { score: 0, speed: 1, shield: 0, heal: 0 },
  },

  infection: {
    tag: { enabled: true, variant: 'spread' },
    phases: { enabled: true, minPlayers: 3, playTicks: seconds(75) },
    pickupCount: 6,
    pickupWeights: { score: 0, speed: 1, shield: 0, heal: 0 },
  },

  hill: {
    zones: [{ kind: 'hill', x: 0, z: 0, radius: 4, team: -1, order: 0 }],
    // Blasters with no combat: hits shove but never hurt — the mechanic is
    // knocking rivals OFF the hill. The timer matters: a permanently
    // contested hill pays nobody, so rounds must be able to end on time.
    projectiles: { enabled: true, knockback: 14, cooldownTicks: 24 },
    phases: { enabled: true, minPlayers: 2, targetScore: 45, playTicks: seconds(120) },
    pickupCount: 4,
    pickupWeights: { score: 0, speed: 1, shield: 0, heal: 0 },
  },

  race: {
    zones: [
      { kind: 'checkpoint', x: 16, z: 0, radius: 3.5, team: -1, order: 0 },
      { kind: 'checkpoint', x: 0, z: 16, radius: 3.5, team: -1, order: 1 },
      { kind: 'checkpoint', x: -16, z: 0, radius: 3.5, team: -1, order: 2 },
      { kind: 'checkpoint', x: 0, z: -16, radius: 3.5, team: -1, order: 3 },
    ],
    zoneRules: { lapScore: 1, hillScorePerSecond: 0, goalScore: 0 },
    phases: { enabled: true, minPlayers: 2, targetScore: 3 },
    pickupCount: 6,
    pickupWeights: { score: 0, speed: 1, shield: 0, heal: 0 },
  },

  arena: {
    combat: { enabled: true, maxHp: 3, lives: 0, koScore: 1 },
    projectiles: { enabled: true },
    phases: { enabled: true, minPlayers: 2, playTicks: seconds(120), targetScore: 10 },
    pickupCount: 8,
    pickupWeights: { score: 0, speed: 0.4, shield: 0.3, heal: 0.3 },
  },

  knockout: {
    combat: { enabled: true, maxHp: 3, lives: 3, koScore: 1, respawnTicks: seconds(2) },
    projectiles: { enabled: true },
    phases: { enabled: true, minPlayers: 2 },
    pickupCount: 8,
    pickupWeights: { score: 0, speed: 0.4, shield: 0.3, heal: 0.3 },
  },

  soccer: {
    teams: { count: 2 },
    ball: { enabled: true },
    zones: [
      { kind: 'goal', x: -21, z: 0, radius: 3, team: 0, order: 0 },
      { kind: 'goal', x: 21, z: 0, radius: 3, team: 1, order: 0 },
    ],
    phases: { enabled: true, minPlayers: 2, playTicks: seconds(180), targetScore: 5 },
    pickupCount: 0,
    obstacleCount: 0,
  },

  ctf: {
    teams: { count: 2 },
    items: [
      { kind: 'flag', homeX: -20, homeZ: 0, team: 0 },
      { kind: 'flag', homeX: 20, homeZ: 0, team: 1 },
    ],
    zones: [
      { kind: 'base', x: -20, z: 0, radius: 3, team: 0, order: 0 },
      { kind: 'base', x: 20, z: 0, radius: 3, team: 1, order: 0 },
    ],
    combat: { enabled: true, maxHp: 3, lives: 0, koScore: 0, respawnTicks: seconds(2) },
    projectiles: { enabled: true },
    phases: { enabled: true, minPlayers: 2, playTicks: seconds(240), targetScore: 3 },
    obstacleCount: 8,
    pickupCount: 6,
    pickupWeights: { score: 0, speed: 0.6, shield: 0, heal: 0.4 },
  },

  crown: {
    items: [{ kind: 'crown', homeX: 0, homeZ: 0, team: -1 }],
    phases: { enabled: true, minPlayers: 2, targetScore: 30 },
    pickupCount: 6,
    pickupWeights: { score: 0, speed: 1, shield: 0, heal: 0 },
  },

  // ---- 2D / 2.5D ----------------------------------------------------------
  // The simulation is a plane, so these differ from the modes above only in
  // configuration: gravity on, one lane deep, and a camera angle chosen in
  // the mode metadata. See docs/GAME_KIT.md § "2D, 2.5D and 3D".

  /**
   * A true side-scrolling platformer: run right, jump the gaps, collect
   * shards off the ledges. The level below is authored rather than generated —
   * random boxes do not make a jumpable level.
   */
  platformer: {
    platform: {
      enabled: true,
      lockZ: true,
      gravity: 30,
      // 12 over gravity 30 peaks at 2.4 units — chosen so the level's 1.8
      // steps clear on one jump with margin to spare. See PLATFORMER_LEVEL.
      jumpVelocity: 12,
      maxJumps: 2,
      jumpButton: 'primary',
    },
    platforms: PLATFORMER_LEVEL,
    arenaHalfExtentX: 46,
    arenaHalfExtentZ: 4,
    obstacleCount: 0,
    playerMaxSpeed: 8,
    pickupCount: 22,
    pickupRespawnTicks: 240,
    pickupWeights: { score: 0.85, speed: 0.15, shield: 0, heal: 0 },
    phases: { enabled: true, minPlayers: 1, targetScore: 20, playTicks: seconds(150) },
  },

  /** Flat 2D arena shooter viewed from straight overhead. */
  skirmish: {
    combat: { enabled: true, maxHp: 3, lives: 0, koScore: 1 },
    projectiles: { enabled: true, speed: 18, cooldownTicks: 14 },
    phases: { enabled: true, minPlayers: 2, playTicks: seconds(120), targetScore: 10 },
    arenaHalfExtentX: 20,
    arenaHalfExtentZ: 20,
    obstacleCount: 12,
    pickupCount: 8,
    pickupWeights: { score: 0, speed: 0.4, shield: 0.3, heal: 0.3 },
  },

  // ---- racing -------------------------------------------------------------
  // The one place the kit swaps its movement model: `vehicle.enabled` turns
  // the omnidirectional avatar into something that has to be driven. The rest
  // is ordinary configuration — a centreline, gates generated from it, and
  // three circles that mean "open the wing here" and "change tyres here".

  /**
   * The full Formula weekend: a grid start, three laps, a slipstream, DRS on
   * the two straights, tyres that go off, and a pit lane to fix them in.
   */
  grandprix: {
    vehicle: {
      enabled: true,
      engineAccel: 22,
      brakeDecel: 40,
      coastDecel: 13,
      // Understeer, deliberately: flat out the car keeps 42% of its steering,
      // which is what makes braking for the hairpin a decision rather than a
      // formality.
      steerRate: 3.1,
      steerFalloff: 0.58,
      grip: 8,
      brakeButton: 'secondary',
    },
    track: {
      enabled: true,
      halfWidth: 6,
      offTrackSpeed: 0.45,
      offTrackGrip: 0.3,
      gridColumns: 2,
      gridRowSpacing: 5,
    },
    trackPath: AUTODROME,
    race: {
      enabled: true,
      slipstreamRange: 10,
      slipstreamMultiplier: 1.12,
      drsGapSeconds: 1,
      drsMultiplier: 1.24,
      drsTicks: seconds(2),
      drsButton: 'primary',
      // A stint is about four laps of this circuit, so a three-lap race is
      // winnable on one set — and a driver who runs wide often enough is not.
      tyreStintTicks: seconds(70),
      tyreWornGrip: 0.62,
      tyreWornSpeed: 0.87,
      pitSpeedLimit: 9,
    },
    zones: [
      ...trackGates(AUTODROME, 9, 12),
      // DRS on the two straights only, which is where a tow is worth having.
      { kind: 'drs', x: 0, z: -31, radius: 14, team: -1, order: 0 },
      { kind: 'drs', x: 48, z: 0, radius: 12, team: -1, order: 0 },
      // The pit lane runs down the infield beside the main straight. The
      // middle box is inside gate 0's loop, so a car that pits still records
      // its lap instead of getting stuck on a gate it drove around.
      { kind: 'pit', x: -30, z: -20, radius: 4, team: -1, order: 0 },
      { kind: 'pit', x: -22, z: -20, radius: 4, team: -1, order: 0 },
      { kind: 'pit', x: -14, z: -20, radius: 4, team: -1, order: 0 },
    ],
    zoneRules: { lapScore: 1, hillScorePerSecond: 0, goalScore: 0 },
    phases: {
      enabled: true,
      minPlayers: 2,
      // Long enough that a three-lap race always finishes; the lap count is
      // what actually ends it.
      playTicks: seconds(300),
      targetScore: 3,
      countdownTicks: seconds(4),
    },
    playerMaxSpeed: 27,
    playerRadius: 0.7,
    // Cars bump; they do not shove each other across the circuit.
    playerHeight: 1.1,
    arenaHalfExtentX: 62,
    arenaHalfExtentZ: 42,
    obstacleCount: 0,
    pickupCount: 0,
    bots: { maxCount: 8, speedMultiplier: 0.93 },
  },

  /**
   * A sprint on a tight city lap, seen from above: same cars, no wings, no
   * tyre stops. Five laps, decided on the racing line.
   */
  street: {
    vehicle: {
      enabled: true,
      engineAccel: 24,
      brakeDecel: 42,
      coastDecel: 15,
      steerRate: 3.6,
      steerFalloff: 0.5,
      grip: 9,
      brakeButton: 'secondary',
    },
    track: {
      enabled: true,
      halfWidth: 4.5,
      offTrackSpeed: 0.4,
      offTrackGrip: 0.3,
      gridColumns: 2,
      gridRowSpacing: 4,
    },
    trackPath: STREET,
    race: {
      enabled: true,
      slipstreamRange: 8,
      slipstreamMultiplier: 1.1,
      // No straight here is long enough to deserve a wing.
      drsGapSeconds: 0,
      drsButton: 'none',
      tyreStintTicks: 0,
    },
    zones: [...trackGates(STREET, 6, 9)],
    zoneRules: { lapScore: 1, hillScorePerSecond: 0, goalScore: 0 },
    phases: {
      enabled: true,
      minPlayers: 2,
      playTicks: seconds(240),
      targetScore: 5,
      countdownTicks: seconds(4),
    },
    playerMaxSpeed: 20,
    playerRadius: 0.6,
    playerHeight: 1.1,
    arenaHalfExtentX: 38,
    arenaHalfExtentZ: 26,
    obstacleCount: 0,
    pickupCount: 0,
    bots: { maxCount: 8, speedMultiplier: 0.94 },
  },

  /** 2.5D isometric: an infection chase through a cluttered floor plan. */
  dungeon: {
    tag: { enabled: true, variant: 'spread', graceTicks: 45 },
    phases: { enabled: true, minPlayers: 3, playTicks: seconds(90) },
    arenaHalfExtentX: 22,
    arenaHalfExtentZ: 22,
    obstacleCount: 16,
    obstacleMinHalfExtent: 1,
    obstacleMaxHalfExtent: 2.5,
    pickupCount: 10,
    pickupWeights: { score: 0.7, speed: 0.3, shield: 0, heal: 0 },
  },
};

/** The full `SimConfig` for a mode. Every peer in a room must use the same. */
export function modeConfig(id: GameModeId): SimConfig {
  return makeSimConfig(PRESETS[id]);
}

/** Raw overrides for a mode — the starting point when deriving a variant. */
export function modeOverrides(id: GameModeId): SimConfigOverrides {
  return PRESETS[id];
}

export const GAME_MODE_IDS = Object.keys(PRESETS) as GameModeId[];
