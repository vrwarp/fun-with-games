import { Emitter } from '../shared/emitter.js';
import { quantize } from '../shared/math.js';
import { DEFAULT_SIM_CONFIG, tickDeltaSeconds, type SimConfig } from './config.js';
import { Rng } from './rng.js';
import { generateObstacles, spawnPosition } from './systems/arena.js';
import { integratePlayer, resolvePlayerCollisions } from './systems/movement.js';
import { createPickups, updatePickups } from './systems/pickups.js';
import {
  EMPTY_INPUT,
  type Obstacle,
  type PickupState,
  type PlayerId,
  type PlayerInput,
  type PlayerProfile,
  type PlayerState,
  type SimEvents,
  type WorldSnapshot,
} from './types.js';

export interface WorldOptions {
  seed: number;
  config?: SimConfig;
}

/**
 * The authoritative game state and the rules that advance it.
 *
 * `World` is deliberately free of Babylon, the DOM, timers and sockets. It is
 * a function of (seed, config, inputs) and nothing else, which buys three
 * things that a starter kit lives or dies by:
 *
 *  - full multiplayer sessions can be tested in Node, in milliseconds;
 *  - a desync can be reproduced from a seed and an input log;
 *  - the renderer can be swapped or rewritten without touching gameplay.
 *
 * Advance it only through `step()`, and only at a fixed timestep.
 */
export class World {
  readonly config: SimConfig;
  readonly seed: number;
  readonly obstacles: readonly Obstacle[];
  readonly events = new Emitter<SimEvents>();

  tick = 0;

  #rng: Rng;
  #players = new Map<PlayerId, PlayerState>();
  #pickups: PickupState[];
  /** Player ids in sorted order — the canonical iteration order. */
  #sortedIds: PlayerId[] = [];
  #spawnCounter = 0;

  constructor(options: WorldOptions) {
    this.config = options.config ?? DEFAULT_SIM_CONFIG;
    this.seed = options.seed >>> 0;
    this.#rng = new Rng(this.seed);

    // Order matters: obstacles then pickups. Both draw from the same RNG
    // stream, so swapping these two lines changes every arena ever generated.
    this.obstacles = generateObstacles(this.config, this.#rng);
    this.#pickups = createPickups(this.config, this.#rng, this.obstacles);
  }

  // ---------------------------------------------------------------- players

  addPlayer(id: PlayerId, profile: PlayerProfile): PlayerState {
    const existing = this.#players.get(id);
    if (existing) {
      existing.name = profile.name;
      existing.color = profile.color;
      return existing;
    }

    const spawn = spawnPosition(this.config, this.#spawnCounter++);
    const player: PlayerState = {
      id,
      name: profile.name,
      color: profile.color,
      x: spawn.x,
      z: spawn.z,
      vx: 0,
      vz: 0,
      heading: 0,
      score: 0,
      lastInputSeq: 0,
      input: EMPTY_INPUT,
    };

    this.#players.set(id, player);
    this.#reindex();
    this.events.emit('playerJoined', { playerId: id });
    return player;
  }

  removePlayer(id: PlayerId): boolean {
    if (!this.#players.delete(id)) return false;
    this.#reindex();
    this.events.emit('playerLeft', { playerId: id });
    return true;
  }

  hasPlayer(id: PlayerId): boolean {
    return this.#players.has(id);
  }

  getPlayer(id: PlayerId): PlayerState | undefined {
    return this.#players.get(id);
  }

  /** Players in canonical (sorted-by-id) order. Live references, not copies. */
  players(): PlayerState[] {
    const list: PlayerState[] = [];
    for (const id of this.#sortedIds) {
      const player = this.#players.get(id);
      if (player) list.push(player);
    }
    return list;
  }

  pickups(): readonly PickupState[] {
    return this.#pickups;
  }

  get playerCount(): number {
    return this.#players.size;
  }

  // ----------------------------------------------------------------- inputs

  /**
   * Queues a player's intent for the next `step()`.
   *
   * Only the newest input survives: over an unreliable channel a burst can
   * arrive out of order, and acting on a stale one would rubber-band the
   * player backwards.
   */
  setInput(id: PlayerId, input: PlayerInput): void {
    const player = this.#players.get(id);
    if (!player) return;
    if (player.input.seq > input.seq) return;
    player.input = input;
  }

  // ------------------------------------------------------------------- step

  /** Advances the world by exactly one fixed tick. */
  step(): void {
    const dt = tickDeltaSeconds(this.config);
    const players = this.players();

    for (const player of players) {
      integratePlayer(player, player.input, this.config, this.obstacles, dt);
    }

    resolvePlayerCollisions(players, this.config);

    const { collected, respawned } = updatePickups(
      this.#pickups,
      players,
      this.config,
      this.#rng,
      this.obstacles,
      this.tick,
    );

    this.tick++;

    for (const { playerId, pickupId } of collected) {
      const score = this.#players.get(playerId)?.score ?? 0;
      this.events.emit('pickupCollected', { playerId, pickupId, score });
    }
    for (const pickupId of respawned) {
      this.events.emit('pickupRespawned', { pickupId });
    }
  }

  /** Convenience for tests and catch-up: runs `count` sequential ticks. */
  stepMany(count: number): void {
    for (let i = 0; i < count; i++) this.step();
  }

  // -------------------------------------------------------------- snapshots

  /**
   * Deep, exact copy of all mutable state.
   *
   * Anything mutable that is NOT captured here will silently diverge between
   * host and clients. If you add a field to `PlayerState` or `PickupState`,
   * add it to `WorldSnapshot` too — `tests/unit/sim/world.snapshot.test.ts`
   * asserts round-trip fidelity and will fail if you forget.
   */
  snapshot(): WorldSnapshot {
    return {
      tick: this.tick,
      rngState: this.#rng.state,
      players: this.players().map((p) => ({ ...p, input: { ...p.input } })),
      pickups: this.#pickups.map((p) => ({ ...p })),
    };
  }

  /** Overwrites all mutable state with an authoritative snapshot. */
  applySnapshot(snapshot: WorldSnapshot): void {
    this.tick = snapshot.tick;
    this.#rng.state = snapshot.rngState;

    const seen = new Set<PlayerId>();
    for (const incoming of snapshot.players) {
      seen.add(incoming.id);
      const existing = this.#players.get(incoming.id);
      if (existing) {
        Object.assign(existing, incoming, { input: { ...incoming.input } });
      } else {
        this.#players.set(incoming.id, { ...incoming, input: { ...incoming.input } });
        this.events.emit('playerJoined', { playerId: incoming.id });
      }
    }

    for (const id of [...this.#players.keys()]) {
      if (!seen.has(id)) {
        this.#players.delete(id);
        this.events.emit('playerLeft', { playerId: id });
      }
    }

    this.#pickups = snapshot.pickups.map((p) => ({ ...p }));
    this.#reindex();
  }

  /**
   * Order-independent fingerprint of the world state.
   *
   * Two worlds fed the same seed and the same inputs must agree here. Tests
   * use it to catch determinism regressions in one assertion instead of
   * comparing every field of every entity.
   */
  checksum(): number {
    let hash = 0x811c9dc5;
    const mix = (value: number): void => {
      hash ^= value | 0;
      hash = Math.imul(hash, 0x01000193);
    };
    const mixFloat = (value: number): void => mix(Math.round(quantize(value, 4) * 10000));
    const mixString = (value: string): void => {
      for (let i = 0; i < value.length; i++) mix(value.charCodeAt(i));
    };

    mix(this.tick);
    mix(this.#rng.state);

    for (const player of this.players()) {
      mixString(player.id);
      mixFloat(player.x);
      mixFloat(player.z);
      mixFloat(player.vx);
      mixFloat(player.vz);
      mix(player.score);
      mix(player.lastInputSeq);
      mixFloat(player.input.moveX);
      mixFloat(player.input.moveZ);
      mix(player.input.sprint ? 1 : 0);
    }

    for (const pickup of this.#pickups) {
      mix(pickup.id);
      mixFloat(pickup.x);
      mixFloat(pickup.z);
      mix(pickup.active ? 1 : 0);
      mix(pickup.respawnTick);
    }

    return hash >>> 0;
  }

  #reindex(): void {
    this.#sortedIds = [...this.#players.keys()].sort();
  }
}
