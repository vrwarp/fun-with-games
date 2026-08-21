import type { GameModeId } from '../shared/modes.js';
import {
  makeSimConfig,
  type PlatformSpec,
  type SimConfig,
  type SimConfigOverrides,
} from './config.js';

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
