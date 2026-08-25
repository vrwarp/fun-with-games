import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder.js';
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder.js';
import { CreateTorus } from '@babylonjs/core/Meshes/Builders/torusBuilder.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Matrix } from '@babylonjs/core/Maths/math.vector.js';
import type { Material } from '@babylonjs/core/Materials/material.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { SimConfig } from '../sim/config.js';
import { sampleTrack, trackLength, trackPoseAt } from '../sim/track.js';

/**
 * The world on the other side of the barrier.
 *
 * Until now the scene ended at the kerb: grass, then a grey wall, then sky. A
 * circuit drawn that way is a road on a plane, and no amount of work on the
 * road fixes it — what tells you a track is somewhere is the stuff you are not
 * looking at. Trees passing in your peripheral vision are most of what makes a
 * straight feel fast, and a stack of tyres on the outside of a corner is what
 * tells you which way it goes before you can see the apex.
 *
 * ## One draw call per kind, however many there are
 *
 * All of this is **thin instances**: one mesh, one material, one draw call, and
 * a buffer of transforms. Three hundred trees cost the GPU about what one tree
 * costs, which is the only reason a phone can have three hundred trees. Nothing
 * here is created or destroyed after startup.
 *
 * None of it casts shadows, and that is deliberate rather than lazy. The shadow
 * map is fitted to whatever casts into it, so admitting a treeline would stretch
 * it across the whole arena and leave each car a handful of texels — trading the
 * shadow that matters for hundreds that nobody looks at.
 *
 * ## Placement is a pure function
 *
 * `scatter` and `tyreWalls` take numbers and return positions, with no Babylon
 * anywhere near them. They are the part that can be wrong in ways a screenshot
 * hides — a tree in the middle of the racing line is obvious, a tree just
 * inside the track limit at the far end of the circuit is not — so they are
 * tested rather than looked at.
 */

/**
 * How far past the arena boundary scenery is planted, in world units.
 *
 * Chosen against the fog rather than the arena: far enough that the treeline
 * fades out rather than ending, close enough that nothing is drawn out where
 * the haze has already swallowed it.
 */
const SCENERY_REACH = 30;

/** One cone of foliage: how high its base sits, how wide and how tall it is. */
interface Tier {
  readonly y: number;
  readonly diameter: number;
  readonly height: number;
}

/**
 * The three trees this circuit is planted with.
 *
 * A tall narrow spruce, a broad low one, and something in between — chosen so
 * the SILHOUETTES differ, because that is what separates them at the distance
 * they are actually seen from. The colours differ too, but by less than the
 * shapes: a wood is not a paint chart.
 */
const TREE_SPECIES: ReadonlyArray<{ leaf: Color3; tiers: readonly Tier[] }> = [
  {
    leaf: new Color3(0.09, 0.2, 0.07),
    tiers: [
      { y: 3.2, diameter: 2.8, height: 3 },
      { y: 4.8, diameter: 2, height: 2.6 },
      { y: 6.1, diameter: 1.2, height: 2.2 },
    ],
  },
  {
    leaf: new Color3(0.13, 0.24, 0.08),
    tiers: [
      { y: 2.4, diameter: 4.2, height: 2.4 },
      { y: 3.6, diameter: 3.2, height: 2 },
      { y: 4.5, diameter: 2, height: 1.6 },
    ],
  },
  {
    leaf: new Color3(0.1, 0.19, 0.11),
    tiers: [
      { y: 2.9, diameter: 3.4, height: 2.6 },
      { y: 4.2, diameter: 2.5, height: 2.2 },
      { y: 5.3, diameter: 1.6, height: 1.9 },
    ],
  },
];

/** One instance: where it stands, which way it faces, how big it is. */
export interface Placement {
  readonly x: number;
  readonly z: number;
  /** Yaw, radians. */
  readonly angle: number;
  /** Multiplier on the prototype's size. */
  readonly scale: number;
  /**
   * A per-instance number in `[0, 1)`, for anything that should vary.
   *
   * Carried here rather than derived at the point of use so that one placement
   * gives the same tree the same size AND the same colour, every run.
   */
  readonly tint: number;
}

/** What `scatter` needs to know about the world. */
export interface ScatterBounds {
  readonly halfExtentX: number;
  readonly halfExtentZ: number;
  readonly trackPath: readonly { x: number; z: number }[];
  /** Nothing is placed closer than this to the centreline. */
  readonly clearance: number;
}

/**
 * Deterministic value in `[0, 1)` from two integers.
 *
 * `src/render` is not bound by the simulation's ban on randomness, but the
 * reasoning carries: scenery that differed between two runs could not be
 * compared in a screenshot, and scenery that differed between two peers would
 * mean two players describing different corners to each other.
 */
export function hashed(x: number, y: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Scatters instances over the arena, keeping clear of the road.
 *
 * A jittered grid rather than free random placement: uniform random points
 * clump, and clumped trees read as a mistake rather than as a wood. One
 * candidate per cell, pushed around inside its cell, gives even coverage that
 * still looks unplanned.
 *
 * Candidates that land on or near the track are dropped rather than moved. A
 * circuit folds back on itself, so a point twenty metres from one corner can be
 * on the racing line of another — and nudging a rejected point is how you end
 * up with a suspicious ring of trees hugging the barrier.
 */
export function scatter(bounds: ScatterBounds, cell: number, salt: number): Placement[] {
  const out: Placement[] = [];
  const columns = Math.floor((bounds.halfExtentX * 2) / cell);
  const rows = Math.floor((bounds.halfExtentZ * 2) / cell);

  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const jitterX = hashed(column + salt, row);
      const jitterZ = hashed(row, column + salt);
      const pick = hashed(column * 31 + salt, row * 17);
      // A third of the cells stay empty, so the spacing is not a lattice.
      if (pick < 0.34) continue;

      const x = -bounds.halfExtentX + (column + 0.15 + jitterX * 0.7) * cell;
      const z = -bounds.halfExtentZ + (row + 0.15 + jitterZ * 0.7) * cell;
      if (bounds.trackPath.length >= 2) {
        if (sampleTrack(bounds.trackPath, x, z).lateral < bounds.clearance) continue;
      }

      out.push({
        x,
        z,
        angle: hashed(column, row + salt) * Math.PI * 2,
        // Never uniform. A stand of identical trees reads as wallpaper, and
        // the range matters more than the mean.
        scale: 0.65 + hashed(column + 7, row + salt * 3) * 0.75,
        tint: hashed(column * 3 + 5, row * 5 + salt),
      });
    }
  }
  return out;
}

/**
 * Tyre-wall stacks, on the outside of the corners.
 *
 * Placed where the circuit actually bends, because that is where they exist in
 * life and because it makes them informative: a wall of tyres appearing on your
 * left is the circuit telling you the corner goes right. Straights get nothing,
 * which is what makes the corners read.
 *
 * Curvature comes from the turn in heading over a fixed chord. Sampling the
 * path's own vertices instead would measure how densely the circuit was
 * authored rather than how sharply it turns.
 */
export function tyreWalls(
  path: readonly { x: number; z: number }[],
  lap: number,
  offset: number,
  spacing: number,
): Placement[] {
  if (path.length < 2 || lap <= 0) return [];
  const out: Placement[] = [];
  const chord = 4;
  const steps = Math.max(4, Math.floor(lap / spacing));

  for (let i = 0; i < steps; i++) {
    const at = (lap * i) / steps;
    const behind = trackPoseAt(path, at - chord);
    const ahead = trackPoseAt(path, at + chord);
    // How much the road has turned over the chord, as a signed angle. The
    // cross product of the two unit directions is its sine and the dot is its
    // cosine, so `atan2` of the pair is the turn with no trigonometry on the
    // way in — and the sign is which way.
    const cross = behind.dirX * ahead.dirZ - behind.dirZ * ahead.dirX;
    const dot = behind.dirX * ahead.dirX + behind.dirZ * ahead.dirZ;
    const turn = Math.atan2(cross, dot);
    // Roughly ten degrees over eight metres. Below that it is a kink, and
    // lining a kink with tyres makes the real corners mean less.
    if (Math.abs(turn) < 0.18) continue;

    const pose = trackPoseAt(path, at);
    // Right of the road is `(dirZ, -dirX)`, the same convention `trackview.ts`
    // lays its kerbs with. A positive turn is a left-hander, whose outside is
    // the right — and the outside is the only side a tyre wall belongs on.
    const side = turn > 0 ? 1 : -1;
    out.push({
      x: pose.x + pose.dirZ * side * offset,
      z: pose.z - pose.dirX * side * offset,
      angle: Math.atan2(pose.dirX, pose.dirZ),
      scale: 1,
      tint: 0.5,
    });
  }
  return out;
}

/** Applies a placement list to a mesh as thin instances. */
function instance(mesh: Mesh, placements: readonly Placement[], lift = 0): void {
  if (placements.length === 0) {
    mesh.dispose();
    return;
  }
  const buffer = new Float32Array(placements.length * 16);
  placements.forEach((placement, index) => {
    // Scale, then yaw, then move. Everything here stands upright, so a
    // quaternion would be machinery for a single angle.
    const placed = Matrix.Scaling(placement.scale, placement.scale, placement.scale)
      .multiply(Matrix.RotationY(placement.angle))
      .multiply(Matrix.Translation(placement.x, lift, placement.z));
    placed.copyToArray(buffer, index * 16);
  });
  mesh.thinInstanceSetBuffer('matrix', buffer, 16);
  // The prototype's own bounds are one tree; the instances span the world, and
  // a mesh culled by the wrong bounds pops in and out as the camera turns.
  //
  // This used to also set `alwaysSelectAsActiveMesh`, which made the line above
  // pointless — asserting "never cull me" while carefully computing the bounds
  // culling would have used. Both were defensible on their own and together
  // they were just contradictory. The bounds win: a thin-instance batch is
  // culled all or nothing, and one that spans the world never will be, so the
  // frustum test costs a comparison per batch per frame and keeps the mesh
  // honest about where it is. (If the tree count ever justified it, the real
  // win would be splitting the scatter into spatial buckets so culling could
  // actually bite.)
  mesh.thinInstanceRefreshBoundingInfo(true);
  mesh.isPickable = false;
  mesh.receiveShadows = false;
}

/**
 * Everything standing beside the circuit.
 *
 * Built once and then simply exists — none of it moves, none of it reads
 * gameplay state, and none of it is asked a question by anything.
 */
export class Scenery {
  #meshes: Mesh[] = [];
  #materials: Material[] = [];

  constructor(scene: Scene, config: SimConfig) {
    if (!config.track.enabled || config.trackPath.length < 2) return;

    const path = config.trackPath;
    const lap = trackLength(path);
    const barrier = config.track.halfWidth + Math.max(config.track.barrierRunoff, 3);

    const bark = this.#material(scene, 'scenery:bark', new Color3(0.19, 0.14, 0.1), 0.92);
    // Lighter and glossier than a tyre on a car. These are seen against grass
    // in full sun rather than in a wheel arch, and at the darkest setting they
    // read as holes cut in the scenery rather than as objects.
    const rubber = this.#material(scene, 'scenery:rubber', new Color3(0.075, 0.075, 0.08), 0.82);
    const post = this.#material(scene, 'scenery:post', new Color3(0.55, 0.56, 0.6), 0.6);

    // Trees, well back from the road: far enough that leaving the circuit is
    // never a collision with scenery, close enough to stream past on a straight.
    // Just beyond the barrier, and that is a deliberate reading of where the
    // world ends. The barrier is already the visual limit and already collides
    // with nothing — a car that slides past it is off the map, not in a wood —
    // so the treeline may start where the barrier does. Any further out and
    // there is simply nowhere to stand: this circuit fills its arena, and at a
    // six-metre setback only nineteen trees fit anywhere at all, all of them in
    // the corners where nobody is looking.
    // Well PAST the arena, not just up to it. The boundary wall is a couple of
    // metres high and the ground now runs out to the fog, so trees planted
    // only inside the arena leave a bare grey band across the horizon in every
    // cockpit shot — the wall, with nothing behind it. Planting beyond puts a
    // treeline above the wall instead, which is what hides it.
    const trees = scatter(
      {
        halfExtentX: config.arenaHalfExtentX + SCENERY_REACH,
        halfExtentZ: config.arenaHalfExtentZ + SCENERY_REACH,
        trackPath: path,
        clearance: barrier + 3,
      },
      5,
      11,
    );
    instance(this.#trunk(scene, bark), trees);
    // Three species rather than one, and this is the difference between a wood
    // and wallpaper. A single prototype repeated four hundred times is found
    // out immediately however well it is drawn: the eye is very good at
    // spotting a repeated silhouette and rather bad at measuring a tree.
    //
    // The obvious cheap fix — one mesh, a colour per instance — did not take:
    // a thin-instance colour buffer needs the material to be set up to read
    // it, and rather than chase that, three prototypes cost two extra draw
    // calls and vary SHAPE as well as hue, which is the stronger signal.
    TREE_SPECIES.forEach((species, index) => {
      const share = trees.filter((tree) => Math.floor(tree.tint * TREE_SPECIES.length) === index);
      instance(
        this.#canopy(
          scene,
          this.#material(scene, `scenery:leaf${index}`, species.leaf, 0.88),
          species.tiers,
        ),
        share,
      );
    });

    // Tyre walls on the outside of every real corner.
    // Close enough together to form a continuous wall through a corner. A
    // stack every five metres reads as litter; every two reads as a barrier.
    instance(this.#tyreStack(scene, rubber), tyreWalls(path, lap, barrier - 0.6, 2.2));

    // Marshal posts, sparser than the corners so they read as punctuation.
    instance(
      this.#marshalPost(scene, post),
      tyreWalls(path, lap, barrier + 2.2, 26).map((placement) => ({ ...placement, scale: 1 })),
    );
  }

  dispose(): void {
    for (const mesh of this.#meshes) mesh.dispose();
    for (const material of this.#materials) material.dispose();
    this.#meshes = [];
    this.#materials = [];
  }

  // -------------------------------------------------------------- internals

  #material(scene: Scene, name: string, albedo: Color3, roughness: number): PBRMaterial {
    const material = new PBRMaterial(name, scene);
    material.albedoColor = albedo.toLinearSpace();
    material.metallic = 0;
    material.roughness = roughness;
    this.#materials.push(material);
    return material;
  }

  #keep(mesh: Mesh): Mesh {
    this.#meshes.push(mesh);
    return mesh;
  }

  #trunk(scene: Scene, material: Material): Mesh {
    const mesh = CreateCylinder(
      'scenery:trunk',
      { diameterTop: 0.28, diameterBottom: 0.45, height: 2.6, tessellation: 6 },
      scene,
    );
    mesh.position.y = 1.3;
    mesh.bakeCurrentTransformIntoVertices();
    mesh.material = material;
    return this.#keep(mesh);
  }

  /**
   * Foliage: three stacked cones, narrowing upward.
   *
   * One cone is a party hat. Three overlapping ones break the silhouette
   * enough that a tree reads as a tree at the distance these are actually
   * seen from, which is far.
   */
  #canopy(scene: Scene, material: Material, tiers: readonly Tier[]): Mesh {
    const parts = tiers.map((tier, index) => {
      const cone = CreateCylinder(
        `scenery:canopy${index}`,
        { diameterTop: 0, diameterBottom: tier.diameter, height: tier.height, tessellation: 7 },
        scene,
      );
      cone.position.y = tier.y;
      return cone;
    });
    const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, false);
    if (!merged) return this.#keep(parts[0] as Mesh);
    merged.name = 'scenery:canopy';
    merged.material = material;
    return this.#keep(merged);
  }

  /** Three tyres on their side, stacked. */
  #tyreStack(scene: Scene, material: Material): Mesh {
    const parts = [0.35, 0.95, 1.55].map((y, index) => {
      const tyre = CreateTorus(
        `scenery:tyre${index}`,
        { diameter: 1.15, thickness: 0.42, tessellation: 10 },
        scene,
      );
      tyre.position.y = y;
      return tyre;
    });
    const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, false);
    if (!merged) return this.#keep(parts[0] as Mesh);
    merged.name = 'scenery:tyres';
    merged.material = material;
    return this.#keep(merged);
  }

  /** A pole with a small platform: somewhere for a flag to be waved from. */
  #marshalPost(scene: Scene, material: Material): Mesh {
    const pole = CreateCylinder(
      'scenery:pole',
      { diameter: 0.16, height: 3.2, tessellation: 6 },
      scene,
    );
    pole.position.y = 1.6;
    const deck = CreateBox('scenery:deck', { width: 1.5, height: 0.16, depth: 1.2 }, scene);
    deck.position.y = 3.2;
    const merged = Mesh.MergeMeshes([pole, deck], true, true, undefined, false, false);
    if (!merged) return this.#keep(pole);
    merged.name = 'scenery:post';
    merged.material = material;
    return this.#keep(merged);
  }
}
