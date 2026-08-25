export type PlayerId = string;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** Bit in `PlayerInput.buttons` for the primary action (fire / kick / use). */
export const BUTTON_PRIMARY = 1;
/** Bit in `PlayerInput.buttons` for the secondary action (dash / drop / alt). */
export const BUTTON_SECONDARY = 2;
/** All defined button bits. The protocol masks incoming values with this. */
export const BUTTON_MASK = BUTTON_PRIMARY | BUTTON_SECONDARY;

/**
 * One tick's worth of intent from a player.
 *
 * `seq` is the client's monotonically increasing input counter. The host
 * echoes the highest `seq` it has consumed back in the snapshot, which is what
 * lets a client discard acknowledged inputs and replay only the rest.
 *
 * `buttons` is a bitfield (`BUTTON_PRIMARY | BUTTON_SECONDARY`) so that new
 * abilities never require a wire-format change — game systems read the bit
 * they care about.
 *
 * **The two axes mean different things depending on the movement model**, and
 * the mode's config decides which — see `moveX`/`moveZ` below. Both readings
 * carry analog magnitude, so a half-pushed thumbstick is half of whatever it
 * is asking for.
 */
export interface PlayerInput {
  readonly seq: number;
  /**
   * On foot: desired movement on the world X axis, in [-1, 1].
   * With `vehicle.enabled`: **steering**, -1 full left to +1 full right.
   */
  readonly moveX: number;
  /**
   * On foot: desired movement on the world Z axis, in [-1, 1].
   * With `vehicle.enabled`: **throttle**, +1 full, 0 coasting, negative
   * braking and then reversing.
   */
  readonly moveZ: number;
  readonly sprint: boolean;
  /** Pressed action buttons, as a bitfield of `BUTTON_*` constants. */
  readonly buttons: number;
}

export const EMPTY_INPUT: PlayerInput = Object.freeze({
  seq: 0,
  moveX: 0,
  moveZ: 0,
  sprint: false,
  buttons: 0,
});

/** Cosmetic, non-authoritative information a peer announces about itself. */
export interface PlayerProfile {
  readonly name: string;
  /** Hex colour, e.g. `#4cc9f0`. */
  readonly color: string;
}

// ---------------------------------------------------------------------------
// Effects and roles
// ---------------------------------------------------------------------------

/**
 * Timed status effects, stored as `effect id -> expiry tick` (exclusive: the
 * effect is active while `tick < expiry`). A plain record so that snapshots,
 * the wire codec and the checksum handle every current and future effect the
 * same way — adding a new effect kind is NOT a protocol change.
 *
 * Well-known ids (see `src/sim/systems/effects.ts` for behaviour):
 *
 * | id       | meaning                                              |
 * | -------- | ---------------------------------------------------- |
 * | `speed`  | moves faster (speed pickup)                          |
 * | `shield` | ignores damage and tags                              |
 * | `frozen` | cannot move (freeze-tag style)                       |
 * | `stun`   | cannot move (brief, from a hit)                      |
 * | `ko`     | knocked out; respawns when it expires                |
 * | `safe`   | tag immunity right after being tagged / respawning   |
 * | `reload` | may not fire a projectile until it expires           |
 * | `carry`  | carrying an item (refreshed each tick by the system) |
 */
export type EffectMap = Record<string, number>;

/** Effect expiry that never arrives within a round — "until further notice". */
export const NEVER_TICK = 0x3fffffff;

/** `PlayerState.role` values. Games are free to define more (2, 3, …). */
export const ROLE_NONE = 0;
/** Tag / infection: this player is "it" (or infected). */
export const ROLE_IT = 1;

/** `team` / `winnerTeam` value meaning "no team". */
export const TEAM_NONE = -1;

export interface PlayerState {
  id: PlayerId;
  name: string;
  color: string;
  x: number;
  z: number;
  /**
   * Height of the player's FEET above the arena floor.
   *
   * Stays 0 in every mode with `platform.enabled` false — the simulation is a
   * plane by default, which is what makes top-down and isometric games as
   * natural here as third-person ones. Gravity, jumping and standable
   * platforms switch on together with that flag.
   */
  y: number;
  vx: number;
  vz: number;
  vy: number;
  /** Facing angle in radians; derived from velocity, kept for smooth turning. */
  heading: number;
  score: number;
  /** Team index in [0, teams.count), or `TEAM_NONE` in free-for-all modes. */
  team: number;
  /** Game-defined marker (`ROLE_IT`, …). `ROLE_NONE` outside role modes. */
  role: number;
  /** Current health. Stays at `combat.maxHp` when combat is disabled. */
  hp: number;
  /** Remaining lives. Only meaningful when `combat.lives > 0`. */
  lives: number;
  /** Next checkpoint index to cross (race modes). */
  checkpoint: number;
  /** Completed laps (race modes). */
  lap: number;
  /**
   * Tick the current lap started on — the last crossing of the start/finish
   * line. 0 before the first crossing, so the clock starts at the line rather
   * than on the grid.
   */
  lapStartTick: number;
  /** Duration of the last completed lap, in ticks. 0 = none finished yet. */
  lastLapTicks: number;
  /**
   * Fastest lap of the current round, in ticks. 0 = none yet.
   *
   * Stored rather than derived: a lap time is history, and history is the one
   * thing a tick number cannot be asked for after the fact.
   */
  bestLapTicks: number;
  /** Standing on the floor or a platform. False while airborne. */
  grounded: boolean;
  /** Jumps spent since last touching a surface (for double jumps). */
  jumps: number;
  /**
   * True while the jump button is held.
   *
   * Jumping triggers on the press *edge*, not on the button being down, or
   * holding it would bunny-hop forever. The simulation cannot see the
   * previous tick's input (it only keeps the latest), so the edge has to be
   * remembered as state — and therefore snapshotted like everything else.
   */
  jumpLatch: boolean;
  /** True for host-simulated bots. Bots never win host election (not peers). */
  isBot: boolean;
  /** Active timed effects: id -> expiry tick. */
  effects: EffectMap;
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

// ---------------------------------------------------------------------------
// World entities
// ---------------------------------------------------------------------------

/** What collecting a pickup does. Weights per kind live in `SimConfig`. */
export type PickupKind = 'score' | 'speed' | 'shield' | 'heal';

export interface PickupState {
  id: number;
  x: number;
  z: number;
  /** Rests on whatever surface is below it, so shards sit on platforms. */
  y: number;
  kind: PickupKind;
  active: boolean;
  /** Tick at which an inactive pickup becomes active again. */
  respawnTick: number;
}

/**
 * Static arena geometry: an axis-aligned box, either seed-generated or listed
 * in `SimConfig.platforms`. Never changes during a round, and never travels on
 * the wire — every peer derives an identical set from the seed and the config.
 *
 * The box spans `[baseY, top]` vertically. Ground-level obstacles start at 0
 * and act as walls; a `baseY` above 0 is a floating platform you can jump onto
 * and walk under. With `platform.enabled` false the vertical span is ignored
 * entirely and every box is a plain wall.
 */
export interface Obstacle {
  id: number;
  x: number;
  z: number;
  halfX: number;
  halfZ: number;
  /** Bottom of the box. 0 sits it on the floor. */
  baseY: number;
  /** Top surface — the height you stand on. */
  top: number;
}

// ---------------------------------------------------------------------------
// Match phases
// ---------------------------------------------------------------------------

/**
 * The match state machine, driven by `systems/phase.ts`:
 *
 * `lobby` (waiting for players, free warm-up) → `countdown` (movement locked,
 * 3-2-1) → `playing` (the round) → `ended` (winner shown) → `countdown` …
 *
 * When `phases.enabled` is false the id is pinned to `playing` and nothing
 * ever transitions — that is the endless-sandbox default.
 */
export type PhaseId = 'lobby' | 'countdown' | 'playing' | 'ended';

export interface PhaseState {
  id: PhaseId;
  /** Tick when the current phase ends; 0 = open-ended. */
  endTick: number;
  /** 1-based round counter. */
  round: number;
  /** Winner of the last finished round: a player id, or '' when none. */
  winnerId: string;
  /** Winning team of the last finished round, or `TEAM_NONE`. */
  winnerTeam: number;
}

export const INITIAL_PHASE: PhaseState = Object.freeze({
  id: 'playing',
  endTick: 0,
  round: 1,
  winnerId: '',
  winnerTeam: TEAM_NONE,
});

// ---------------------------------------------------------------------------
// Ball, projectiles, items, zones
// ---------------------------------------------------------------------------

/** A single pushable ball (soccer-likes). `World.ball` is null when disabled. */
export interface BallState {
  x: number;
  z: number;
  vx: number;
  vz: number;
  /** Player who last kicked it, for goal credit. '' before any touch. */
  lastTouchId: PlayerId;
}

/**
 * One trackside tyre stack, as a body.
 *
 * Identified by index: the roster is fixed at construction, derived from the
 * circuit by `tyreStackSpots()`, so a stack's home never needs to travel —
 * only where the racing has since shoved it. Empty on modes with no track.
 */
export interface TyreStackState {
  x: number;
  z: number;
  vx: number;
  vz: number;
}

export interface ProjectileState {
  id: number;
  ownerId: PlayerId;
  /** Owner's team at fire time, so friendly fire can be filtered cheaply. */
  team: number;
  x: number;
  z: number;
  /** Fixed firing height — shots fly level, so floors don't shoot each other. */
  y: number;
  vx: number;
  vz: number;
  /** Despawns at `bornTick + projectiles.lifetimeTicks`. */
  bornTick: number;
}

/**
 * Runtime state of a carryable item (flag, crown). The static description —
 * kind, home position, owning team — lives in `SimConfig.items[id]`; only the
 * mutable part is here (and therefore in the snapshot).
 */
export interface ItemState {
  /** Index into `SimConfig.items`. */
  id: number;
  x: number;
  z: number;
  /** Height, so a carried item rides its carrier up onto platforms. */
  y: number;
  /** Carrying player, or '' when the item is on the ground. */
  carrierId: PlayerId;
  /** When a dropped item snaps back home; 0 = at home or carried. */
  returnTick: number;
  atHome: boolean;
}

/**
 * Runtime state of a zone. The geometry — kind, centre, radius, owning team —
 * lives in `SimConfig.zones[id]`.
 */
export interface ZoneRuntimeState {
  /** Index into `SimConfig.zones`. */
  id: number;
  /** Team currently holding a hill, or `TEAM_NONE` when neutral/contested. */
  ownerTeam: number;
  /** Sole player holding a FFA hill, or ''. */
  ownerId: PlayerId;
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

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
  phase: PhaseState;
  players: PlayerState[];
  pickups: PickupState[];
  /** Indexed by team; empty in free-for-all modes. */
  teamScores: number[];
  ball: BallState | null;
  projectiles: ProjectileState[];
  items: ItemState[];
  zones: ZoneRuntimeState[];
  tyreStacks: TyreStackState[];
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Emitted by the simulation so presentation layers can react to gameplay.
 *
 * These fire on the peer that steps the authoritative world — the HOST. A
 * client's world only ever applies snapshots, so for player-facing feedback
 * that must appear on every screen, diff successive `RenderState`s instead
 * (see `src/ui/announcer.ts`). Events are still ideal for headless tests and
 * host-side logic.
 */
export type SimEvents = {
  pickupCollected: { playerId: PlayerId; pickupId: number; kind: PickupKind; score: number };
  pickupRespawned: { pickupId: number };
  playerJoined: { playerId: PlayerId };
  playerLeft: { playerId: PlayerId };
  phaseChanged: { phase: PhaseId; round: number };
  playerTagged: { playerId: PlayerId; byId: PlayerId };
  playerKnockedOut: { playerId: PlayerId; byId: PlayerId };
  playerRespawned: { playerId: PlayerId };
  goalScored: { team: number; byId: PlayerId };
  zoneCaptured: { zoneId: number; ownerId: PlayerId; ownerTeam: number };
  lapCompleted: { playerId: PlayerId; lap: number; lapTicks: number; best: boolean };
  drsOpened: { playerId: PlayerId };
  itemTaken: { itemId: number; playerId: PlayerId };
  itemDropped: { itemId: number; playerId: PlayerId };
  itemDelivered: { itemId: number; playerId: PlayerId; score: number };
  projectileFired: { projectileId: number; ownerId: PlayerId };
};
