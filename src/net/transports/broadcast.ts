import type { Unsubscribe } from '../../shared/emitter.js';
import type { Transport } from '../transport.js';

const ANNOUNCE_INTERVAL_MS = 1000;
/** A peer silent for this long is presumed gone. */
const PEER_TIMEOUT_MS = 4000;

type Frame =
  | { kind: 'announce'; from: string }
  | { kind: 'bye'; from: string }
  | { kind: 'msg'; from: string; to: string | null; data: unknown };

export interface BroadcastTransportOptions {
  roomId: string;
  /** Overridable so tests can pin ids and therefore pin host election. */
  selfId?: string;
}

/**
 * A `Transport` over `BroadcastChannel`: same browser, same origin, no network.
 *
 * Two uses, both real:
 *
 *  - **Local development.** Open two tabs and you have a multiplayer session,
 *    offline, with no relay round trip and no waiting for ICE.
 *  - **CI.** The end-to-end multiplayer test drives two pages in one browser.
 *    Running that over live WebRTC would mean depending on public relays and
 *    UDP egress from a CI container — the test would fail for reasons that
 *    have nothing to do with the change under review.
 *
 * It exercises the entire stack above the transport seam — election, snapshots,
 * prediction, reconciliation, interpolation, host migration — so the only
 * untested part is WebRTC itself. Select it with `?net=broadcast`.
 */
export function createBroadcastTransport(options: BroadcastTransportOptions): Transport {
  const selfId = options.selfId ?? generatePeerId();
  const channel = new BroadcastChannel(`fun-with-games:${options.roomId}`);

  const messageHandlers = new Set<(data: unknown, from: string) => void>();
  const joinHandlers = new Set<(peerId: string) => void>();
  const leaveHandlers = new Set<(peerId: string) => void>();
  /** peerId -> timestamp of the last frame seen from them. */
  const lastSeen = new Map<string, number>();

  let closed = false;

  const post = (frame: Frame): void => {
    if (closed) return;
    channel.postMessage(frame);
  };

  const notePeer = (peerId: string): void => {
    const isNew = !lastSeen.has(peerId);
    lastSeen.set(peerId, Date.now());
    if (!isNew) return;
    for (const handler of [...joinHandlers]) handler(peerId);
    // Answer immediately so the newcomer learns about us without waiting a
    // full heartbeat interval.
    post({ kind: 'announce', from: selfId });
  };

  const dropPeer = (peerId: string): void => {
    if (!lastSeen.delete(peerId)) return;
    for (const handler of [...leaveHandlers]) handler(peerId);
  };

  channel.onmessage = (event: MessageEvent<Frame>) => {
    if (closed) return;
    const frame = event.data;
    if (!frame || typeof frame !== 'object' || frame.from === selfId) return;

    switch (frame.kind) {
      case 'announce':
        notePeer(frame.from);
        break;
      case 'bye':
        dropPeer(frame.from);
        break;
      case 'msg':
        notePeer(frame.from);
        if (frame.to !== null && frame.to !== selfId) return;
        for (const handler of [...messageHandlers]) handler(frame.data, frame.from);
        break;
      default:
        break;
    }
  };

  post({ kind: 'announce', from: selfId });

  const heartbeat = setInterval(() => {
    if (closed) return;
    post({ kind: 'announce', from: selfId });

    const cutoff = Date.now() - PEER_TIMEOUT_MS;
    for (const [peerId, seenAt] of [...lastSeen]) {
      if (seenAt < cutoff) dropPeer(peerId);
    }
  }, ANNOUNCE_INTERVAL_MS);

  const onUnload = (): void => {
    post({ kind: 'bye', from: selfId });
  };
  globalThis.window?.addEventListener('pagehide', onUnload);

  return {
    selfId,

    send(data, target) {
      if (closed) return;
      if (target === undefined) {
        post({ kind: 'msg', from: selfId, to: null, data });
        return;
      }
      const targets = typeof target === 'string' ? [target] : target;
      for (const to of targets) {
        post({ kind: 'msg', from: selfId, to, data });
      }
    },

    onMessage(handler): Unsubscribe {
      messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },

    onPeerJoin(handler): Unsubscribe {
      joinHandlers.add(handler);
      return () => joinHandlers.delete(handler);
    },

    onPeerLeave(handler): Unsubscribe {
      leaveHandlers.add(handler);
      return () => leaveHandlers.delete(handler);
    },

    peers() {
      return [...lastSeen.keys()];
    },

    close() {
      if (closed) return Promise.resolve();
      closed = true;
      clearInterval(heartbeat);
      globalThis.window?.removeEventListener('pagehide', onUnload);
      channel.postMessage({ kind: 'bye', from: selfId } satisfies Frame);
      channel.close();
      messageHandlers.clear();
      joinHandlers.clear();
      leaveHandlers.clear();
      lastSeen.clear();
      return Promise.resolve();
    },
  };
}

function generatePeerId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid.replace(/-/g, '').slice(0, 16);
  return Math.random().toString(36).slice(2, 18).padEnd(16, '0');
}
