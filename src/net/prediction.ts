import { clamp, lerp, lerpAngle } from '../shared/math.js';
import { tickDeltaSeconds, type SimConfig } from '../sim/config.js';
import { integratePlayer } from '../sim/systems/movement.js';
import type { Obstacle, PlayerInput, PlayerState, WorldSnapshot } from '../sim/types.js';
import type { RenderPickup, RenderPlayer, RenderState } from './view.js';

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
 *    straddling that moment (*entity interpolation*).
 *  - **The local player advances at 30 Hz but renders at 60.** It is drawn
 *    between the previous simulation step and the current one, using the
 *    caller's sub-tick fraction (*render interpolation*). Without this the
 *    character stutters against smoothly-scrolling scenery.
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
  #predictedPrevious: { x: number; z: number; heading: number } | null = null;
  #pendingInputs: PlayerInput[] = [];

  /** Residual correction being blended out, in world units. */
  #errorX = 0;
  #errorZ = 0;
  #errorRemainingMs = 0;

  constructor(options: ClientViewOptions) {
    this.#selfId = options.selfId;
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
      heading: this.#predicted.heading,
    };
    integratePlayer(
      this.#predicted,
      input,
      this.#config,
      this.#obstacles,
      tickDeltaSeconds(this.#config),
    );
  }

  /** Feeds in an authoritative snapshot and reconciles the local player. */
  pushSnapshot(snapshot: WorldSnapshot, receivedAt: number): void {
    const last = this.#buffer[this.#buffer.length - 1];
    // Snapshots can arrive out of order on an unreliable channel. An older one
    // carries no information we do not already have.
    if (last && snapshot.tick <= last.snapshot.tick) return;

    this.#buffer.push({ snapshot, receivedAt });
    this.#pruneBuffer(receivedAt);
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
    if (!latest) return { tick: 0, players: [], pickups: [] };

    const renderTime = now - this.#interpolationDelayMs;
    const [from, to, alpha] = this.#findInterpolationPair(renderTime);

    const players: RenderPlayer[] = [];
    for (const target of to.snapshot.players) {
      if (target.id === this.#selfId && this.#predicted) {
        players.push(this.#localPlayer(this.#predicted, hostId, tickAlpha));
        continue;
      }

      const previous = from.snapshot.players.find((p) => p.id === target.id);
      players.push({
        id: target.id,
        name: target.name,
        color: target.color,
        x: previous ? lerp(previous.x, target.x, alpha) : target.x,
        z: previous ? lerp(previous.z, target.z, alpha) : target.z,
        heading: previous ? lerpAngle(previous.heading, target.heading, alpha) : target.heading,
        score: target.score,
        isLocal: target.id === this.#selfId,
        isHost: target.id === hostId,
      });
    }

    // Pickups blink in and out rather than move, so the newest truth is right.
    const pickups: RenderPickup[] = latest.snapshot.pickups.map((p) => ({
      id: p.id,
      x: p.x,
      z: p.z,
      active: p.active,
    }));

    return { tick: latest.snapshot.tick, players, pickups };
  }

  reset(): void {
    this.#buffer = [];
    this.#predicted = null;
    this.#predictedPrevious = null;
    this.#pendingInputs = [];
    this.#errorX = 0;
    this.#errorZ = 0;
    this.#errorRemainingMs = 0;
  }

  // -------------------------------------------------------------- internals

  #localPlayer(predicted: PlayerState, hostId: string, tickAlpha: number): RenderPlayer {
    const blend = this.#errorRemainingMs > 0 ? this.#errorRemainingMs / this.#errorSmoothingMs : 0;

    // Draw between the previous simulation step and the current one. This
    // costs up to one tick (~33 ms) of visual latency and buys continuous
    // motion; the alternative is a character that visibly stutters against
    // smoothly-scrolling scenery on any display faster than the tick rate.
    const previous = this.#predictedPrevious;
    const t = previous ? clamp(tickAlpha, 0, 1) : 1;
    const x = previous ? lerp(previous.x, predicted.x, t) : predicted.x;
    const z = previous ? lerp(previous.z, predicted.z, t) : predicted.z;
    const heading = previous
      ? lerpAngle(previous.heading, predicted.heading, t)
      : predicted.heading;

    return {
      id: predicted.id,
      name: predicted.name,
      color: predicted.color,
      x: x + this.#errorX * blend,
      z: z + this.#errorZ * blend,
      heading,
      score: predicted.score,
      isLocal: true,
      isHost: predicted.id === hostId,
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

    const rebuilt: PlayerState = { ...authoritative };
    this.#pendingInputs = this.#pendingInputs.filter(
      (input) => input.seq > authoritative.lastInputSeq,
    );

    const dt = tickDeltaSeconds(this.#config);
    for (const input of this.#pendingInputs) {
      integratePlayer(rebuilt, input, this.#config, this.#obstacles, dt);
    }
    this.#predicted = rebuilt;

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
      this.#predictedPrevious = { x: rebuilt.x, z: rebuilt.z, heading: rebuilt.heading };
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
