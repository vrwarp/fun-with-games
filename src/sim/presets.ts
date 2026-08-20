import type { GameModeId } from '../shared/modes.js';
import { makeSimConfig, type SimConfig, type SimConfigOverrides } from './config.js';

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
    phases: { enabled: true, minPlayers: 2, targetScore: 45 },
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
