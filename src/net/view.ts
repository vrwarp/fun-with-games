import type { PhaseId, PickupKind } from '../sim/types.js';

/**
 * View model handed to the renderer and the HUD. Deliberately flat and
 * Babylon-free: everything here is plain data derived from the latest
 * authoritative snapshots by `ClientView.sample()`.
 *
 * If a new piece of simulation state needs to be *seen* (drawn, shown in the
 * HUD, announced), extend this model and project it in `ClientView.sample()`
 * — never let the renderer read the `World` directly.
 */
export interface RenderPlayer {
  id: string;
  name: string;
  color: string;
  x: number;
  z: number;
  /** Height of the feet above the floor; 0 in every flat (top-down) mode. */
  y: number;
  heading: number;
  /**
   * World velocity, for anything that has to know how fast a body is moving
   * rather than merely where it is.
   *
   * Present because the engine audio needs both terms and cannot get them
   * honestly any other way: pitch follows road speed, and a Doppler shift is a
   * function of velocity along the line to the listener. Differentiating the
   * rendered position instead would work out to the same thing with a frame of
   * lag and a lot of noise, and this is already on the wire for prediction, so
   * projecting it costs nothing.
   */
  vx: number;
  vz: number;
  /** Standing on something. Airborne players can be drawn mid-leap. */
  grounded: boolean;
  score: number;
  /** Team index, or -1 in free-for-all modes. */
  team: number;
  /** Game-defined role marker (1 = "it" in tag modes). */
  role: number;
  hp: number;
  lives: number;
  /** Active effect ids (`'speed'`, `'shield'`, `'frozen'`, `'ko'`, …). */
  effects: string[];
  /** What the player is carrying, or '' when nothing. */
  carrying: '' | 'flag' | 'crown';
  checkpoint: number;
  lap: number;
  /**
   * 1-based race position; 0 when the mode is not a race.
   *
   * Derived, not simulated — see `raceStandings` in `src/sim/systems/race.ts`.
   */
  position: number;
  /** Seconds behind the car directly ahead. 0 for the leader. */
  interval: number;
  /** Seconds elapsed on the current lap. 0 before the first line crossing. */
  lapTime: number;
  /** Last completed lap, in seconds. 0 = none yet. */
  lastLap: number;
  /** Fastest lap this round, in seconds. 0 = none yet. */
  bestLap: number;
  /** Tyre life left, 1 fresh to 0 gone. Always 1 when wear is disabled. */
  tyres: number;
  isBot: boolean;
  isLocal: boolean;
  isHost: boolean;
}

export interface RenderPickup {
  id: number;
  x: number;
  z: number;
  /** Surface the shard rests on, so ledge pickups draw at the right height. */
  y: number;
  kind: PickupKind;
  active: boolean;
}

export interface RenderPhase {
  id: PhaseId;
  round: number;
  /** Seconds until this phase ends; 0 when open-ended. */
  remainingSeconds: number;
  winnerId: string;
  /** Display name for `winnerId`, when it is still known. */
  winnerName: string;
  winnerTeam: number;
}

export interface RenderBall {
  x: number;
  z: number;
}

export interface RenderProjectile {
  id: number;
  x: number;
  z: number;
  y: number;
  ownerId: string;
}

/** A zone's static geometry merged with its live ownership. */
export interface RenderZone {
  id: number;
  kind: 'hill' | 'goal' | 'base' | 'checkpoint' | 'drs' | 'pit';
  x: number;
  z: number;
  radius: number;
  team: number;
  order: number;
  ownerTeam: number;
  ownerId: string;
}

export interface RenderItem {
  id: number;
  kind: 'flag' | 'crown';
  x: number;
  z: number;
  y: number;
  /** When set, draw the item attached to this player instead of at x/z. */
  carrierId: string;
  team: number;
  atHome: boolean;
}

export interface RenderState {
  /** Tick of the most recent authoritative snapshot this state derives from. */
  tick: number;
  phase: RenderPhase;
  players: RenderPlayer[];
  pickups: RenderPickup[];
  /** Indexed by team; empty in free-for-all modes. */
  teamScores: number[];
  ball: RenderBall | null;
  projectiles: RenderProjectile[];
  zones: RenderZone[];
  items: RenderItem[];
  /** `combat.maxHp` when combat is enabled, else 0 (hide health UI). */
  maxHp: number;
  /**
   * Laps needed to win, or 0 when the mode is not a race (hide the lap UI).
   *
   * The circuit's geometry is deliberately NOT here: it is static config, and
   * `src/render` already holds the `SimConfig` it was built from. Only things
   * that change belong in a per-frame view model.
   */
  totalLaps: number;
}

export const EMPTY_RENDER_PHASE: RenderPhase = Object.freeze({
  id: 'playing',
  round: 1,
  remainingSeconds: 0,
  winnerId: '',
  winnerName: '',
  winnerTeam: -1,
});

/** Shared "nothing to draw yet" value. Frozen so a consumer cannot corrupt it. */
export const EMPTY_RENDER_STATE: RenderState = Object.freeze({
  tick: 0,
  phase: EMPTY_RENDER_PHASE,
  players: [] as RenderPlayer[],
  pickups: [] as RenderPickup[],
  teamScores: [] as number[],
  ball: null,
  projectiles: [] as RenderProjectile[],
  zones: [] as RenderZone[],
  items: [] as RenderItem[],
  maxHp: 0,
  totalLaps: 0,
});
