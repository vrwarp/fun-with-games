import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { CreateTorus } from '@babylonjs/core/Meshes/Builders/torusBuilder.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { RenderTyreStack } from '../net/view.js';
import type { SimConfig } from '../sim/config.js';
import { tyreStackSpots, type TyreStackSpot } from '../sim/systems/tyrestacks.js';

/**
 * The tyre-wall stacks, drawn wherever the simulation says they are.
 *
 * These used to be trackside dressing — merged into the static scenery and
 * skipped entirely on a software rasteriser. Now that a stack is a body a car
 * can hit, it has to be VISIBLE everywhere it is collidable, so this view is
 * not behind the dressing gate: one small mesh per stack, on every device,
 * exactly like the cars.
 *
 * Everything theatrical about a hit — the stack heeling over, rolling, coming
 * to rest on its side — is derived here from the simulated position alone:
 * how far a stack sits from its home spot decides how far it has toppled, so
 * every peer draws the same wreckage without an extra byte on the wire, and a
 * round reset (which teleports the stacks home) stands the wall back up for
 * free.
 */

/** Torus proportions shared by every tyre. Bottom tyre RESTS ON the ground. */
const TYRE_DIAMETER = 1.15;
const TYRE_THICKNESS = 0.42;
const TYRE_CENTRES = [0.21, 0.63, 1.05];

/** Painted bundles, same trio the scenery used: red, white, near-black. */
const BUNDLE_COLOURS = [
  new Color3(0.55, 0.12, 0.1),
  new Color3(0.78, 0.78, 0.74),
  new Color3(0.09, 0.09, 0.1),
];

/** Displacement that reads as fully knocked over, in metres. */
const TOPPLE_DISTANCE = 1.4;
/** Not quite flat: a hair over 77° keeps the silhouette clear of z-fighting. */
const TOPPLE_ANGLE = 1.35;
/** Continued travel past the topple keeps turning the pile — the "roll". */
const ROLL_RATE = 1.1;
/** Lift while lying down, so a horizontal stack rests ON the grass. */
const LYING_LIFT = 0.32;

export class TyreStackView {
  #spots: TyreStackSpot[];
  #meshes: Mesh[] = [];
  #prototypes: Mesh[] = [];
  #materials: PBRMaterial[] = [];
  #axis = new Vector3();
  #swing = new Quaternion();

  constructor(scene: Scene, config: SimConfig) {
    this.#spots = tyreStackSpots(config);
    if (this.#spots.length === 0) return;

    this.#prototypes = BUNDLE_COLOURS.map((colour, index) =>
      this.#buildPrototype(scene, colour, index),
    );

    this.#meshes = this.#spots.map((spot, index) => {
      const prototype = this.#prototypes[index % this.#prototypes.length];
      const mesh = prototype ? prototype.clone(`tyrestack:${index}`) : null;
      if (!mesh) throw new Error('tyre stack prototype missing');
      mesh.setEnabled(true);
      mesh.isPickable = false;
      mesh.position.set(spot.x, 0, spot.z);
      mesh.rotationQuaternion = Quaternion.Identity();
      return mesh;
    });
  }

  /** Moves every stack to its simulated position and derives the tumble. */
  sync(stacks: readonly RenderTyreStack[]): void {
    const count = Math.min(stacks.length, this.#meshes.length);
    for (let i = 0; i < count; i++) {
      const state = stacks[i];
      const mesh = this.#meshes[i];
      const spot = this.#spots[i];
      if (!state || !mesh || !spot) continue;

      mesh.position.x = state.x;
      mesh.position.z = state.z;

      const dx = state.x - spot.x;
      const dz = state.z - spot.z;
      const distance = Math.hypot(dx, dz);
      const rotation = mesh.rotationQuaternion;
      if (!rotation) continue;

      if (distance < 0.05) {
        // Home, or as good as: stand it up. A reset teleports stacks here,
        // so this is also what rebuilds the wall between rounds.
        mesh.position.y = 0;
        rotation.copyFromFloats(0, 0, 0, 1);
        continue;
      }

      // Tip away along the direction it was shoved, then keep rolling with
      // any further travel. All of it is a pure function of displacement, so
      // every peer agrees and no orientation ever needs to be synced.
      const tip = Math.min(1, distance / TOPPLE_DISTANCE);
      const angle = tip * TOPPLE_ANGLE + Math.max(0, distance - TOPPLE_DISTANCE) * ROLL_RATE;
      this.#axis.set(dz / distance, 0, -dx / distance);
      Quaternion.RotationAxisToRef(this.#axis, angle, this.#swing);
      rotation.copyFrom(this.#swing);
      mesh.position.y = Math.sin(Math.min(angle, TOPPLE_ANGLE)) * LYING_LIFT;
    }
  }

  /** Registers every stack as a shadow caster (cascade tier only). */
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

  /** Three tyres merged into one mesh, bottom tyre on the ground. */
  #buildPrototype(scene: Scene, colour: Color3, index: number): Mesh {
    const parts = TYRE_CENTRES.map((y, tier) => {
      const tyre = CreateTorus(
        `tyrestack:proto${index}:${tier}`,
        { diameter: TYRE_DIAMETER, thickness: TYRE_THICKNESS, tessellation: 10 },
        scene,
      );
      tyre.position.y = y;
      return tyre;
    });
    const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, false);
    const mesh = merged ?? (parts[0] as Mesh);
    mesh.name = `tyrestack:proto${index}`;

    const material = new PBRMaterial(`tyrestack:mat${index}`, scene);
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
