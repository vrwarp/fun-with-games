/**
 * Small, dependency-free math helpers.
 *
 * Deliberately not Babylon's `Vector3`: the simulation layer must stay
 * headless, so anything it touches has to be plain TypeScript.
 */

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Shortest-path interpolation between two angles in radians. */
export function lerpAngle(a: number, b: number, t: number): number {
  const TAU = Math.PI * 2;
  let delta = (b - a) % TAU;
  if (delta > Math.PI) delta -= TAU;
  if (delta < -Math.PI) delta += TAU;
  return a + delta * t;
}

export function length2(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

/**
 * Scales `(x, y)` to unit length. Returns `(0, 0)` unchanged rather than
 * producing NaN, which is what a zero-length input vector means in practice.
 */
export function normalize2(x: number, y: number): { x: number; y: number } {
  const len = length2(x, y);
  if (len === 0) return { x: 0, y: 0 };
  return { x: x / len, y: y / len };
}

/** Caps a vector's magnitude without changing its direction. */
export function clampMagnitude2(x: number, y: number, max: number): { x: number; y: number } {
  const len = length2(x, y);
  if (len <= max || len === 0) return { x, y };
  const scale = max / len;
  return { x: x * scale, y: y * scale };
}

export function distance2(ax: number, ay: number, bx: number, by: number): number {
  return length2(ax - bx, ay - by);
}

/** Squared distance — use when only comparing distances, to skip the sqrt. */
export function distanceSq2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

/**
 * Rounds to a fixed number of decimals. Used by the wire codec to shrink
 * snapshots; never used inside the simulation itself, where exact float
 * behaviour is what makes replays reproducible.
 */
export function quantize(value: number, decimals = 3): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
