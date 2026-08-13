/** View model handed to the renderer. Deliberately flat and Babylon-free. */
export interface RenderPlayer {
  id: string;
  name: string;
  color: string;
  x: number;
  z: number;
  heading: number;
  score: number;
  isLocal: boolean;
  isHost: boolean;
}

export interface RenderPickup {
  id: number;
  x: number;
  z: number;
  active: boolean;
}

export interface RenderState {
  /** Tick of the most recent authoritative snapshot this state derives from. */
  tick: number;
  players: RenderPlayer[];
  pickups: RenderPickup[];
}

/** Shared "nothing to draw yet" value. Frozen so a consumer cannot corrupt it. */
export const EMPTY_RENDER_STATE: RenderState = Object.freeze({
  tick: 0,
  players: [] as RenderPlayer[],
  pickups: [] as RenderPickup[],
});
