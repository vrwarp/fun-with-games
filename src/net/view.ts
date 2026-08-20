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
  heading: number;
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
  isBot: boolean;
  isLocal: boolean;
  isHost: boolean;
}

export interface RenderPickup {
  id: number;
  x: number;
  z: number;
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
  ownerId: string;
}

/** A zone's static geometry merged with its live ownership. */
export interface RenderZone {
  id: number;
  kind: 'hill' | 'goal' | 'base' | 'checkpoint';
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
});
