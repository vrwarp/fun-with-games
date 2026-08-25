import { makeSimConfig, type SimConfigOverrides } from '@/sim/config.js';
import { obstacleTop } from '@/sim/systems/arena.js';
import { Rng } from '@/sim/rng.js';
import type { SimEventRecord, StepContext } from '@/sim/step.js';
import {
  EMPTY_INPUT,
  INITIAL_PHASE,
  TEAM_NONE,
  type Obstacle,
  type PlayerInput,
  type PlayerState,
  type WorldSnapshot,
} from '@/sim/types.js';

/**
 * Factories for hand-built simulation objects in unit tests.
 *
 * Prefer driving a real `World` (or `SessionHarness` for anything
 * multi-peer) — these exist for surgical tests of a single system where
 * constructing the full pipeline would bury the point of the test.
 */

export function makeInput(overrides: Partial<PlayerInput> = {}): PlayerInput {
  return { seq: 1, moveX: 0, moveZ: 0, sprint: false, buttons: 0, ...overrides };
}

export function makePlayer(overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    id: 'p1',
    name: 'p1',
    color: '#ffffff',
    x: 0,
    z: 0,
    y: 0,
    vx: 0,
    vz: 0,
    vy: 0,
    heading: 0,
    score: 0,
    team: TEAM_NONE,
    role: 0,
    hp: 3,
    lives: 0,
    checkpoint: 0,
    lap: 0,
    lapStartTick: 0,
    lastLapTicks: 0,
    bestLapTicks: 0,
    grounded: true,
    jumps: 0,
    jumpLatch: false,
    isBot: false,
    effects: {},
    lastInputSeq: 0,
    input: EMPTY_INPUT,
    ...overrides,
  };
}

/** A complete `WorldSnapshot` with empty kit state, for hand-fed net tests. */
export function makeSnapshot(
  tick: number,
  players: PlayerState[],
  extra: Partial<WorldSnapshot> = {},
): WorldSnapshot {
  return {
    tick,
    rngState: 1,
    phase: { ...INITIAL_PHASE },
    players,
    pickups: [],
    teamScores: [],
    ball: null,
    projectiles: [],
    items: [],
    zones: [],
    tyreStacks: [],
    ...extra,
  };
}

/**
 * A box for collision tests. Defaults to a ground-level wall, which is what
 * every flat mode generates; pass `baseY` to float it into a platform.
 */
export function makeObstacle(overrides: Partial<Obstacle> = {}): Obstacle {
  const halfX = overrides.halfX ?? 1;
  return {
    id: 0,
    x: 0,
    z: 0,
    halfX,
    halfZ: 1,
    baseY: 0,
    top: obstacleTop(halfX),
    ...overrides,
  };
}

export interface StepContextOverrides {
  config?: SimConfigOverrides;
  tick?: number;
  seed?: number;
  players?: PlayerState[];
  ctx?: Partial<
    Pick<
      StepContext,
      | 'pickups'
      | 'phase'
      | 'teamScores'
      | 'ball'
      | 'projectiles'
      | 'items'
      | 'zones'
      | 'obstacles'
      | 'tyreStacks'
    >
  >;
}

/**
 * A bare `StepContext` for driving one system directly. `players` MUST be
 * passed pre-sorted by id (the contract every system assumes).
 */
export function makeStepContext(overrides: StepContextOverrides = {}): StepContext {
  const config = makeSimConfig(overrides.config ?? {});
  return {
    config,
    tick: overrides.tick ?? 0,
    rng: new Rng(overrides.seed ?? 1),
    obstacles: overrides.ctx?.obstacles ?? [],
    players: overrides.players ?? [],
    pickups: overrides.ctx?.pickups ?? [],
    phase: overrides.ctx?.phase ?? { ...INITIAL_PHASE },
    teamScores: overrides.ctx?.teamScores ?? new Array<number>(config.teams.count).fill(0),
    ball: overrides.ctx?.ball ?? null,
    projectiles: overrides.ctx?.projectiles ?? [],
    items: overrides.ctx?.items ?? [],
    zones: overrides.ctx?.zones ?? [],
    tyreStacks: overrides.ctx?.tyreStacks ?? [],
    out: [],
  };
}

/** Events of one type collected in a context, with payload typing intact. */
export function eventsOfType<T extends SimEventRecord['type']>(
  out: readonly SimEventRecord[],
  type: T,
): Extract<SimEventRecord, { type: T }>[] {
  return out.filter((event): event is Extract<SimEventRecord, { type: T }> => event.type === type);
}
