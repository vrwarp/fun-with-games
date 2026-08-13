import type { Unsubscribe } from '../../shared/emitter.js';
import { Rng } from '../../sim/rng.js';
import type { Transport } from '../transport.js';

export interface MemoryNetworkOptions {
  /** One-way delay applied to every message, in virtual milliseconds. */
  latencyMs?: number;
  /** Random extra delay in `[0, jitterMs)`, drawn from the seeded RNG. */
  jitterMs?: number;
  /** Probability in `[0, 1]` that a message is silently dropped. */
  dropRate?: number;
  /** Seed for jitter and drop decisions, so failures reproduce exactly. */
  seed?: number;
}

interface QueuedMessage {
  deliverAt: number;
  from: string;
  to: string;
  data: unknown;
  /** Tie-breaker so equal-timestamp messages deliver in send order. */
  sequence: number;
}

/**
 * An in-process mesh network with a virtual clock.
 *
 * This is the backbone of the multiplayer test suite. A test spins up three
 * peers, gives them 80 ms of latency and 5% packet loss, advances time in
 * explicit steps and asserts that everyone converged — deterministically, in
 * milliseconds, with no browser and no WebRTC.
 *
 * Time only moves when you call `advance()`. Nothing is scheduled on the real
 * clock, so tests never sleep and never flake.
 */
export class MemoryNetwork {
  #now = 0;
  #sequence = 0;
  #queue: QueuedMessage[] = [];
  #peers = new Map<string, MemoryTransport>();
  #rng: Rng;

  readonly latencyMs: number;
  readonly jitterMs: number;
  readonly dropRate: number;

  /** Messages dropped so far — handy for asserting a test is exercising loss. */
  droppedCount = 0;

  constructor(options: MemoryNetworkOptions = {}) {
    this.latencyMs = options.latencyMs ?? 0;
    this.jitterMs = options.jitterMs ?? 0;
    this.dropRate = options.dropRate ?? 0;
    this.#rng = new Rng(options.seed ?? 0xc0ffee);
  }

  get now(): number {
    return this.#now;
  }

  /** Creates a peer and announces it to everyone already connected. */
  connect(peerId: string): Transport {
    if (this.#peers.has(peerId)) {
      throw new Error(`MemoryNetwork: peer "${peerId}" is already connected`);
    }

    const transport = new MemoryTransport(peerId, this);
    const existing = [...this.#peers.values()];
    this.#peers.set(peerId, transport);

    // Peer discovery is instant here. Latency applies to messages, not to
    // membership — real signalling delay is out of scope for these tests.
    for (const other of existing) {
      other.notifyPeerJoin(peerId);
      transport.notifyPeerJoin(other.selfId);
    }

    return transport;
  }

  /** Removes a peer and tells everyone else, mimicking a dropped connection. */
  disconnect(peerId: string): void {
    if (!this.#peers.delete(peerId)) return;
    this.#queue = this.#queue.filter((m) => m.from !== peerId && m.to !== peerId);
    for (const other of this.#peers.values()) {
      other.notifyPeerLeave(peerId);
    }
  }

  peerIds(): string[] {
    return [...this.#peers.keys()];
  }

  /** @internal Called by `MemoryTransport.send`. */
  enqueue(from: string, to: string | undefined, data: unknown): void {
    const targets = to === undefined ? this.peerIds().filter((id) => id !== from) : [to];

    for (const target of targets) {
      if (!this.#peers.has(target)) continue;
      if (this.dropRate > 0 && this.#rng.next() < this.dropRate) {
        this.droppedCount++;
        continue;
      }

      const jitter = this.jitterMs > 0 ? this.#rng.range(0, this.jitterMs) : 0;
      this.#queue.push({
        deliverAt: this.#now + this.latencyMs + jitter,
        from,
        to: target,
        // Structured-clone semantics: the receiver must not share objects with
        // the sender, or a test can pass only because both sides alias state.
        data: clone(data),
        sequence: this.#sequence++,
      });
    }
  }

  /** Moves the virtual clock forward, delivering everything that comes due. */
  advance(ms: number): void {
    const target = this.#now + ms;
    // Deliver in timestamp order; a handler may enqueue more messages, which
    // is why the queue is re-scanned rather than iterated once.
    for (;;) {
      const next = this.#nextDue(target);
      if (!next) break;
      this.#now = Math.max(this.#now, next.deliverAt);
      this.#queue.splice(this.#queue.indexOf(next), 1);
      this.#peers.get(next.to)?.receive(next.data, next.from);
    }
    this.#now = target;
  }

  /** Delivers all in-flight messages without advancing the clock further. */
  flush(): void {
    for (;;) {
      const pending = [...this.#queue];
      if (pending.length === 0) break;
      this.#queue.length = 0;
      pending.sort((a, b) => a.deliverAt - b.deliverAt || a.sequence - b.sequence);
      for (const message of pending) {
        this.#peers.get(message.to)?.receive(message.data, message.from);
      }
    }
  }

  #nextDue(limit: number): QueuedMessage | undefined {
    let best: QueuedMessage | undefined;
    for (const message of this.#queue) {
      if (message.deliverAt > limit) continue;
      if (
        !best ||
        message.deliverAt < best.deliverAt ||
        (message.deliverAt === best.deliverAt && message.sequence < best.sequence)
      ) {
        best = message;
      }
    }
    return best;
  }
}

class MemoryTransport implements Transport {
  readonly selfId: string;

  #network: MemoryNetwork;
  #closed = false;
  #messageHandlers = new Set<(data: unknown, from: string) => void>();
  #joinHandlers = new Set<(peerId: string) => void>();
  #leaveHandlers = new Set<(peerId: string) => void>();
  #knownPeers = new Set<string>();

  constructor(selfId: string, network: MemoryNetwork) {
    this.selfId = selfId;
    this.#network = network;
  }

  send(data: unknown, target?: string | readonly string[]): void {
    if (this.#closed) return;
    if (target === undefined) {
      this.#network.enqueue(this.selfId, undefined, data);
      return;
    }
    const targets = typeof target === 'string' ? [target] : target;
    for (const id of targets) {
      this.#network.enqueue(this.selfId, id, data);
    }
  }

  onMessage(handler: (data: unknown, from: string) => void): Unsubscribe {
    this.#messageHandlers.add(handler);
    return () => this.#messageHandlers.delete(handler);
  }

  onPeerJoin(handler: (peerId: string) => void): Unsubscribe {
    this.#joinHandlers.add(handler);
    return () => this.#joinHandlers.delete(handler);
  }

  onPeerLeave(handler: (peerId: string) => void): Unsubscribe {
    this.#leaveHandlers.add(handler);
    return () => this.#leaveHandlers.delete(handler);
  }

  peers(): string[] {
    return [...this.#knownPeers];
  }

  close(): Promise<void> {
    this.#closed = true;
    this.#messageHandlers.clear();
    this.#joinHandlers.clear();
    this.#leaveHandlers.clear();
    this.#network.disconnect(this.selfId);
    return Promise.resolve();
  }

  /** @internal */
  receive(data: unknown, from: string): void {
    if (this.#closed) return;
    for (const handler of [...this.#messageHandlers]) handler(data, from);
  }

  /** @internal */
  notifyPeerJoin(peerId: string): void {
    if (this.#closed) return;
    this.#knownPeers.add(peerId);
    for (const handler of [...this.#joinHandlers]) handler(peerId);
  }

  /** @internal */
  notifyPeerLeave(peerId: string): void {
    if (this.#closed) return;
    if (!this.#knownPeers.delete(peerId)) return;
    for (const handler of [...this.#leaveHandlers]) handler(peerId);
  }
}

function clone<T>(value: T): T {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : (JSON.parse(JSON.stringify(value)) as T);
}
