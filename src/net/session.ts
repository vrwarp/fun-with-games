import { Emitter, type Unsubscribe } from '../shared/emitter.js';
import { createLogger } from '../shared/logger.js';
import { quantize } from '../shared/math.js';
import { DEFAULT_SIM_CONFIG, type SimConfig } from '../sim/config.js';
import type { PlayerId, PlayerInput, PlayerProfile } from '../sim/types.js';
import { World } from '../sim/world.js';
import { ClientView } from './prediction.js';
import {
  decodeMessage,
  encodeSnapshot,
  PROTOCOL_VERSION,
  type InputMessage,
  type NetMessage,
  type SnapshotMessage,
} from './protocol.js';
import { electHost, type Transport } from './transport.js';
import { EMPTY_RENDER_STATE, type RenderState } from './view.js';

const log = createLogger('net:session');

/**
 * Ceiling on how much real time a single frame may hand the simulation.
 *
 * Two very different stalls arrive at `update`. A backgrounded tab stops
 * calling it for minutes, and replaying all of that on return would freeze
 * the page — so there must be a ceiling. But a struggling renderer — a
 * software rasteriser, a phone throttled to single-digit frame rates —
 * stalls for hundreds of milliseconds on EVERY frame, and a ceiling below
 * its frame time quietly slows the whole game down: ticks are what game
 * time IS, so capping them is not dropping frames, it is bending the clock.
 * One second sits comfortably above any frame a machine still playably
 * renders, while capping an hour in the background to one second of
 * catch-up. The catch-up itself is cheap — stepping the sim costs a few
 * hundred microseconds a tick, and catch-up ticks do not render.
 */
const MAX_FRAME_DELTA_MS = 1000;

const DEFAULT_PROFILE: PlayerProfile = { name: 'player', color: '#9aa0a6' };

export interface NetSessionOptions {
  transport: Transport;
  /** Shared world seed. Every peer in a room must pass the same value. */
  seed: number;
  profile: PlayerProfile;
  config?: SimConfig;
  interpolationDelayMs?: number;
}

export type NetSessionEvents = {
  hostChanged: { hostId: string; isHost: boolean };
  rosterChanged: { peerIds: string[] };
  /** Fired on the host each time it publishes a snapshot. */
  snapshotSent: { tick: number };
  /** Fired on every peer each time an authoritative snapshot is applied. */
  snapshotApplied: { tick: number; fromHostId: string };
};

/**
 * Drives one peer's participation in a game.
 *
 * The authority model is **host-authoritative with client prediction**, and
 * the host is *elected*, not configured: every peer independently picks the
 * lowest peer id it can see (see `electHost`). That gives a single source of
 * truth for gameplay — so a cheating peer can only lie about itself, not about
 * the world — while keeping the system genuinely serverless, including
 * automatic host migration when the current host disconnects.
 *
 * Both roles run the same pipeline. The host feeds its own snapshots into its
 * own `ClientView` rather than reading the authoritative world directly, so
 * there is exactly one rendering path to reason about and to test.
 *
 * Deliberately not chosen: lockstep (one dropped packet stalls everyone) and
 * rollback netcode (needs a rewindable simulation and is a poor fit for a
 * free-roaming arena). See `docs/NETWORKING.md`.
 */
export class NetSession {
  readonly events = new Emitter<NetSessionEvents>();
  /** The local `World`. Authoritative when this peer is the host. */
  readonly world: World;
  readonly config: SimConfig;

  #transport: Transport;
  #view: ClientView;
  #profile: PlayerProfile;
  #profiles = new Map<PlayerId, PlayerProfile>();
  #peers = new Set<PlayerId>();
  #hostId: string;
  #subscriptions: Unsubscribe[] = [];

  #inputSeq = 0;
  #intentX = 0;
  #intentZ = 0;
  #intentSprint = false;
  #intentButtons = 0;

  #accumulatorMs = 0;
  #lastUpdateMs: number | null = null;
  #disposed = false;

  constructor(options: NetSessionOptions) {
    this.config = options.config ?? DEFAULT_SIM_CONFIG;
    this.#transport = options.transport;
    this.#profile = options.profile;
    this.world = new World({ seed: options.seed, config: this.config });

    this.#hostId = this.#transport.selfId;
    this.#profiles.set(this.selfId, options.profile);

    this.#view = new ClientView({
      selfId: this.selfId,
      config: this.config,
      obstacles: this.world.obstacles,
      ...(options.interpolationDelayMs !== undefined
        ? { interpolationDelayMs: options.interpolationDelayMs }
        : {}),
    });

    this.#subscriptions.push(
      this.#transport.onMessage((data, from) => this.#handleMessage(data, from)),
      this.#transport.onPeerJoin((peerId) => this.#handlePeerJoin(peerId)),
      this.#transport.onPeerLeave((peerId) => this.#handlePeerLeave(peerId)),
    );

    // A peer may already be connected by the time we subscribe.
    for (const peerId of this.#transport.peers()) this.#peers.add(peerId);
    this.#electHost();
    this.#broadcastHello();
  }

  get selfId(): string {
    return this.#transport.selfId;
  }

  get hostId(): string {
    return this.#hostId;
  }

  get isHost(): boolean {
    return this.#hostId === this.selfId;
  }

  get peerIds(): string[] {
    return [...this.#peers];
  }

  /** Snapshots buffered for interpolation — a rough connection-health signal. */
  get bufferedSnapshotCount(): number {
    return this.#view.bufferedSnapshotCount;
  }

  get pendingInputCount(): number {
    return this.#view.pendingInputCount;
  }

  // ------------------------------------------------------------------ input

  /**
   * Records the player's current intent. Sampled once per simulation tick, so
   * calling it more often than that is harmless.
   *
   * `buttons` is the `BUTTON_*` bitfield from `@/sim/types` — new abilities
   * ride through here with no wire-format change.
   */
  setIntent(moveX: number, moveZ: number, sprint = false, buttons = 0): void {
    this.#intentX = moveX;
    this.#intentZ = moveZ;
    this.#intentSprint = sprint;
    this.#intentButtons = buttons;
  }

  /**
   * Adds a host-simulated bot to the world. Only the host can do this —
   * clients get `false` back (wire a request message if you ever need
   * client-initiated bots; see `docs/RECIPES.md`).
   */
  addBot(): boolean {
    if (!this.isHost) return false;
    return this.world.addBot() !== null;
  }

  /** Removes the last-added bot. Host only. */
  removeBot(): boolean {
    if (!this.isHost) return false;
    return this.world.removeBot();
  }

  get botCount(): number {
    return this.world.bots().length;
  }

  updateProfile(profile: PlayerProfile): void {
    this.#profile = profile;
    this.#profiles.set(this.selfId, profile);
    this.#broadcastHello();
  }

  // ------------------------------------------------------------------ frame

  /**
   * Advances the session. Call once per rendered frame with a monotonic
   * millisecond clock; the fixed-timestep accumulator inside decouples
   * simulation rate from frame rate.
   */
  update(nowMs: number): void {
    if (this.#disposed) return;

    if (this.#lastUpdateMs === null) {
      this.#lastUpdateMs = nowMs;
      return;
    }

    const delta = Math.min(nowMs - this.#lastUpdateMs, MAX_FRAME_DELTA_MS);
    this.#lastUpdateMs = nowMs;
    if (delta <= 0) return;

    const tickMs = 1000 / this.config.tickRate;
    this.#accumulatorMs += delta;

    while (this.#accumulatorMs >= tickMs) {
      this.#accumulatorMs -= tickMs;
      this.#tick(nowMs);
    }

    this.#view.advanceSmoothing(delta);
  }

  /**
   * The interpolated, predicted state to draw at `nowMs`.
   *
   * The accumulator's leftover is handed to `ClientView` as the sub-tick
   * fraction. Without it the local player would be drawn at whatever the last
   * 30 Hz step produced and would visibly stutter against smoothly-scrolling
   * scenery on any display refreshing faster than the tick rate.
   */
  sample(nowMs: number): RenderState {
    if (this.#view.bufferedSnapshotCount === 0) return EMPTY_RENDER_STATE;
    const tickMs = 1000 / this.config.tickRate;
    const tickAlpha = tickMs > 0 ? this.#accumulatorMs / tickMs : 1;
    return this.#view.sample(nowMs, this.#hostId, tickAlpha);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#send({ v: PROTOCOL_VERSION, type: 'bye' });
    for (const unsubscribe of this.#subscriptions) unsubscribe();
    this.#subscriptions = [];
    this.events.clear();
    await this.#transport.close();
  }

  // ------------------------------------------------------------- simulation

  #tick(nowMs: number): void {
    const input: PlayerInput = {
      seq: ++this.#inputSeq,
      moveX: quantize(this.#intentX, 2),
      moveZ: quantize(this.#intentZ, 2),
      sprint: this.#intentSprint,
      buttons: this.#intentButtons,
    };

    this.#view.recordInput(input);

    if (this.isHost) {
      this.world.setInput(this.selfId, input);
      this.world.step();
      this.#publishSnapshotIfDue(nowMs);
      return;
    }

    const message: InputMessage = {
      v: PROTOCOL_VERSION,
      type: 'input',
      seq: input.seq,
      mx: input.moveX,
      mz: input.moveZ,
      sprint: input.sprint,
      buttons: input.buttons,
    };
    this.#send(message, this.#hostId);
  }

  #publishSnapshotIfDue(nowMs: number): void {
    if (this.world.tick % this.config.snapshotIntervalTicks !== 0) return;

    const snapshot = this.world.snapshot();
    const message: SnapshotMessage = {
      v: PROTOCOL_VERSION,
      type: 'snapshot',
      hostId: this.selfId,
      snapshot: encodeSnapshot(snapshot),
    };

    this.#send(message);
    // The host renders through the same client pipeline as everyone else.
    this.#view.pushSnapshot(snapshot, nowMs);
    this.events.emit('snapshotSent', { tick: snapshot.tick });
  }

  // --------------------------------------------------------------- messages

  #handleMessage(raw: unknown, from: string): void {
    if (this.#disposed) return;

    const message = decodeMessage(raw);
    if (!message) {
      log.debug('dropped malformed message from', from);
      return;
    }

    switch (message.type) {
      case 'hello':
        this.#onHello(from, message.profile);
        break;
      case 'input':
        this.#onInput(from, message);
        break;
      case 'snapshot':
        this.#onSnapshot(from, message);
        break;
      case 'bye':
        this.#handlePeerLeave(from);
        break;
      default:
        break;
    }
  }

  #onHello(from: string, profile: PlayerProfile): void {
    this.#profiles.set(from, profile);
    this.#peers.add(from);
    if (this.isHost) {
      this.world.addPlayer(from, profile);
    }
    this.#electHost();
  }

  #onInput(from: string, message: InputMessage): void {
    // Only the host consumes inputs. A non-host receiving one means the sender
    // has a stale view of the roster; it will re-elect shortly.
    if (!this.isHost) return;
    if (!this.world.hasPlayer(from)) {
      this.world.addPlayer(from, this.#profiles.get(from) ?? DEFAULT_PROFILE);
    }
    this.world.setInput(from, {
      seq: message.seq,
      moveX: message.mx,
      moveZ: message.mz,
      sprint: message.sprint,
      buttons: message.buttons,
    });
  }

  #onSnapshot(from: string, message: SnapshotMessage): void {
    if (from !== this.#hostId) {
      // Someone with a stronger claim than our current host is publishing:
      // our roster was stale. Adopt them rather than ignoring the world.
      if (from >= this.#hostId) return;
      log.debug('adopting', from, 'as host over', this.#hostId);
      this.#peers.add(from);
      this.#setHost(from);
    }

    if (this.isHost) return;

    this.world.applySnapshot(message.snapshot);
    this.#view.pushSnapshot(message.snapshot, this.#nowFromLastFrame());
    this.events.emit('snapshotApplied', { tick: message.snapshot.tick, fromHostId: from });
  }

  /**
   * Snapshots are stamped with the current frame's clock rather than a fresh
   * reading, so interpolation timings stay consistent with `update()` and
   * remain fully controllable from tests.
   */
  #nowFromLastFrame(): number {
    return this.#lastUpdateMs ?? 0;
  }

  // ----------------------------------------------------------------- roster

  #handlePeerJoin(peerId: string): void {
    if (this.#disposed) return;
    this.#peers.add(peerId);
    if (this.isHost) {
      this.world.addPlayer(peerId, this.#profiles.get(peerId) ?? DEFAULT_PROFILE);
    }
    // Introduce ourselves so the newcomer learns our name and colour.
    this.#send(this.#helloMessage(), peerId);
    this.#electHost();
    this.events.emit('rosterChanged', { peerIds: this.peerIds });
  }

  #handlePeerLeave(peerId: string): void {
    if (this.#disposed) return;
    if (!this.#peers.delete(peerId)) return;
    this.#profiles.delete(peerId);
    if (this.isHost) this.world.removePlayer(peerId);
    this.#electHost();
    this.events.emit('rosterChanged', { peerIds: this.peerIds });
  }

  #electHost(): void {
    this.#setHost(electHost(this.selfId, [...this.#peers]));
  }

  #setHost(hostId: string): void {
    if (hostId === this.#hostId) return;

    const wasHost = this.isHost;
    this.#hostId = hostId;

    if (this.isHost && !wasHost) {
      // Host migration: the world already holds the last snapshot we received
      // from the departed host, so scores and positions survive the handover.
      // Only the roster needs reconciling against peers that joined since.
      this.#adoptRoster();
      log.info('took over as host at tick', this.world.tick);
    }

    this.events.emit('hostChanged', { hostId, isHost: this.isHost });
  }

  /** Makes the authoritative world's player set match the connected peers. */
  #adoptRoster(): void {
    const expected = new Set<string>([this.selfId, ...this.#peers]);

    for (const id of expected) {
      if (!this.world.hasPlayer(id)) {
        this.world.addPlayer(id, this.#profiles.get(id) ?? DEFAULT_PROFILE);
      }
    }
    for (const player of this.world.players()) {
      // Bots are world entities, not peers — a migrated host keeps simulating
      // the ones it inherited through the snapshot.
      if (!expected.has(player.id) && !player.isBot) this.world.removePlayer(player.id);
    }
  }

  // ------------------------------------------------------------------- send

  #helloMessage(): NetMessage {
    return { v: PROTOCOL_VERSION, type: 'hello', profile: this.#profile };
  }

  #broadcastHello(): void {
    if (this.isHost) {
      this.world.addPlayer(this.selfId, this.#profile);
    }
    this.#send(this.#helloMessage());
  }

  #send(message: NetMessage, target?: string | readonly string[]): void {
    if (this.#disposed && message.type !== 'bye') return;
    this.#transport.send(message, target);
  }
}
