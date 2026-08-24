import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import type { Scene } from '@babylonjs/core/scene.js';

/**
 * What the tyres leave behind: rubber where a car slid, dust where it went off.
 *
 * The point is to make the handling model *readable*. The simulation knows
 * exactly how sideways every car is — `slipAngle` is the number the whole tyre
 * model is built around — but until now none of that reached the screen. A
 * player could feel the back end step out and had nothing to look at
 * afterwards, and could not see where a rival had been in trouble at all.
 *
 * ## One mesh, not two hundred
 *
 * A phone is the target, so a pool of separate quads would be a pool of
 * separate draw calls. Instead this is a SINGLE mesh whose vertex buffers are
 * rewritten in place: a fixed ring of quads, oldest overwritten first. Nothing
 * is created or disposed after startup, which matters as much for the garbage
 * collector as for the GPU — a mark system that allocates is a stutter every
 * few seconds.
 *
 * Positions are only rewritten when a mark is actually laid. The colour buffer
 * is rewritten every frame, because that is what fades them, and it is small:
 * a few hundred vertices.
 *
 * ## Why it fades rather than accumulating
 *
 * Rubber does build up on a real circuit, but a mark that never leaves means a
 * six-lap race ends with the racing line drawn solid — which hides the thing
 * this exists to show, namely where somebody is in trouble *now*.
 */

/** How many marks are alive at once. Each is one quad: 4 vertices. */
const POOL = 192;
/** Seconds a mark takes to fade away completely. */
const LIFE = 3.5;
/** Slip angle past which a tyre is considered to be laying rubber. */
const SLIP_THRESHOLD = 0.28;
/** Below this speed nothing is marked — a parked car is not scrubbing. */
const MIN_SPEED = 3;
/** World units a car must travel before it lays another mark. */
const SPACING = 1.1;
/**
 * Height above the ground, in world units.
 *
 * Must sit ABOVE the road band, which `trackview.ts` puts at 0.02, and below
 * the DRS zone at 0.05. Coplanar with the road is not "close enough": two
 * surfaces at identical depth z-fight, so the marks flickered in and out
 * depending on the camera angle and mostly lost.
 */
const LIFT = 0.035;

const VERTS_PER_MARK = 4;
const RUBBER = new Color3(0.06, 0.06, 0.07);
const DUST = new Color3(0.62, 0.56, 0.42);

/** What one car is doing, as far as the ground is concerned. */
export interface MarkSource {
  readonly id: string;
  readonly x: number;
  readonly z: number;
  readonly heading: number;
  readonly vx: number;
  readonly vz: number;
  /** False when the car is off the racing surface, which marks differently. */
  readonly onTrack: boolean;
}

/**
 * Whether this car is scrubbing hard enough to leave anything.
 *
 * Exported because it is the whole editorial decision — what counts as "in
 * trouble" — and it is a pure function of the numbers, so it can be checked
 * without a GPU.
 */
export function marksGround(source: MarkSource): boolean {
  const speed = Math.hypot(source.vx, source.vz);
  if (speed < MIN_SPEED) return false;
  // Off the road, everything kicks up dust; on it, only a slide leaves rubber.
  if (!source.onTrack) return true;
  return Math.abs(slipOf(source)) > SLIP_THRESHOLD;
}

/** Angle between where the car points and where it is actually going. */
export function slipOf(source: MarkSource): number {
  const sin = Math.sin(source.heading);
  const cos = Math.cos(source.heading);
  const forward = source.vx * sin + source.vz * cos;
  const lateral = source.vx * cos - source.vz * sin;
  if (Math.abs(forward) < 0.01 && Math.abs(lateral) < 0.01) return 0;
  return Math.atan2(lateral, Math.abs(forward));
}

export class SurfaceMarks {
  readonly mesh: Mesh;

  #positions = new Float32Array(POOL * VERTS_PER_MARK * 3);
  #colors = new Float32Array(POOL * VERTS_PER_MARK * 4);
  /** Age of each mark in seconds; LIFE or more means the slot is free. */
  #age = new Float32Array(POOL).fill(LIFE);
  #next = 0;
  /** Where each car last laid one, so marks are spaced by distance not time. */
  #lastAt = new Map<string, { x: number; z: number }>();
  #material: StandardMaterial;
  #width: number;

  constructor(scene: Scene, carWidth: number) {
    this.#width = carWidth;

    const indices = new Uint16Array(POOL * 6);
    for (let i = 0; i < POOL; i++) {
      const v = i * VERTS_PER_MARK;
      const o = i * 6;
      indices[o] = v;
      indices[o + 1] = v + 1;
      indices[o + 2] = v + 2;
      indices[o + 3] = v;
      indices[o + 4] = v + 2;
      indices[o + 5] = v + 3;
    }

    this.mesh = new Mesh('marks', scene);
    const data = new VertexData();
    data.positions = this.#positions;
    data.indices = indices;
    data.colors = this.#colors;
    data.applyToMesh(this.mesh, true);

    this.#material = new StandardMaterial('marks:mat', scene);
    // Unlit on purpose. A tyre mark is a stain on a surface that is already
    // lit; shading it again would make it brighten and darken as the sun moved
    // across the circuit, which is not a thing skid marks do.
    this.#material.disableLighting = true;
    this.#material.emissiveColor = new Color3(1, 1, 1);
    this.#material.backFaceCulling = false;
    this.mesh.material = this.#material;
    this.mesh.hasVertexAlpha = true;
    // Never occludes anything and never casts: it is paint on the floor.
    this.mesh.isPickable = false;
    this.mesh.receiveShadows = false;
    this.mesh.alwaysSelectAsActiveMesh = true;
  }

  /** One frame. `dt` is seconds since the last call. */
  update(sources: readonly MarkSource[], dt: number): void {
    for (const source of sources) {
      if (!marksGround(source)) {
        // Forget where it was, so a car that stops sliding and starts again
        // lays its first new mark immediately rather than waiting out the
        // spacing from wherever it last slid.
        this.#lastAt.delete(source.id);
        continue;
      }

      const last = this.#lastAt.get(source.id);
      if (last && Math.hypot(source.x - last.x, source.z - last.z) < SPACING) continue;
      this.#lastAt.set(source.id, { x: source.x, z: source.z });
      this.#lay(source);
    }

    this.#fade(dt);
  }

  dispose(): void {
    this.#material.dispose();
    this.mesh.dispose();
  }

  // -------------------------------------------------------------- internals

  #lay(source: MarkSource): void {
    const slot = this.#next;
    this.#next = (this.#next + 1) % POOL;
    this.#age[slot] = 0;

    // Laid across the direction of TRAVEL rather than across the nose. A
    // sliding car's marks run along the path the tyres actually took, which is
    // exactly the difference a slide is made of — orienting them to the
    // heading would draw a car neatly following its own nose while sideways.
    const speed = Math.hypot(source.vx, source.vz) || 1;
    const dirX = source.vx / speed;
    const dirZ = source.vz / speed;
    // Perpendicular, for the width of the mark. Rubber is exactly as wide as
    // the tyre that laid it; dust billows, so it spreads past the car.
    const halfW = this.#width * (source.onTrack ? 0.5 : 0.85);
    const px = dirZ * halfW;
    const pz = -dirX * halfW;
    // A little longer than the spacing, so consecutive marks overlap into a
    // continuous streak instead of a dotted line.
    const halfL = SPACING * 0.62;
    const lx = dirX * halfL;
    const lz = dirZ * halfL;

    const base = slot * VERTS_PER_MARK * 3;
    const corners: Array<[number, number]> = [
      [-lx - px, -lz - pz],
      [lx - px, lz - pz],
      [lx + px, lz + pz],
      [-lx + px, -lz + pz],
    ];
    corners.forEach((corner, i) => {
      this.#positions[base + i * 3] = source.x + corner[0];
      this.#positions[base + i * 3 + 1] = LIFT;
      this.#positions[base + i * 3 + 2] = source.z + corner[1];
    });

    const tint = source.onTrack ? RUBBER : DUST;
    const colorBase = slot * VERTS_PER_MARK * 4;
    for (let i = 0; i < VERTS_PER_MARK; i++) {
      this.#colors[colorBase + i * 4] = tint.r;
      this.#colors[colorBase + i * 4 + 1] = tint.g;
      this.#colors[colorBase + i * 4 + 2] = tint.b;
    }

    this.mesh.updateVerticesData(VertexBuffer.PositionKind, this.#positions);
  }

  #fade(dt: number): void {
    let touched = false;
    for (let slot = 0; slot < POOL; slot++) {
      const age = this.#age[slot] ?? LIFE;
      if (age >= LIFE) continue;
      const next = age + dt;
      this.#age[slot] = next;
      touched = true;

      // Squared, so a mark stays dark for most of its life and then goes
      // quickly. A linear fade reads as the whole circuit dimming at once.
      const left = Math.max(0, 1 - next / LIFE);
      const alpha = left * left;
      const base = slot * VERTS_PER_MARK * 4;
      for (let i = 0; i < VERTS_PER_MARK; i++) this.#colors[base + i * 4 + 3] = alpha;
    }
    if (touched) {
      this.mesh.updateVerticesData(VertexBuffer.ColorKind, this.#colors);
    }
  }
}
