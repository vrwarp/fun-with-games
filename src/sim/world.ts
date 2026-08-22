import { Emitter } from '../shared/emitter.js';
import { quantize } from '../shared/math.js';
import { DEFAULT_SIM_CONFIG, tickDeltaSeconds, type SimConfig } from './config.js';
import { Rng } from './rng.js';
import type { SimEventRecord, StepContext } from './step.js';
import { generateObstacles, spawnHeading, spawnPosition } from './systems/arena.js';
import { computeBotInput } from './systems/bots.js';
import { updateCombat } from './systems/combat.js';
import { pruneEffects } from './systems/effects.js';
import { integratePlayer, resolvePlayerCollisions } from './systems/movement.js';
import { isMovementLocked, updatePhase } from './systems/phase.js';
import { createPickups, updatePickups } from './systems/pickups.js';
import { updateProjectiles } from './systems/projectiles.js';
import { updateBall } from './systems/ball.js';
import { updateItems } from './systems/items.js';
import { updateTag } from './systems/tag.js';
import { updateRace } from './systems/race.js';
import { updateZones } from './systems/zones.js';
import {
  EMPTY_INPUT,
  INITIAL_PHASE,
  ROLE_NONE,
  TEAM_NONE,
  type BallState,
  type ItemState,
  type Obstacle,
  type PhaseState,
  type PickupState,
  type PlayerId,
  type PlayerInput,
  type PlayerProfile,
  type PlayerState,
  type ProjectileState,
  type SimEvents,
  type WorldSnapshot,
  type ZoneRuntimeState,
} from './types.js';

export interface WorldOptions {
  seed: number;
  config?: SimConfig;
}

export interface AddPlayerOptions {
  isBot?: boolean;
}

/** Names/colours cycled through for host-added bots. */
const BOT_PALETTE = ['#f4a261', '#2a9d8f', '#e76f51', '#8ecae6', '#c77dff', '#ffd166'];

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
  #phase: PhaseState;
  #teamScores: number[];
  #ball: BallState | null;
  #projectiles: ProjectileState[] = [];
  #items: ItemState[];
  #zones: ZoneRuntimeState[];
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

    this.#phase = {
      ...INITIAL_PHASE,
      id: this.config.phases.enabled ? 'lobby' : 'playing',
    };
    this.#teamScores = new Array<number>(Math.max(0, this.config.teams.count)).fill(0);
    this.#ball = this.config.ball.enabled ? { x: 0, z: 0, vx: 0, vz: 0, lastTouchId: '' } : null;
    this.#items = this.config.items.map((spec, id) => ({
      id,
      x: spec.homeX,
      z: spec.homeZ,
      y: 0,
      carrierId: '',
      returnTick: 0,
      atHome: true,
    }));
    this.#zones = this.config.zones.map((_, id) => ({
      id,
      ownerTeam: TEAM_NONE,
      ownerId: '',
    }));
  }

  // ---------------------------------------------------------------- players

  addPlayer(id: PlayerId, profile: PlayerProfile, options: AddPlayerOptions = {}): PlayerState {
    const existing = this.#players.get(id);
    if (existing) {
      existing.name = profile.name;
      existing.color = profile.color;
      return existing;
    }

    const slot = this.#spawnCounter++;
    const spawn = spawnPosition(this.config, slot);
    const player: PlayerState = {
      id,
      name: profile.name,
      color: profile.color,
      x: spawn.x,
      z: spawn.z,
      y: 0,
      vx: 0,
      vz: 0,
      vy: 0,
      heading: spawnHeading(this.config, slot),
      score: 0,
      team: this.#assignTeam(),
      role: ROLE_NONE,
      hp: this.config.combat.maxHp,
      lives: this.config.combat.lives,
      checkpoint: 0,
      lap: 0,
      lapStartTick: 0,
      lastLapTicks: 0,
      bestLapTicks: 0,
      grounded: true,
      jumps: 0,
      jumpLatch: false,
      isBot: options.isBot ?? false,
      effects: {},
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

  /**
   * Adds one host-simulated bot; returns it, or null at `bots.maxCount`.
   *
   * Bot ids start with `zz-bot-` so they sort after every real peer id and
   * can never be mistaken for one; they are world entities, not peers, so
   * host election ignores them entirely.
   */
  addBot(): PlayerState | null {
    const existing = this.bots().length;
    if (existing >= this.config.bots.maxCount) return null;

    let index = 1;
    while (this.#players.has(`zz-bot-${index}`)) index++;

    const color = BOT_PALETTE[(index - 1) % BOT_PALETTE.length] ?? '#9aa0a6';
    return this.addPlayer(`zz-bot-${index}`, { name: `Bot ${index}`, color }, { isBot: true });
  }

  /** Removes the highest-numbered bot; returns false when none remain. */
  removeBot(): boolean {
    const bots = this.bots();
    const last = bots[bots.length - 1];
    return last ? this.removePlayer(last.id) : false;
  }

  bots(): PlayerState[] {
    return this.players().filter((player) => player.isBot);
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

  get phase(): Readonly<PhaseState> {
    return this.#phase;
  }

  get teamScores(): readonly number[] {
    return this.#teamScores;
  }

  get ball(): Readonly<BallState> | null {
    return this.#ball;
  }

  projectiles(): readonly ProjectileState[] {
    return this.#projectiles;
  }

  items(): readonly ItemState[] {
    return this.#items;
  }

  zones(): readonly ZoneRuntimeState[] {
    return this.#zones;
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

  /**
   * Advances the world by exactly one fixed tick.
   *
   * The pipeline order below is deliberate and load-bearing — phases first
   * (they may reset the round), inputs and movement next, then interactions,
   * then scoring. Do NOT reorder casually and do NOT convert this to a
   * registry: determinism requires a fixed, known execution order.
   */
  step(): void {
    const dt = tickDeltaSeconds(this.config);
    const players = this.players();

    const ctx: StepContext = {
      config: this.config,
      tick: this.tick,
      rng: this.#rng,
      obstacles: this.obstacles,
      players,
      pickups: this.#pickups,
      phase: this.#phase,
      teamScores: this.#teamScores,
      ball: this.#ball,
      projectiles: this.#projectiles,
      items: this.#items,
      zones: this.#zones,
      out: [],
    };

    // 1. Match flow: lobby/countdown/playing/ended, round resets, winners.
    updatePhase(ctx);
    const locked = isMovementLocked(this.#phase);

    // 2. Bots decide their inputs from the current state.
    for (const player of players) {
      if (player.isBot) player.input = computeBotInput(ctx, player);
    }

    // 3. Movement.
    for (const player of players) {
      integratePlayer(player, player.input, this.config, this.obstacles, dt, this.tick, locked);
    }
    resolvePlayerCollisions(players, this.config);

    // 4. Interactions, in fixed order.
    updateCombat(ctx); //     respawns KO'd players whose timer expired
    updateTag(ctx); //        role transfer on contact + survivor scoring
    updateProjectiles(ctx); // fire, fly, hit (may reassign ctx.projectiles)
    this.#projectiles = ctx.projectiles;
    updateBall(ctx); //       kicks, bounces, goals
    updateItems(ctx); //      flags and crowns: take, steal, drop, deliver
    updateZones(ctx); //      hill ownership + scoring, race checkpoints
    updateRace(ctx); //       tyres, the slipstream and DRS (laps are current)
    updatePickups(ctx); //    collection, payloads, respawns

    // 5. Housekeeping.
    pruneEffects(players, this.tick);

    this.tick++;
    this.#emitAll(ctx.out);
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
   * host and clients. If you add a field to any entity state — or a whole new
   * collection — add it here, in `applySnapshot`, in `checksum`, and to the
   * wire codec in `src/net/protocol.ts`.
   * `tests/unit/sim/world.snapshot.test.ts` asserts round-trip fidelity and
   * will fail if you forget.
   */
  snapshot(): WorldSnapshot {
    return {
      tick: this.tick,
      rngState: this.#rng.state,
      phase: { ...this.#phase },
      players: this.players().map((p) => ({
        ...p,
        input: { ...p.input },
        effects: { ...p.effects },
      })),
      pickups: this.#pickups.map((p) => ({ ...p })),
      teamScores: [...this.#teamScores],
      ball: this.#ball ? { ...this.#ball } : null,
      projectiles: this.#projectiles.map((p) => ({ ...p })),
      items: this.#items.map((i) => ({ ...i })),
      zones: this.#zones.map((z) => ({ ...z })),
    };
  }

  /** Overwrites all mutable state with an authoritative snapshot. */
  applySnapshot(snapshot: WorldSnapshot): void {
    this.tick = snapshot.tick;
    this.#rng.state = snapshot.rngState;
    this.#phase = { ...snapshot.phase };

    const seen = new Set<PlayerId>();
    for (const incoming of snapshot.players) {
      seen.add(incoming.id);
      const existing = this.#players.get(incoming.id);
      if (existing) {
        Object.assign(existing, incoming, {
          input: { ...incoming.input },
          effects: { ...incoming.effects },
        });
      } else {
        this.#players.set(incoming.id, {
          ...incoming,
          input: { ...incoming.input },
          effects: { ...incoming.effects },
        });
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
    this.#teamScores = [...snapshot.teamScores];
    this.#ball = snapshot.ball ? { ...snapshot.ball } : null;
    this.#projectiles = snapshot.projectiles.map((p) => ({ ...p }));
    this.#items = snapshot.items.map((i) => ({ ...i }));
    this.#zones = snapshot.zones.map((z) => ({ ...z }));
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

    mixString(this.#phase.id);
    mix(this.#phase.endTick);
    mix(this.#phase.round);
    mixString(this.#phase.winnerId);
    mix(this.#phase.winnerTeam);

    for (const player of this.players()) {
      mixString(player.id);
      mixFloat(player.x);
      mixFloat(player.z);
      mixFloat(player.y);
      mixFloat(player.vx);
      mixFloat(player.vz);
      mixFloat(player.vy);
      mix(player.grounded ? 1 : 0);
      mix(player.jumps);
      mix(player.jumpLatch ? 1 : 0);
      mix(player.score);
      mix(player.team);
      mix(player.role);
      mix(player.hp);
      mix(player.lives);
      mix(player.checkpoint);
      mix(player.lap);
      mix(player.lapStartTick);
      mix(player.lastLapTicks);
      mix(player.bestLapTicks);
      mix(player.isBot ? 1 : 0);
      for (const id of Object.keys(player.effects).sort()) {
        mixString(id);
        mix(player.effects[id] ?? 0);
      }
      mix(player.lastInputSeq);
      mixFloat(player.input.moveX);
      mixFloat(player.input.moveZ);
      mix(player.input.sprint ? 1 : 0);
      mix(player.input.buttons);
    }

    for (const pickup of this.#pickups) {
      mix(pickup.id);
      mixFloat(pickup.x);
      mixFloat(pickup.z);
      mixFloat(pickup.y);
      mixString(pickup.kind);
      mix(pickup.active ? 1 : 0);
      mix(pickup.respawnTick);
    }

    for (const score of this.#teamScores) mix(score);

    if (this.#ball) {
      mixFloat(this.#ball.x);
      mixFloat(this.#ball.z);
      mixFloat(this.#ball.vx);
      mixFloat(this.#ball.vz);
      mixString(this.#ball.lastTouchId);
    }

    for (const projectile of this.#projectiles) {
      mix(projectile.id);
      mixString(projectile.ownerId);
      mix(projectile.team);
      mixFloat(projectile.x);
      mixFloat(projectile.z);
      mixFloat(projectile.y);
      mixFloat(projectile.vx);
      mixFloat(projectile.vz);
      mix(projectile.bornTick);
    }

    for (const item of this.#items) {
      mix(item.id);
      mixFloat(item.x);
      mixFloat(item.z);
      mixFloat(item.y);
      mixString(item.carrierId);
      mix(item.returnTick);
      mix(item.atHome ? 1 : 0);
    }

    for (const zone of this.#zones) {
      mix(zone.id);
      mix(zone.ownerTeam);
      mixString(zone.ownerId);
    }

    return hash >>> 0;
  }

  // -------------------------------------------------------------- internals

  /** Joiners go to the currently smallest team, ties to the lowest index. */
  #assignTeam(): number {
    const teamCount = this.config.teams.count;
    if (teamCount < 2) return TEAM_NONE;

    const sizes = new Array<number>(teamCount).fill(0);
    for (const player of this.#players.values()) {
      if (player.team >= 0 && player.team < teamCount) {
        sizes[player.team] = (sizes[player.team] ?? 0) + 1;
      }
    }

    let best = 0;
    for (let team = 1; team < teamCount; team++) {
      if ((sizes[team] ?? 0) < (sizes[best] ?? 0)) best = team;
    }
    return best;
  }

  #emitAll(out: readonly SimEventRecord[]): void {
    for (const record of out) {
      const { type, ...payload } = record;
      // The discriminated union guarantees the payload matches its type; TS
      // cannot correlate the two across a union, hence the cast.
      this.events.emit(type, payload);
    }
  }

  #reindex(): void {
    this.#sortedIds = [...this.#players.keys()].sort();
  }
}
