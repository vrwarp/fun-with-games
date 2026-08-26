import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { CreateTorus } from '@babylonjs/core/Meshes/Builders/torusBuilder.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { RenderTyre } from '../net/view.js';
import type { SimConfig } from '../sim/config.js';
import { TYRES_PER_STACK, tyreStackSpots, type TyreStackSpot } from '../sim/systems/tyrestacks.js';
import { hashed } from './scenery.js';

/**
 * The tyre walls, drawn one TYRE at a time from the simulation's state.
 *
 * The simulation carries every tyre as its own body; this view gives each one
 * its own mesh and derives its whole pose from that state, so a hit reads as
 * a stack coming apart rather than a welded prop falling over:
 *
 *  - parked on its spot → stacked flat at its tier height, the standing wall;
 *  - knocked and still moving → rolling away upright on its tread like a
 *    loose wheel (some of them — the rest slide flat with a wobble, because a
 *    crash that sends every tyre bowling in formation reads as a rake step);
 *  - stopped away from home → lying flat wherever it ended up.
 *
 * Every pose is a pure function of (position, velocity, home spot, index), so
 * all peers draw identical wreckage with no orientation on the wire, and a
 * round reset — which teleports the tyres home — restacks the wall for free.
 *
 * Not behind the dressing gate: these are collidable, so a device that hides
 * them would be hiding gameplay.
 */

/** Torus proportions of one tyre. Flat on the ground its centre is 0.21 up. */
const TYRE_DIAMETER = 1.15;
const TYRE_THICKNESS = 0.42;
/** Lying flat: centre at half the tube. Standing on tread: ring + tube. */
const FLAT_HEIGHT = TYRE_THICKNESS / 2;
const ROLLING_HEIGHT = TYRE_DIAMETER / 2 + TYRE_THICKNESS / 2;

/** Painted bundles, same trio the scenery used: red, white, near-black. */
const BUNDLE_COLOURS = [
  new Color3(0.55, 0.12, 0.1),
  new Color3(0.78, 0.78, 0.74),
  new Color3(0.09, 0.09, 0.1),
];

/** Displacement past which a tyre is fully "loose" rather than dislodged. */
const LOOSE_DISTANCE = 1.1;
/** Share of tyres that roll away on their tread; the rest slide flat. */
const ROLLER_SHARE = 0.45;

export class TyreStackView {
  #spots: TyreStackSpot[];
  #meshes: Mesh[] = [];
  #prototypes: Mesh[] = [];
  #materials: PBRMaterial[] = [];
  #axis = new Vector3();
  #swing = new Quaternion();
  #spin = new Quaternion();

  constructor(scene: Scene, config: SimConfig) {
    this.#spots = tyreStackSpots(config);
    if (this.#spots.length === 0) return;

    this.#prototypes = BUNDLE_COLOURS.map((colour, index) =>
      this.#buildPrototype(scene, colour, index),
    );

    const total = this.#spots.length * TYRES_PER_STACK;
    for (let i = 0; i < total; i++) {
      const stack = Math.floor(i / TYRES_PER_STACK);
      const prototype = this.#prototypes[stack % this.#prototypes.length];
      const mesh = prototype ? prototype.clone(`tyre:${i}`) : null;
      if (!mesh) throw new Error('tyre prototype missing');
      const spot = this.#spots[stack];
      mesh.setEnabled(true);
      mesh.isPickable = false;
      mesh.position.set(spot?.x ?? 0, this.#tierHeight(i), spot?.z ?? 0);
      mesh.rotationQuaternion = Quaternion.Identity();
      this.#meshes.push(mesh);
    }
  }

  /** Moves every tyre to its simulated position and derives its pose. */
  sync(tyres: readonly RenderTyre[]): void {
    const count = Math.min(tyres.length, this.#meshes.length);
    for (let i = 0; i < count; i++) {
      const state = tyres[i];
      const mesh = this.#meshes[i];
      const spot = this.#spots[Math.floor(i / TYRES_PER_STACK)];
      const rotation = mesh?.rotationQuaternion;
      if (!state || !mesh || !spot || !rotation) continue;

      mesh.position.x = state.x;
      mesh.position.z = state.z;

      const dx = state.x - spot.x;
      const dz = state.z - spot.z;
      const distance = Math.hypot(dx, dz);
      const speed = Math.hypot(state.vx, state.vz);

      if (distance < 0.05 && speed < 0.1) {
        // Home: back in the stack, flat at its tier. A round reset teleports
        // tyres here, so this is also what rebuilds the wall between rounds.
        mesh.position.y = this.#tierHeight(i);
        rotation.copyFromFloats(0, 0, 0, 1);
        continue;
      }

      // Loose. Face along whichever direction is better defined: travel while
      // moving, displacement once settled.
      const dirX = speed > 0.3 ? state.vx / speed : distance > 1e-6 ? dx / distance : 1;
      const dirZ = speed > 0.3 ? state.vz / speed : distance > 1e-6 ? dz / distance : 0;
      const loose = Math.min(1, distance / LOOSE_DISTANCE);
      const roller = hashed(i, 29) < ROLLER_SHARE;

      // A roller stands up only while it is actually travelling; as friction
      // takes the speed the same term lies it back down, so nothing ends the
      // crash balanced on its tread.
      const stand = roller ? loose * Math.min(1, speed / 2.5) : 0;

      // Tip around the travel axis stands the tyre into its rolling plane;
      // spinning it about its own (now horizontal) hub is the rolling. The
      // sliders keep a shallow lean instead, plus a wobble that dies with
      // speed — a flat disc spinning about +Y is rotationally invisible.
      const lean = roller ? stand * (Math.PI / 2 - 0.08) : loose * (0.22 + 0.1 * hashed(i, 31));
      const wobble = roller ? 0 : Math.sin(distance * 6 + i) * 0.12 * Math.min(1, speed / 4);
      this.#axis.set(dirX, 0, dirZ);
      Quaternion.RotationAxisToRef(this.#axis, lean + wobble, this.#swing);
      if (roller && stand > 0.01) {
        this.#axis.set(dirZ, 0, -dirX);
        Quaternion.RotationAxisToRef(this.#axis, (distance / ROLLING_HEIGHT) * stand, this.#spin);
        this.#spin.multiplyToRef(this.#swing, this.#swing);
      }
      rotation.copyFrom(this.#swing);

      mesh.position.y = FLAT_HEIGHT + (ROLLING_HEIGHT - FLAT_HEIGHT) * stand;
    }
  }

  /** Registers every tyre as a shadow caster (cascade tier only). */
  addCastersTo(shadows: { addShadowCaster(mesh: Mesh): void }): void {
    for (const mesh of this.#meshes) {
      if (!mesh.isDisposed()) shadows.addShadowCaster(mesh);
    }
  }

  /** Same policy as the scenery: only the cascade tier's map has them in it. */
  setReceiveShadows(on: boolean): void {
    for (const mesh of this.#meshes) {
      if (!mesh.isDisposed()) mesh.receiveShadows = on;
    }
  }

  dispose(): void {
    for (const mesh of this.#meshes) mesh.dispose();
    for (const prototype of this.#prototypes) prototype.dispose();
    for (const material of this.#materials) material.dispose();
    this.#meshes = [];
    this.#prototypes = [];
    this.#materials = [];
  }

  /** Flat stacking heights: bottom tyre ON the ground, each resting on the last. */
  #tierHeight(index: number): number {
    return FLAT_HEIGHT + (index % TYRES_PER_STACK) * TYRE_THICKNESS;
  }

  /** One tyre torus; the whole stack's paint comes from its stack index. */
  #buildPrototype(scene: Scene, colour: Color3, index: number): Mesh {
    const mesh = CreateTorus(
      `tyre:proto${index}`,
      { diameter: TYRE_DIAMETER, thickness: TYRE_THICKNESS, tessellation: 12 },
      scene,
    );
    const material = new PBRMaterial(`tyre:mat${index}`, scene);
    material.albedoColor = colour.toLinearSpace();
    material.metallic = 0;
    material.roughness = 0.75;
    this.#materials.push(material);
    mesh.material = material;
    mesh.setEnabled(false);
    mesh.isPickable = false;
    return mesh;
  }
}
