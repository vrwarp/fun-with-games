import type { SimConfig } from './config.js';
import type { Rng } from './rng.js';
import type {
  BallState,
  ItemState,
  Obstacle,
  PhaseState,
  PickupState,
  PlayerState,
  ProjectileState,
  SimEvents,
  TyreStackState,
  ZoneRuntimeState,
} from './types.js';

/**
 * One gameplay event, as collected during a step.
 *
 * Systems push these into `StepContext.out` instead of emitting directly;
 * `World.step()` emits them all after the tick completes. That keeps systems
 * free of any dependency on the emitter and keeps event order stable.
 */
export type SimEventRecord = {
  [K in keyof SimEvents]: { type: K } & SimEvents[K];
}[keyof SimEvents];

/**
 * Everything a simulation system may read or mutate during one tick.
 *
 * `World.step()` builds one of these per tick and hands it to each system in
 * the fixed pipeline order. Systems communicate only through this state —
 * never through module-level variables, which would escape the snapshot and
 * desync.
 *
 * `players` is ALWAYS sorted by id (the canonical order); iterate it directly.
 */
export interface StepContext {
  readonly config: SimConfig;
  /** The tick being simulated (== World.tick before it increments). */
  readonly tick: number;
  readonly rng: Rng;
  readonly obstacles: readonly Obstacle[];
  readonly players: readonly PlayerState[];
  readonly pickups: PickupState[];
  phase: PhaseState;
  readonly teamScores: number[];
  ball: BallState | null;
  projectiles: ProjectileState[];
  readonly items: ItemState[];
  readonly zones: ZoneRuntimeState[];
  readonly tyreStacks: TyreStackState[];
  /** Events raised this tick; `World` emits them after the step. */
  readonly out: SimEventRecord[];
}
