/**
 * The read-only debug handle `src/main.ts` attaches to `window`.
 *
 * It lets end-to-end tests assert on session facts (who is host, how many
 * peers, what tick) instead of inferring them from pixels. Keep this in sync
 * with `exposeTestHandle` in `src/main.ts`.
 */
interface FwgTestHandle {
  readonly selfId: string;
  readonly hostId: string;
  readonly isHost: boolean;
  readonly peerCount: number;
  readonly tick: number;
  readonly mode: string;
  readonly phase: 'lobby' | 'countdown' | 'playing' | 'ended';
  readonly botCount: number;
  readonly playerCount: number;
  readonly players: ReadonlyArray<{
    id: string;
    name: string;
    x: number;
    z: number;
    score: number;
  }>;
  readonly fps: number;
  readonly cameraAlpha: number;
  readonly cameraRadius: number;
  readonly cameraBeta: number;
}

declare global {
  interface Window {
    readonly __FWG__: FwgTestHandle;
  }
}

export {};
