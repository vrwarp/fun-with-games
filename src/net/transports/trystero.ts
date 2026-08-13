import { joinRoom, selfId } from 'trystero';
import type { JsonValue, Room } from 'trystero';
import type { Unsubscribe } from '../../shared/emitter.js';
import { createLogger } from '../../shared/logger.js';
import type { Transport } from '../transport.js';

const log = createLogger('net:trystero');

/**
 * Trystero action namespaces are capped at 12 bytes, so keep this short.
 * One channel carries every message type; `protocol.ts` discriminates.
 */
const ACTION = 'gm';

export interface TrysteroTransportOptions {
  /**
   * Namespaces the room across the shared public relay network. Two different
   * apps using the same `appId` and room name would find each other, so make
   * this specific to your game.
   */
  appId: string;
  roomId: string;
  /**
   * Optional shared secret. Trystero uses it to encrypt the signalling
   * handshake, so peers without it cannot join. Room traffic itself is always
   * end-to-end encrypted by WebRTC regardless.
   */
  password?: string;
  /** Extra ICE servers. The defaults cover most home networks. */
  rtcConfig?: RTCConfiguration;
  onJoinError?: (error: string) => void;
}

/**
 * Real peer-to-peer transport.
 *
 * Trystero handles matchmaking over a decentralized relay network (Nostr by
 * default) and then gets out of the way — once peers have exchanged session
 * descriptions, all game traffic flows directly browser-to-browser over
 * WebRTC data channels and never touches the relay again.
 *
 * See `docs/NETWORKING.md` for why this strategy was chosen and how to swap in
 * MQTT/BitTorrent/a self-hosted relay without touching any calling code.
 */
export function createTrysteroTransport(options: TrysteroTransportOptions): Transport {
  const room: Room = joinRoom(
    {
      appId: options.appId,
      ...(options.password !== undefined ? { password: options.password } : {}),
      ...(options.rtcConfig !== undefined ? { rtcConfig: options.rtcConfig } : {}),
    },
    options.roomId,
    {
      onJoinError: ({ error }) => {
        log.error('failed to join room:', error);
        options.onJoinError?.(error);
      },
    },
  );

  const action = room.makeAction<JsonValue>(ACTION);

  const messageHandlers = new Set<(data: unknown, from: string) => void>();
  const joinHandlers = new Set<(peerId: string) => void>();
  const leaveHandlers = new Set<(peerId: string) => void>();
  let closed = false;

  action.onMessage = (data, context) => {
    if (closed) return;
    for (const handler of [...messageHandlers]) handler(data, context.peerId);
  };

  room.onPeerJoin = (peerId) => {
    if (closed) return;
    log.debug('peer joined', peerId);
    for (const handler of [...joinHandlers]) handler(peerId);
  };

  room.onPeerLeave = (peerId) => {
    if (closed) return;
    log.debug('peer left', peerId);
    for (const handler of [...leaveHandlers]) handler(peerId);
  };

  return {
    selfId,

    send(data, target) {
      if (closed) return;
      const options_ = target === undefined ? undefined : { target: normalizeTarget(target) };
      // Fire-and-forget: a send that fails because a peer vanished mid-flight
      // is normal, and the protocol already tolerates loss. Swallow rather
      // than surface an unhandled rejection on every disconnect.
      void action.send(data as JsonValue, options_).catch((error: unknown) => {
        log.debug('send failed', error);
      });
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
      return Object.keys(room.getPeers());
    },

    async close() {
      if (closed) return;
      closed = true;
      messageHandlers.clear();
      joinHandlers.clear();
      leaveHandlers.clear();
      try {
        await room.leave();
      } catch (error) {
        log.debug('leave failed', error);
      }
    },
  };
}

function normalizeTarget(target: string | readonly string[]): string | string[] {
  return typeof target === 'string' ? target : [...target];
}
