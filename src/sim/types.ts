export type PlayerId = string;

/**
 * One tick's worth of intent from a player.
 *
 * `seq` is the client's monotonically increasing input counter. The host
 * echoes the highest `seq` it has consumed back in the snapshot, which is what
 * lets a client discard acknowledged inputs and replay only the rest.
 */
export interface PlayerInput {
  readonly seq: number;
  /** Desired movement on the X axis, in [-1, 1]. */
  readonly moveX: number;
  /** Desired movement on the Z axis, in [-1, 1]. */
  readonly moveZ: number;
  readonly sprint: boolean;
}

export const EMPTY_INPUT: PlayerInput = Object.freeze({
  seq: 0,
  moveX: 0,
  moveZ: 0,
  sprint: false,
});

/** Cosmetic, non-authoritative information a peer announces about itself. */
export interface PlayerProfile {
  readonly name: string;
  /** Hex colour, e.g. `#4cc9f0`. */
  readonly color: string;
}

export interface PlayerState {
  id: PlayerId;
  name: string;
  color: string;
  x: number;
  z: number;
  vx: number;
  vz: number;
  /** Facing angle in radians; derived from velocity, kept for smooth turning. */
  heading: number;
  score: number;
  /** Highest input `seq` the simulation has applied for this player. */
  lastInputSeq: number;
  /**
   * The player's current intent, held until a newer input replaces it.
   *
   * This lives in player state — rather than in a side table on `World` —
   * because it drives every future tick, which makes it part of what a
   * snapshot has to carry. Leaving it out means a peer that restores a
   * snapshot (a new host after migration, or a test resuming a recording)
   * would have everyone coast to a stop while the original kept moving.
   *
   * Holding the last input also makes a dropped packet cost nothing: the
   * player keeps doing what they were doing instead of stuttering.
   */
  input: PlayerInput;
}

export interface PickupState {
  id: number;
  x: number;
  z: number;
  active: boolean;
  /** Tick at which an inactive pickup becomes active again. */
  respawnTick: number;
}

/** Static, seed-generated arena geometry. Never changes during a round. */
export interface Obstacle {
  id: number;
  x: number;
  z: number;
  halfX: number;
  halfZ: number;
}

/**
 * A complete, self-contained description of the world at one tick.
 *
 * Applying a snapshot to a fresh `World` with the same seed must produce a
 * world indistinguishable from the source. Tests assert exactly that, so any
 * new mutable field MUST be added here as well as to `World`.
 */
export interface WorldSnapshot {
  tick: number;
  rngState: number;
  players: PlayerState[];
  pickups: PickupState[];
}

/** Emitted by the simulation so presentation layers can react to gameplay. */
export type SimEvents = {
  pickupCollected: { playerId: PlayerId; pickupId: number; score: number };
  pickupRespawned: { pickupId: number };
  playerJoined: { playerId: PlayerId };
  playerLeft: { playerId: PlayerId };
};
