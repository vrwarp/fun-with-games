import { MemoryNetwork } from '@/net/transports/memory.js';
import { NetSession } from '@/net/session.js';
import type { RenderState } from '@/net/view.js';
import { makeSimConfig, type SimConfig, type SimConfigOverrides } from '@/sim/config.js';
import type { PlayerProfile } from '@/sim/types.js';
import type { World } from '@/sim/world.js';

export interface HarnessOptions {
  seed?: number;
  config?: SimConfigOverrides;
  latencyMs?: number;
  jitterMs?: number;
  dropRate?: number;
  /** Seed for the network's jitter/loss decisions. */
  networkSeed?: number;
  interpolationDelayMs?: number;
  /** Virtual milliseconds per simulated frame. 16 ms ≈ 60 fps. */
  frameMs?: number;
}

export interface HarnessPeer {
  id: string;
  session: NetSession;
}

/**
 * Runs a complete multiplayer session in-process against a virtual clock.
 *
 * This is the single most useful testing tool in the repo. It gives you a real
 * `NetSession` per peer — real host election, real snapshots, real prediction
 * and reconciliation — over `MemoryNetwork`, with configurable latency, jitter
 * and packet loss. No browser, no WebRTC, no waiting: a 10-second session with
 * 3 peers and 10% packet loss runs in a few milliseconds and produces the same
 * result every time.
 *
 * ```ts
 * const harness = new SessionHarness({ latencyMs: 60, dropRate: 0.1 });
 * harness.join('alice');
 * harness.join('bob');
 * harness.setIntent('bob', 1, 0);
 * harness.advance(2000);
 * expect(harness.state('alice').players).toHaveLength(2);
 * ```
 *
 * Peer ids double as the host election order (lowest id wins), so name them
 * deliberately when a test cares which peer is in charge.
 */
export class SessionHarness {
  readonly network: MemoryNetwork;
  readonly config: SimConfig;
  readonly seed: number;

  readonly #peers = new Map<string, HarnessPeer>();
  readonly #frameMs: number;
  readonly #interpolationDelayMs: number | undefined;

  constructor(options: HarnessOptions = {}) {
    this.seed = options.seed ?? 1234;
    this.config = makeSimConfig(options.config ?? {});
    this.#frameMs = options.frameMs ?? 16;
    this.#interpolationDelayMs = options.interpolationDelayMs;

    this.network = new MemoryNetwork({
      latencyMs: options.latencyMs ?? 0,
      jitterMs: options.jitterMs ?? 0,
      dropRate: options.dropRate ?? 0,
      seed: options.networkSeed ?? 0xbeef,
    });
  }

  get peers(): HarnessPeer[] {
    return [...this.#peers.values()];
  }

  get now(): number {
    return this.network.now;
  }

  join(id: string, profile?: Partial<PlayerProfile>): HarnessPeer {
    const transport = this.network.connect(id);
    const session = new NetSession({
      transport,
      seed: this.seed,
      config: this.config,
      profile: {
        name: profile?.name ?? id,
        color: profile?.color ?? '#4cc9f0',
      },
      ...(this.#interpolationDelayMs !== undefined
        ? { interpolationDelayMs: this.#interpolationDelayMs }
        : {}),
    });

    const peer: HarnessPeer = { id, session };
    this.#peers.set(id, peer);
    return peer;
  }

  /** Disconnects a peer the way a closed tab would: abruptly, no goodbye. */
  drop(id: string): void {
    this.#peers.delete(id);
    this.network.disconnect(id);
  }

  /** Disconnects a peer gracefully, sending a `bye` first. */
  async leave(id: string): Promise<void> {
    const peer = this.#peers.get(id);
    if (!peer) return;
    this.#peers.delete(id);
    await peer.session.dispose();
  }

  peer(id: string): HarnessPeer {
    const peer = this.#peers.get(id);
    if (!peer) throw new Error(`SessionHarness: no peer "${id}"`);
    return peer;
  }

  setIntent(id: string, moveX: number, moveZ: number, sprint = false, buttons = 0): void {
    this.peer(id).session.setIntent(moveX, moveZ, sprint, buttons);
  }

  /**
   * The authoritative world, when every peer agrees who the host is.
   * Mutating it (teleporting players, forcing scores) is the intended way to
   * set up gameplay situations without simulating minutes of movement.
   */
  hostWorld(): World {
    const host = this.host();
    if (!host) throw new Error('SessionHarness: peers disagree about the host');
    return host.session.world;
  }

  /** Advances the virtual clock, delivering messages and ticking every peer. */
  advance(totalMs: number): void {
    let remaining = totalMs;
    while (remaining > 0) {
      const step = Math.min(this.#frameMs, remaining);
      this.network.advance(step);
      for (const peer of this.#peers.values()) {
        peer.session.update(this.network.now);
      }
      remaining -= step;
    }
  }

  /** The peer every participant currently agrees is host, if they agree. */
  host(): HarnessPeer | null {
    const hosts = new Set(this.peers.map((peer) => peer.session.hostId));
    if (hosts.size !== 1) return null;
    const [hostId] = [...hosts];
    return hostId ? (this.#peers.get(hostId) ?? null) : null;
  }

  state(id: string): RenderState {
    return this.peer(id).session.sample(this.network.now);
  }

  /** Score as seen by `observerId`, for `subjectId`. */
  score(observerId: string, subjectId: string): number | undefined {
    return this.state(observerId).players.find((player) => player.id === subjectId)?.score;
  }

  async disposeAll(): Promise<void> {
    await Promise.all(this.peers.map((peer) => peer.session.dispose()));
    this.#peers.clear();
  }
}
