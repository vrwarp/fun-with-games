import type { Unsubscribe } from '../shared/emitter.js';

/**
 * The seam between the game and the wire.
 *
 * Everything above this interface is testable in Node with zero WebRTC:
 * `MemoryTransport` implements it with a virtual clock, simulated latency and
 * packet loss, and `TrysteroTransport` implements it with real peer-to-peer
 * data channels. Swapping one for the other is the only difference between an
 * integration test and a live game.
 *
 * Implementations must be safe to call after `close()` — they become no-ops
 * rather than throwing, because teardown races are routine in a browser.
 */
export interface Transport {
  /** This peer's stable id for the lifetime of the session. */
  readonly selfId: string;

  /**
   * Sends `data` to `target`, or to every connected peer when `target` is
   * omitted. Delivery is best-effort and unordered — the protocol above must
   * tolerate loss and reordering.
   */
  send(data: unknown, target?: string | readonly string[]): void;

  /** Fires for every inbound message. `from` is the sender's peer id. */
  onMessage(handler: (data: unknown, from: string) => void): Unsubscribe;

  onPeerJoin(handler: (peerId: string) => void): Unsubscribe;
  onPeerLeave(handler: (peerId: string) => void): Unsubscribe;

  /** Currently connected peers, excluding self. */
  peers(): string[];

  close(): Promise<void>;
}

/**
 * Picks the host from a peer set.
 *
 * There is no server, so authority has to be derivable rather than assigned:
 * every peer sorts the ids it knows about and takes the smallest. Peers that
 * agree on the membership set agree on the host without exchanging a single
 * message, and when the host disappears the next-smallest id takes over
 * automatically — that is host migration, for free.
 *
 * The cost is honest: during the window where peers disagree about membership,
 * they can disagree about the host. `NetSession` handles that by accepting
 * snapshots from whoever it currently believes is host and re-electing when
 * membership changes.
 */
export function electHost(selfId: string, peerIds: readonly string[]): string {
  let host = selfId;
  for (const id of peerIds) {
    if (id < host) host = id;
  }
  return host;
}
