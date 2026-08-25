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
  /** The tier in force, after governor step-downs — not the one asked for. */
  readonly quality: 'low' | 'medium' | 'high';
  /** What shadow rig is live, how many casters feed it, and map readiness. */
  readonly shadows: { kind: 'cascade' | 'blur' | 'none'; casters: number; mapReady: boolean };
  readonly view: 'follow' | 'first' | 'iso' | 'topdown' | 'side';
  readonly orthographic: boolean;
  readonly phase: 'lobby' | 'countdown' | 'playing' | 'ended';
  readonly botCount: number;
  readonly playerCount: number;
  readonly players: ReadonlyArray<{
    id: string;
    name: string;
    x: number;
    z: number;
    y: number;
    /** Where the body points, which for a car is not where it is going. */
    heading: number;
    /** World velocity. A stopped car cannot steer, so tests have to see this. */
    vx: number;
    vz: number;
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
