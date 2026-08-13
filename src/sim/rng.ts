/**
 * Seeded pseudo-random number generator (mulberry32).
 *
 * The simulation is forbidden from calling `Math.random()` (enforced by an
 * ESLint rule). Every random decision goes through an `Rng` whose entire state
 * is one uint32, which means it can be captured in a snapshot and restored —
 * that is what makes a session replayable and a desync reproducible.
 */
export class Rng {
  #state: number;

  constructor(seed: number) {
    // Force to uint32 so behaviour matches regardless of what was passed in.
    this.#state = seed >>> 0;
  }

  /** Current internal state. Include this in snapshots to make replays exact. */
  get state(): number {
    return this.#state;
  }

  set state(value: number) {
    this.#state = value >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Uniform integer in [min, max) — `max` exclusive. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max));
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick() called with an empty array');
    // Length is checked above, so the index is always in range.
    return items[this.int(0, items.length)] as T;
  }

  /** Independent copy — advancing the clone does not affect the original. */
  clone(): Rng {
    return new Rng(this.#state);
  }
}

/**
 * Turns an arbitrary string (a room code, a peer id) into a uint32 seed via
 * FNV-1a, so that everyone who joins the same room builds the same arena.
 */
export function hashStringToSeed(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
