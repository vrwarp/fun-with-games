import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder.js';
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder.js';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder.js';
import { CreateTorus } from '@babylonjs/core/Meshes/Builders/torusBuilder.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Matrix } from '@babylonjs/core/Maths/math.vector.js';
import type { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js';
import type { Material } from '@babylonjs/core/Materials/material.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { SimConfig } from '../sim/config.js';
import { sampleTrack, trackLength, trackPoseAt } from '../sim/track.js';
import { createBoardTexture, createPineTexture } from './textures.js';

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

/**
 * The three trees this circuit is planted with.
 *
 * A tall narrow spruce, a broad low one, and something in between — the
 * SHAPES differ more than the colours, because silhouette is what separates
 * trees at the distance these are seen from. Each species draws its own card
 * texture, so the outlines differ too, not just the proportions.
 */
const TREE_SPECIES: ReadonlyArray<{ leaf: Color3; height: number; width: number }> = [
  { leaf: new Color3(0.16, 0.3, 0.14), height: 8.4, width: 4.4 },
  { leaf: new Color3(0.22, 0.34, 0.13), height: 6.2, width: 5.2 },
  { leaf: new Color3(0.18, 0.28, 0.17), height: 7.2, width: 4.8 },
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

/**
 * Placements at an even spacing along the whole lap, at a lateral offset.
 *
 * The barrier posts: unconditional, unlike `tyreWalls`, because a guardrail
 * has a post every few metres whether the road bends or not — and the posts
 * are what stop a hundred-metre barrier reading as one extruded slab.
 */
export function alongTrack(
  path: readonly { x: number; z: number }[],
  lap: number,
  offset: number,
  spacing: number,
): Placement[] {
  if (path.length < 2 || lap <= 0 || spacing <= 0) return [];
  const out: Placement[] = [];
  const steps = Math.max(4, Math.floor(lap / spacing));
  for (let i = 0; i < steps; i++) {
    const pose = trackPoseAt(path, (lap * i) / steps);
    out.push({
      x: pose.x + pose.dirZ * offset,
      z: pose.z - pose.dirX * offset,
      angle: Math.atan2(pose.dirX, pose.dirZ),
      scale: 1,
      tint: (i % 7) / 7,
    });
  }
  return out;
}

/**
 * Placements for advertising boards: along the straights, facing the road.
 *
 * The inverse of `tyreWalls`' filter — boards go where the road does NOT
 * bend, partly because that is where a circuit really mounts them and partly
 * because a board across a corner would hide the one thing a driver must see,
 * which is the corner. `side` picks which edge of the road; the boards yaw to
 * face back across it.
 */
export function boardRun(
  path: readonly { x: number; z: number }[],
  lap: number,
  offset: number,
  spacing: number,
  side: 1 | -1,
): Placement[] {
  if (path.length < 2 || lap <= 0 || spacing <= 0) return [];
  const out: Placement[] = [];
  const chord = 5;
  const steps = Math.max(4, Math.floor(lap / spacing));
  for (let i = 0; i < steps; i++) {
    const at = (lap * i) / steps;
    const behind = trackPoseAt(path, at - chord);
    const ahead = trackPoseAt(path, at + chord);
    const cross = behind.dirX * ahead.dirZ - behind.dirZ * ahead.dirX;
    const dot = behind.dirX * ahead.dirX + behind.dirZ * ahead.dirZ;
    if (Math.abs(Math.atan2(cross, dot)) > 0.09) continue;

    const pose = trackPoseAt(path, at);
    out.push({
      x: pose.x + pose.dirZ * side * offset,
      z: pose.z - pose.dirX * side * offset,
      // A plane faces its own +Z; yawing it to the road's heading turns its
      // face across the road for the right-hand side, and PI further round
      // for the left.
      angle: Math.atan2(pose.dirX, pose.dirZ) + (side > 0 ? Math.PI : 0),
      scale: 1,
      tint: (i % 5) / 5,
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
  #textures: DynamicTexture[] = [];
  /** Everything that should throw a shadow, for the renderer to register. */
  #casters: Mesh[] = [];

  constructor(scene: Scene, config: SimConfig) {
    if (!config.track.enabled || config.trackPath.length < 2) return;

    const path = config.trackPath;
    const lap = trackLength(path);
    const barrier = config.track.halfWidth + Math.max(config.track.barrierRunoff, 3);

    // Trees, planted well past the arena so the treeline stands above the
    // boundary wall instead of leaving it a bare grey band on the horizon.
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
    // Three species, split by each placement's tint so the mix is stable.
    TREE_SPECIES.forEach((species, index) => {
      const share = trees.filter((tree) => Math.floor(tree.tint * TREE_SPECIES.length) === index);
      const pine = this.#pine(scene, index, species);
      instance(pine, share);
      this.#casters.push(pine);
    });

    // Tyre walls on the outside of every real corner — and PAINTED, in the
    // red/white/blue bundles a real circuit wraps them in. All black they
    // read as licorice; the paint is what says "safety equipment".
    const bundleColours = [
      new Color3(0.55, 0.12, 0.1),
      new Color3(0.78, 0.78, 0.74),
      new Color3(0.09, 0.09, 0.1),
    ];
    const stacks = tyreWalls(path, lap, barrier - 0.6, 2.2);
    bundleColours.forEach((colour, index) => {
      const share = stacks.filter((_, i) => i % bundleColours.length === index);
      const stack = this.#tyreStack(
        scene,
        this.#material(scene, `scenery:tyres${index}`, colour, 0.75),
        index,
      );
      instance(stack, share);
      this.#casters.push(stack);
    });

    // Guardrail posts, one every few metres on both sides. They are what stop
    // a hundred-metre barrier reading as one extruded slab.
    const postMaterial = this.#material(scene, 'scenery:guard', new Color3(0.32, 0.34, 0.38), 0.55);
    const posts = [
      ...alongTrack(path, lap, barrier + 0.55, 4.2),
      ...alongTrack(path, lap, -(barrier + 0.55), 4.2),
    ];
    const post = this.#guardPost(scene, postMaterial);
    instance(post, posts);
    this.#casters.push(post);

    // Advertising boards along the straights, both sides, faces toward the
    // road. Two designs, alternated by placement so neighbours differ.
    const boardSpecs: Array<{ text: string; background: string; foreground: string }> = [
      { text: 'APEX AERO', background: '#d8dde2', foreground: '#16233c' },
      { text: 'VELOCE', background: '#b32531', foreground: '#f4f1ea' },
      { text: 'TARMAC PRO', background: '#12386b', foreground: '#e9edf3' },
    ];
    const runs = [
      ...boardRun(path, lap, barrier + 0.4, 7, 1),
      ...boardRun(path, lap, -(barrier + 0.4), 7, -1),
    ];
    boardSpecs.forEach((spec, index) => {
      const share = runs.filter((_, i) => i % boardSpecs.length === index);
      const board = this.#board(scene, spec);
      instance(board, share);
      this.#casters.push(board);
    });

    // Marshal posts, sparser than the corners so they read as punctuation.
    const marshal = this.#marshalPost(
      scene,
      this.#material(scene, 'scenery:post', new Color3(0.55, 0.56, 0.6), 0.6),
    );
    instance(
      marshal,
      tyreWalls(path, lap, barrier + 2.2, 26).map((placement) => ({ ...placement, scale: 1 })),
    );
    this.#casters.push(marshal);
  }

  /**
   * Registers everything here as a shadow caster.
   *
   * Called by the renderer, and only on the tier that can afford it: a
   * treeline throwing long shadows across the road is one of the strongest
   * "outdoors" cues there is, and also several hundred extra draws into the
   * shadow map.
   */
  addCastersTo(shadows: { addShadowCaster(mesh: Mesh): void }): void {
    for (const mesh of this.#casters) {
      if (!mesh.isDisposed()) shadows.addShadowCaster(mesh);
    }
  }

  dispose(): void {
    for (const mesh of this.#meshes) mesh.dispose();
    for (const material of this.#materials) material.dispose();
    for (const texture of this.#textures) texture.dispose();
    this.#meshes = [];
    this.#materials = [];
    this.#textures = [];
    this.#casters = [];
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

  /**
   * A conifer as three alpha-cut cards: two crossed uprights and one
   * horizontal cap.
   *
   * This replaced stacked cones, and the reason is the silhouette: a cone is
   * geometry pretending to be a tree, a drawn card IS the tree's outline,
   * ragged fronds and all. The cap card exists because the isometric camera
   * looks DOWN, which collapses crossed uprights into a thin X — from above
   * you see the cap's radial fronds instead.
   */
  #pine(
    scene: Scene,
    index: number,
    species: { leaf: Color3; height: number; width: number },
  ): Mesh {
    const side = createPineTexture(scene, index * 17 + 3, {
      r: species.leaf.r,
      g: species.leaf.g,
      b: species.leaf.b,
    });
    this.#textures.push(side);

    // Three uprights at sixty degrees, and NO horizontal cap. A cap card is
    // the textbook answer for cameras that look straight down, but seen from
    // anywhere near the ground it becomes a smeared line slicing every tree
    // in half — and this game's cameras live near the ground. Three oblique
    // cards stay oblique from the isometric camera too (it looks down at 53
    // degrees, not 90), which is volume enough.
    const material = this.#foliage(scene, `scenery:pine${index}`, side);
    const cards = [0, Math.PI / 3, (Math.PI * 2) / 3].map((yaw, i) => {
      const card = CreatePlane(
        `scenery:pinecard${index}:${i}`,
        { width: species.width, height: species.height },
        scene,
      );
      card.rotation.y = yaw;
      card.position.y = species.height / 2;
      card.bakeCurrentTransformIntoVertices();
      card.material = material;
      return card;
    });

    const merged = Mesh.MergeMeshes(cards, true, true, undefined, false, false);
    if (!merged) return this.#keep(cards[0] as Mesh);
    merged.name = `scenery:pine${index}`;
    merged.material = material;
    return this.#keep(merged);
  }

  /** The material a foliage card wants: alpha-cut, matte, lit from both sides. */
  #foliage(scene: Scene, name: string, texture: DynamicTexture): PBRMaterial {
    const material = new PBRMaterial(name, scene);
    material.albedoTexture = texture;
    texture.hasAlpha = true;
    material.useAlphaFromAlbedoTexture = true;
    material.transparencyMode = PBRMaterial.MATERIAL_ALPHATEST;
    material.alphaCutOff = 0.4;
    material.metallic = 0;
    material.roughness = 1;
    // A card has no thickness, so it must light from either face — and the
    // specular lobe is killed outright, because a glinting flat quad is what
    // gives the card trick away.
    material.backFaceCulling = false;
    material.twoSidedLighting = true;
    material.specularIntensity = 0.05;
    this.#materials.push(material);
    return material;
  }

  /** Three tyres on their side, stacked, with a soft paint-band variation. */
  #tyreStack(scene: Scene, material: Material, index: number): Mesh {
    const parts = [0.35, 0.95, 1.55].map((y, tier) => {
      const tyre = CreateTorus(
        `scenery:tyre${index}:${tier}`,
        { diameter: 1.15, thickness: 0.42, tessellation: 10 },
        scene,
      );
      tyre.position.y = y;
      return tyre;
    });
    const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, false);
    if (!merged) return this.#keep(parts[0] as Mesh);
    merged.name = `scenery:tyres${index}`;
    merged.material = material;
    return this.#keep(merged);
  }

  /** One guardrail post: a dark upright with a shallow cap. */
  #guardPost(scene: Scene, material: Material): Mesh {
    const mesh = CreateBox('scenery:guardpost', { width: 0.16, height: 1.15, depth: 0.22 }, scene);
    mesh.position.y = 0.55;
    mesh.bakeCurrentTransformIntoVertices();
    mesh.material = material;
    return this.#keep(mesh);
  }

  /**
   * One advertising board, standing on the barrier line.
   *
   * Two one-sided planes back to back, not one two-sided plane: a two-sided
   * plane shows its texture MIRRORED from behind, and half the boards on a
   * circuit are seen from behind. A real board's back is blank steel, so the
   * back here is one.
   */
  #board(scene: Scene, spec: { text: string; background: string; foreground: string }): Mesh {
    const texture = createBoardTexture(scene, spec.text, spec.background, spec.foreground);
    this.#textures.push(texture);

    const material = new PBRMaterial(`scenery:board:${spec.text}`, scene);
    material.albedoTexture = texture;
    material.metallic = 0;
    material.roughness = 0.5;
    this.#materials.push(material);

    const backing = this.#material(
      scene,
      `scenery:board:${spec.text}:back`,
      new Color3(0.3, 0.31, 0.34),
      0.6,
    );

    const face = CreatePlane('scenery:board', { width: 5.6, height: 1.05 }, scene);
    face.position.y = 1.72;
    face.bakeCurrentTransformIntoVertices();
    face.material = material;

    const back = CreatePlane('scenery:board:back', { width: 5.6, height: 1.05 }, scene);
    back.rotation.y = Math.PI;
    back.position.y = 1.72;
    back.bakeCurrentTransformIntoVertices();
    back.material = backing;

    const legs = CreateBox('scenery:board:leg', { width: 5.2, height: 0.5, depth: 0.08 }, scene);
    legs.position.y = 0.95;
    legs.bakeCurrentTransformIntoVertices();
    legs.material = backing;

    const merged = Mesh.MergeMeshes([face, back, legs], true, true, undefined, false, true);
    if (!merged) return this.#keep(face);
    merged.name = 'scenery:board';
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
