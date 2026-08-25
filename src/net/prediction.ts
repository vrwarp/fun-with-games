import { clamp, lerp, lerpAngle } from '../shared/math.js';
import { tickDeltaSeconds, type SimConfig } from '../sim/config.js';
import { activeEffects } from '../sim/systems/effects.js';
import { integratePlayer } from '../sim/systems/movement.js';
import { isMovementLocked } from '../sim/systems/phase.js';
import { raceStandings, type RaceStanding } from '../sim/systems/race.js';
import { tyreLife } from '../sim/systems/vehicle.js';
import type { Obstacle, PlayerInput, PlayerState, WorldSnapshot } from '../sim/types.js';
import {
  EMPTY_RENDER_STATE,
  type RenderBall,
  type RenderItem,
  type RenderPhase,
  type RenderPlayer,
  type RenderPickup,
  type RenderProjectile,
  type RenderState,
  type RenderTyreStack,
  type RenderZone,
} from './view.js';

export interface ClientViewOptions {
  selfId: string;
  config: SimConfig;
  obstacles: readonly Obstacle[];
  /**
   * How far in the past remote players are rendered.
   *
   * Must exceed the snapshot interval, or there will be nothing to
   * interpolate towards and remote players will stutter. Roughly two
   * snapshots' worth is the usual choice.
   */
  interpolationDelayMs?: number;
  /** How long a reconciliation correction is blended out over. */
  errorSmoothingMs?: number;
  /** Corrections larger than this snap instead of blending (real teleports). */
  teleportThreshold?: number;
}

interface BufferedSnapshot {
  snapshot: WorldSnapshot;
  receivedAt: number;
}

const DEFAULT_INTERPOLATION_DELAY_MS = 120;
const DEFAULT_ERROR_SMOOTHING_MS = 120;
const DEFAULT_TELEPORT_THRESHOLD = 4;
/** Snapshots older than this are dropped; nothing can interpolate that far back. */
const BUFFER_RETENTION_MS = 1500;

/**
 * The client half of the netcode: prediction, reconciliation, interpolation.
 *
 * Four problems, four answers:
 *
 *  - **Local input must feel instant.** The local player is simulated
 *    immediately rather than waiting a round trip (*prediction*).
 *  - **The host is still right.** When a snapshot lands, the local player is
 *    reset to the authoritative state and every input the host has not yet
 *    acknowledged is replayed on top (*reconciliation*). The leftover
 *    difference is blended out over a few frames so a correction looks like
 *    drift instead of a teleport.
 *  - **Remote players arrive at 15 Hz but render at 60.** They are drawn a
 *    fixed delay in the past and interpolated between the two snapshots
 *    straddling that moment (*entity interpolation*). The ball and
 *    projectiles get the same treatment.
 *  - **The local player advances at 30 Hz but renders at 60.** It is drawn
 *    between the previous simulation step and the current one, using the
 *    caller's sub-tick fraction (*render interpolation*). Without this the
 *    character stutters against smoothly-scrolling scenery.
 *
 * Prediction replays `integratePlayer` with the tick and movement-lock state
 * derived from the latest snapshot, so timed effects (frozen, KO) and phase
 * freezes are respected mid-replay exactly as the host applies them.
 *
 * Runs headlessly: no DOM, no Babylon, no timers. `now` is always passed in,
 * which is what lets the whole thing be tested against a virtual clock.
 */
export class ClientView {
  readonly #selfId: string;
  readonly #config: SimConfig;
  readonly #obstacles: readonly Obstacle[];
  readonly #interpolationDelayMs: number;
  readonly #errorSmoothingMs: number;
  readonly #teleportThreshold: number;
  /**
   * Whether this mode is a race — decided once from the config, because it is
   * a property of the room, not of any given frame.
   */
  readonly #isRace: boolean;

  #buffer: BufferedSnapshot[] = [];
  #predicted: PlayerState | null = null;
  /**
   * Where the local player was one simulation tick ago.
   *
   * The simulation advances in 30 Hz steps but the screen refreshes at 60 Hz
   * or more, so the predicted position is a *step function* as far as the
   * renderer is concerned: it jumps on tick frames and is perfectly still in
   * between. Static scenery glides past continuously while the player stutters
   * against it, which reads as the character vibrating. Keeping the previous
   * step lets `sample()` interpolate across it.
   */
  #predictedPrevious: { x: number; z: number; y: number; heading: number } | null = null;
  #pendingInputs: PlayerInput[] = [];
  /** The tick the next predicted input will simulate. */
  #predictedTick = 0;
  /** Movement lock derived from the latest snapshot's phase. */
  #movementLocked = false;

  /** Residual correction being blended out, in world units. */
  #errorX = 0;
  #errorZ = 0;
  #errorRemainingMs = 0;

  constructor(options: ClientViewOptions) {
    this.#selfId = options.selfId;
    this.#isRace = options.config.zones.some((zone) => zone.kind === 'checkpoint');
    this.#config = options.config;
    this.#obstacles = options.obstacles;
    this.#interpolationDelayMs = options.interpolationDelayMs ?? DEFAULT_INTERPOLATION_DELAY_MS;
    this.#errorSmoothingMs = options.errorSmoothingMs ?? DEFAULT_ERROR_SMOOTHING_MS;
    this.#teleportThreshold = options.teleportThreshold ?? DEFAULT_TELEPORT_THRESHOLD;
  }

  /** The locally predicted local player, or `null` before the first snapshot. */
  get predicted(): Readonly<PlayerState> | null {
    return this.#predicted;
  }

  /** Inputs sent but not yet acknowledged by the host. */
  get pendingInputCount(): number {
    return this.#pendingInputs.length;
  }

  get bufferedSnapshotCount(): number {
    return this.#buffer.length;
  }

  /**
   * Applies an input locally, immediately, and remembers it for replay.
   *
   * Call this on the same tick the input is sent to the host, with the same
   * `PlayerInput` object, or prediction and reconciliation will disagree.
   */
  recordInput(input: PlayerInput): void {
    this.#pendingInputs.push(input);
    if (!this.#predicted) return;
    this.#predictedPrevious = {
      x: this.#predicted.x,
      z: this.#predicted.z,
      y: this.#predicted.y,
      heading: this.#predicted.heading,
    };
    integratePlayer(
      this.#predicted,
      input,
      this.#config,
      this.#obstacles,
      tickDeltaSeconds(this.#config),
      this.#predictedTick,
      this.#movementLocked,
    );
    this.#predictedTick += 1;
  }

  /** Feeds in an authoritative snapshot and reconciles the local player. */
  pushSnapshot(snapshot: WorldSnapshot, receivedAt: number): void {
    const last = this.#buffer[this.#buffer.length - 1];
    // Snapshots can arrive out of order on an unreliable channel. An older one
    // carries no information we do not already have.
    if (last && snapshot.tick <= last.snapshot.tick) return;

    this.#buffer.push({ snapshot, receivedAt });
    this.#pruneBuffer(receivedAt);
    this.#movementLocked = this.#config.phases.enabled && isMovementLocked(snapshot.phase);
    this.#reconcile(snapshot);
  }

  /** Decays the outstanding reconciliation error. Call once per frame. */
  advanceSmoothing(deltaMs: number): void {
    if (this.#errorRemainingMs <= 0) return;
    this.#errorRemainingMs = Math.max(0, this.#errorRemainingMs - deltaMs);
    if (this.#errorRemainingMs === 0) {
      this.#errorX = 0;
      this.#errorZ = 0;
    }
  }

  /**
   * Builds the state to draw at wall-clock time `now`.
   *
   * `tickAlpha` is how far the caller is through the current simulation tick,
   * in `[0, 1]` — the leftover in its fixed-timestep accumulator. It is what
   * lets the local player be drawn between two simulation steps instead of
   * snapping from one to the next. Pass 1 to draw the raw latest step.
   */
  sample(now: number, hostId: string, tickAlpha = 1): RenderState {
    const latest = this.#buffer[this.#buffer.length - 1];
    if (!latest) return EMPTY_RENDER_STATE;

    const renderTime = now - this.#interpolationDelayMs;
    const [from, to, alpha] = this.#findInterpolationPair(renderTime);
    const latestTick = latest.snapshot.tick;

    // Positions and gaps come from the authoritative snapshot rather than the
    // interpolated one: a running order that flickers because two cars were
    // rendered 120 ms apart would be worse than one that is a frame stale.
    const standings = this.#standings(latest.snapshot);

    const players: RenderPlayer[] = [];
    for (const target of to.snapshot.players) {
      if (target.id === this.#selfId && this.#predicted) {
        players.push(
          this.#localPlayer(this.#predicted, latest.snapshot, hostId, tickAlpha, standings),
        );
        continue;
      }

      const previous = from.snapshot.players.find((p) => p.id === target.id);
      players.push({
        id: target.id,
        name: target.name,
        color: target.color,
        x: previous ? lerp(previous.x, target.x, alpha) : target.x,
        z: previous ? lerp(previous.z, target.z, alpha) : target.z,
        y: previous ? lerp(previous.y, target.y, alpha) : target.y,
        heading: previous ? lerpAngle(previous.heading, target.heading, alpha) : target.heading,
        vx: previous ? lerp(previous.vx, target.vx, alpha) : target.vx,
        vz: previous ? lerp(previous.vz, target.vz, alpha) : target.vz,
        grounded: target.grounded,
        score: target.score,
        team: target.team,
        role: target.role,
        hp: target.hp,
        lives: target.lives,
        effects: activeEffects(target, latestTick),
        carrying: this.#carrying(latest.snapshot, target.id),
        checkpoint: target.checkpoint,
        lap: target.lap,
        ...this.#raceView(target, standings, latestTick),
        isBot: target.isBot,
        isLocal: target.id === this.#selfId,
        isHost: target.id === hostId,
      });
    }

    // Pickups blink in and out rather than move, so the newest truth is right.
    const pickups: RenderPickup[] = latest.snapshot.pickups.map((p) => ({
      id: p.id,
      x: p.x,
      z: p.z,
      y: p.y,
      kind: p.kind,
      active: p.active,
    }));

    return {
      tick: latestTick,
      phase: this.#phaseView(latest.snapshot),
      players,
      pickups,
      teamScores: [...latest.snapshot.teamScores],
      ball: this.#ballView(from.snapshot, to.snapshot, alpha),
      projectiles: this.#projectileViews(from.snapshot, to.snapshot, alpha),
      zones: this.#zoneViews(latest.snapshot),
      items: this.#itemViews(latest.snapshot),
      tyreStacks: this.#tyreStackViews(from.snapshot, to.snapshot, alpha),
      maxHp: this.#config.combat.enabled ? this.#config.combat.maxHp : 0,
      totalLaps: this.#isRace ? this.#config.phases.targetScore : 0,
    };
  }

  reset(): void {
    this.#buffer = [];
    this.#predicted = null;
    this.#predictedPrevious = null;
    this.#pendingInputs = [];
    this.#predictedTick = 0;
    this.#movementLocked = false;
    this.#errorX = 0;
    this.#errorZ = 0;
    this.#errorRemainingMs = 0;
  }

  // -------------------------------------------------------------- internals

  #phaseView(snapshot: WorldSnapshot): RenderPhase {
    const phase = snapshot.phase;
    const remainingTicks = phase.endTick > 0 ? Math.max(0, phase.endTick - snapshot.tick) : 0;
    const winner = phase.winnerId
      ? snapshot.players.find((p) => p.id === phase.winnerId)
      : undefined;
    return {
      id: phase.id,
      round: phase.round,
      remainingSeconds: remainingTicks / this.#config.tickRate,
      winnerId: phase.winnerId,
      winnerName: winner?.name ?? '',
      winnerTeam: phase.winnerTeam,
    };
  }

  /**
   * Stacks are index-identified (the roster is fixed by the circuit), so the
   * pairing for interpolation is positional — no id search needed.
   */
  #tyreStackViews(from: WorldSnapshot, to: WorldSnapshot, alpha: number): RenderTyreStack[] {
    return to.tyreStacks.map((stack, id) => {
      const previous = from.tyreStacks[id];
      return {
        id,
        x: previous ? lerp(previous.x, stack.x, alpha) : stack.x,
        z: previous ? lerp(previous.z, stack.z, alpha) : stack.z,
        vx: stack.vx,
        vz: stack.vz,
      };
    });
  }

  #ballView(from: WorldSnapshot, to: WorldSnapshot, alpha: number): RenderBall | null {
    if (!to.ball) return null;
    if (!from.ball) return { x: to.ball.x, z: to.ball.z };
    return {
      x: lerp(from.ball.x, to.ball.x, alpha),
      z: lerp(from.ball.z, to.ball.z, alpha),
    };
  }

  #projectileViews(from: WorldSnapshot, to: WorldSnapshot, alpha: number): RenderProjectile[] {
    return to.projectiles.map((projectile) => {
      const previous = from.projectiles.find((p) => p.id === projectile.id);
      return {
        id: projectile.id,
        ownerId: projectile.ownerId,
        x: previous ? lerp(previous.x, projectile.x, alpha) : projectile.x,
        z: previous ? lerp(previous.z, projectile.z, alpha) : projectile.z,
        y: projectile.y,
      };
    });
  }

  #zoneViews(snapshot: WorldSnapshot): RenderZone[] {
    return this.#config.zones.map((spec, id) => {
      const runtime = snapshot.zones.find((zone) => zone.id === id);
      return {
        id,
        kind: spec.kind,
        x: spec.x,
        z: spec.z,
        radius: spec.radius,
        team: spec.team,
        order: spec.order,
        ownerTeam: runtime?.ownerTeam ?? -1,
        ownerId: runtime?.ownerId ?? '',
      };
    });
  }

  #itemViews(snapshot: WorldSnapshot): RenderItem[] {
    return snapshot.items.map((item) => {
      const spec = this.#config.items[item.id];
      return {
        id: item.id,
        kind: spec?.kind ?? 'crown',
        x: item.x,
        z: item.z,
        y: item.y,
        carrierId: item.carrierId,
        team: spec?.team ?? -1,
        atHome: item.atHome,
      };
    });
  }

  #carrying(snapshot: WorldSnapshot, playerId: string): '' | 'flag' | 'crown' {
    const item = snapshot.items.find((entry) => entry.carrierId === playerId);
    if (!item) return '';
    return this.#config.items[item.id]?.kind ?? '';
  }

  #localPlayer(
    predicted: PlayerState,
    latest: WorldSnapshot,
    hostId: string,
    tickAlpha: number,
    standings: readonly RaceStanding[],
  ): RenderPlayer {
    const blend = this.#errorRemainingMs > 0 ? this.#errorRemainingMs / this.#errorSmoothingMs : 0;

    // Draw between the previous simulation step and the current one. This
    // costs up to one tick (~33 ms) of visual latency and buys continuous
    // motion; the alternative is a character that visibly stutters against
    // smoothly-scrolling scenery on any display faster than the tick rate.
    const previous = this.#predictedPrevious;
    const t = previous ? clamp(tickAlpha, 0, 1) : 1;
    const x = previous ? lerp(previous.x, predicted.x, t) : predicted.x;
    const z = previous ? lerp(previous.z, predicted.z, t) : predicted.z;
    const y = previous ? lerp(previous.y, predicted.y, t) : predicted.y;
    const heading = previous
      ? lerpAngle(previous.heading, predicted.heading, t)
      : predicted.heading;

    return {
      id: predicted.id,
      name: predicted.name,
      color: predicted.color,
      x: x + this.#errorX * blend,
      z: z + this.#errorZ * blend,
      y,
      heading,
      // Straight from the prediction rather than interpolated: this is the
      // local car, and its own engine note should answer the throttle on the
      // frame the player presses it, not a tick later.
      vx: predicted.vx,
      vz: predicted.vz,
      grounded: predicted.grounded,
      score: predicted.score,
      team: predicted.team,
      role: predicted.role,
      hp: predicted.hp,
      lives: predicted.lives,
      effects: activeEffects(predicted, latest.tick),
      carrying: this.#carrying(latest, predicted.id),
      checkpoint: predicted.checkpoint,
      lap: predicted.lap,
      ...this.#raceView(predicted, standings, latest.tick),
      isBot: false,
      isLocal: true,
      isHost: predicted.id === hostId,
    };
  }

  /**
   * The running order, or nothing at all outside a race.
   *
   * Sorting a field costs nothing at this size, but `raceStandings` is only
   * meaningful where there are gates to be ranked by, and a "P1" badge in a
   * game of tag would be noise.
   */
  #standings(snapshot: WorldSnapshot): readonly RaceStanding[] {
    if (!this.#isRace) return [];
    return raceStandings(this.#config, snapshot.players);
  }

  /** One player's race numbers, in the seconds the HUD wants to print. */
  #raceView(
    player: PlayerState,
    standings: readonly RaceStanding[],
    tick: number,
  ): Pick<RenderPlayer, 'position' | 'interval' | 'lapTime' | 'lastLap' | 'bestLap' | 'tyres'> {
    const seconds = (ticks: number): number => ticks / this.#config.tickRate;
    const standing = standings.find((entry) => entry.id === player.id);
    // Before the first crossing there is no lap under way, and counting from
    // tick 0 would show a driver on the grid a lap time they never set.
    const running = player.lapStartTick > 0 ? Math.max(0, tick - player.lapStartTick) : 0;

    return {
      position: standing?.position ?? 0,
      interval: standing?.interval ?? 0,
      lapTime: seconds(running),
      lastLap: seconds(player.lastLapTicks),
      bestLap: seconds(player.bestLapTicks),
      tyres: tyreLife(player, this.#config, tick),
    };
  }

  #reconcile(snapshot: WorldSnapshot): void {
    const authoritative = snapshot.players.find((p) => p.id === this.#selfId);
    if (!authoritative) {
      // The host does not know about us yet (or dropped us). Nothing to
      // predict from; wait for a snapshot that includes us.
      this.#predicted = null;
      this.#predictedPrevious = null;
      this.#pendingInputs = [];
      return;
    }

    const previousX = this.#predicted?.x ?? authoritative.x;
    const previousZ = this.#predicted?.z ?? authoritative.z;

    const rebuilt: PlayerState = {
      ...authoritative,
      input: { ...authoritative.input },
      effects: { ...authoritative.effects },
    };
    this.#pendingInputs = this.#pendingInputs.filter(
      (input) => input.seq > authoritative.lastInputSeq,
    );

    const dt = tickDeltaSeconds(this.#config);
    let replayTick = snapshot.tick;
    for (const input of this.#pendingInputs) {
      integratePlayer(
        rebuilt,
        input,
        this.#config,
        this.#obstacles,
        dt,
        replayTick,
        this.#movementLocked,
      );
      replayTick += 1;
    }
    this.#predicted = rebuilt;
    this.#predictedTick = replayTick;

    // `#predictedPrevious` is deliberately left alone here. Reconciling does
    // not advance time — it re-derives the *same* tick from authoritative
    // state — so the previous step is still the previous step. Re-anchoring it
    // to `rebuilt` would collapse the interpolation span to zero and make the
    // player jump on every snapshot, which at a 2-tick snapshot interval is
    // most of them. Small corrections are handled by the error smoothing
    // below; large ones are handled by the snap branch.
    const errorX = previousX - rebuilt.x;
    const errorZ = previousZ - rebuilt.z;
    const errorMagnitude = Math.hypot(errorX, errorZ);

    if (errorMagnitude > this.#teleportThreshold) {
      // A correction this large is not misprediction — it is a respawn, a
      // host migration, or a genuine teleport. Snapping is the honest render,
      // so collapse the interpolation span too: sliding across the arena over
      // a tick would look like a glitch rather than a teleport.
      this.#predictedPrevious = {
        x: rebuilt.x,
        z: rebuilt.z,
        y: rebuilt.y,
        heading: rebuilt.heading,
      };
      this.#errorX = 0;
      this.#errorZ = 0;
      this.#errorRemainingMs = 0;
      return;
    }

    this.#errorX = errorX;
    this.#errorZ = errorZ;
    this.#errorRemainingMs = this.#errorSmoothingMs;
  }

  /**
   * Picks the two snapshots straddling `renderTime`.
   *
   * Falls back to the newest snapshot at both ends: before the buffer fills,
   * and when the network stalls and render time runs past the last snapshot
   * received. Extrapolating instead would be more responsive and much more
   * likely to be wrong — a stalled remote player is better than a wrong one.
   */
  #findInterpolationPair(renderTime: number): [BufferedSnapshot, BufferedSnapshot, number] {
    const newest = this.#buffer[this.#buffer.length - 1];
    if (!newest) throw new Error('ClientView: interpolation requested with an empty buffer');

    if (this.#buffer.length === 1 || renderTime >= newest.receivedAt) {
      return [newest, newest, 1];
    }

    for (let i = this.#buffer.length - 1; i > 0; i--) {
      const to = this.#buffer[i];
      const from = this.#buffer[i - 1];
      if (!to || !from) continue;
      if (from.receivedAt <= renderTime && renderTime <= to.receivedAt) {
        const span = to.receivedAt - from.receivedAt;
        const alpha = span > 0 ? (renderTime - from.receivedAt) / span : 1;
        return [from, to, alpha];
      }
    }

    // Render time predates everything buffered: show the oldest we have.
    const oldest = this.#buffer[0];
    if (!oldest) throw new Error('ClientView: interpolation requested with an empty buffer');
    return [oldest, oldest, 1];
  }

  #pruneBuffer(now: number): void {
    const cutoff = now - BUFFER_RETENTION_MS;
    // Always keep the last two so interpolation has something to work with.
    while (this.#buffer.length > 2) {
      const oldest = this.#buffer[0];
      if (!oldest || oldest.receivedAt >= cutoff) break;
      this.#buffer.shift();
    }
  }
}
