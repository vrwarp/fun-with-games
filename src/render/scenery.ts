import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder.js';
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder.js';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer.js';
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
 * Each kind is MERGED into a single static mesh: one draw call for the whole
 * forest, one for each tyre-bundle colour, one per board design. It was thin
 * instances, and the numbers never needed them — a forest of drawn cards is a
 * few thousand static triangles — and the cleverness turned out to carry a
 * bomb: any thin-instanced mesh in a fogged scene silently killed shadow
 * rendering for every OTHER mesh (Babylon 9.22, minimal repro: PBR receiver
 * + scene fog + one thin-instance batch). Fog and shadows are both
 * load-bearing; the instancing was not. Nothing here is created or destroyed
 * after startup.
 *
 * On the cascaded-shadow tier all of it casts — the treeline throwing shade
 * across the road is one of the strongest "outdoors" cues there is. The
 * blob-shadow tiers leave it out of the map so the cars keep their texels.
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
// The whole ramp sits ~25% LOWER than it first did, measured against the
// turf: the palest species used to reach 1.6x the grass value, so from the
// isometric camera a crown dissolved into the ground it stood on — what
// read as "see-through" up there was grass through a canopy with no value
// separation. A real treeline's canopy runs about half the turf's value.
const TREE_SPECIES: ReadonlyArray<{ leaf: Color3; height: number; width: number }> = [
  { leaf: new Color3(0.12, 0.23, 0.11), height: 8.4, width: 4.4 },
  { leaf: new Color3(0.17, 0.26, 0.1), height: 6.2, width: 5.2 },
  { leaf: new Color3(0.14, 0.21, 0.13), height: 7.2, width: 4.8 },
  // Two buckets whose job is VALUE, not shape: a markedly darker tall
  // spruce and a paler yellow-green mid. Five value steps across the stand
  // is what stops a hillside of trees averaging into one flat green — each
  // tree next to a different-toned neighbour reads as its own object.
  { leaf: new Color3(0.08, 0.16, 0.08), height: 9, width: 4.2 },
  { leaf: new Color3(0.2, 0.28, 0.12), height: 6.8, width: 5 },
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

      // Taper the wood toward the edge of the scatter instead of stopping
      // dead: a forest that ends on a line reads as the edge of the WORLD,
      // and the fog can only soften a silhouette, not explain one. Over the
      // last few cells the dropout rises until the rim is almost bare.
      const edge = Math.min(bounds.halfExtentX - Math.abs(x), bounds.halfExtentZ - Math.abs(z));
      const keep = Math.min(1, Math.max(0, edge / (cell * 3)));
      if (pick < 0.34 + (1 - keep) * 0.6) continue;

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
  // The chord must COVER the board (5.6m wide, so ±2.8 and change), and the
  // threshold is tight: a flat hoarding spanning even gentle curvature
  // sticks its corners across the rail line. Both numbers were looser once,
  // and the corners of every board near a curve entry poked through the
  // corrugated wall in front of it.
  const chord = 7;
  const steps = Math.max(4, Math.floor(lap / spacing));
  for (let i = 0; i < steps; i++) {
    const at = (lap * i) / steps;
    const behind = trackPoseAt(path, at - chord);
    const ahead = trackPoseAt(path, at + chord);
    const cross = behind.dirX * ahead.dirZ - behind.dirZ * ahead.dirX;
    const dot = behind.dirX * ahead.dirX + behind.dirZ * ahead.dirZ;
    if (Math.abs(Math.atan2(cross, dot)) > 0.05) continue;

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

/**
 * One pine, assembled: three alpha-cut cards over a bark trunk, merged.
 *
 * Exported so the dev inspection stage (`src/probe.ts`) builds EXACTLY the
 * tree the game plants — the stage exists to diagnose this assembly, and a
 * stage running a hand-copied variant would diagnose nothing.
 *
 * Two quiet decisions here, both measured on that stage:
 *
 * The cards are NOT the naive 0/60/120 fan. Three cards sharing one texture
 * on one axis collapse whenever two project at the same horizontal scale —
 * at bearings every 30 degrees the "three" cards sample identical texels
 * and become two, or one. So the second card is mirrored in U and the outer
 * two are nudged off-axis and off-height, which breaks the symmetry that
 * caused the collapse without adding a single fragment of fill.
 *
 * The card normals are blended toward a point on the trunk axis, so the
 * three flat planes shade like one rounded crown instead of three walls at
 * three brightnesses — the tiers without self-shadowing have nothing else
 * to round them.
 */
export function assemblePine(
  scene: Scene,
  index: number,
  species: { leaf: Color3; height: number; width: number },
  foliage: Material,
  bark: Material,
): Mesh | null {
  const cards = [0, Math.PI / 3, (Math.PI * 2) / 3].map((yaw, i) => {
    const card = CreatePlane(
      `scenery:pinecard${index}:${i}`,
      { width: species.width, height: species.height },
      scene,
    );
    card.rotation.y = yaw;
    // The outer two cards sit slightly SHORTER, not higher and lower:
    // vertical offsets were tried first and every tree grew a second and
    // third leader poking out beside the real one like antennae. Scaled
    // down, their tips tuck inside the crown and the off-height variation
    // survives where it helps — in the body.
    if (i > 0) card.scaling.y = 0.95;
    card.position.y = (species.height * (i > 0 ? 0.95 : 1)) / 2;
    if (i === 1) card.position.x += species.width * 0.1;
    if (i === 2) card.position.x -= species.width * 0.1;
    card.bakeCurrentTransformIntoVertices();
    if (i === 1) mirrorU(card);
    roundNormals(card, species.height);
    card.material = foliage;
    return card;
  });

  const trunk = CreateCylinder(
    `scenery:pinetrunk${index}`,
    {
      // Short: the skirt of the drawn canopy hangs to about a tenth of the
      // tree's height, and a trunk any taller pokes a brown pole up through
      // the crown — worst from the isometric camera, where it lay
      // diagonally across every tree.
      height: species.height * 0.22,
      diameterBottom: species.height * 0.055,
      diameterTop: species.height * 0.03,
      tessellation: 7,
    },
    scene,
  );
  trunk.position.y = species.height * 0.11;
  trunk.bakeCurrentTransformIntoVertices();
  trunk.material = bark;

  return Mesh.MergeMeshes([...cards, trunk], true, true, undefined, false, true);
}

/** Flips a mesh's U coordinates, so a shared texture reads mirrored. */
function mirrorU(mesh: Mesh): void {
  const uvs = mesh.getVerticesData(VertexBuffer.UVKind);
  if (!uvs) return;
  const flipped = Float32Array.from(uvs);
  for (let i = 0; i < flipped.length; i += 2) flipped[i] = 1 - (flipped[i] ?? 0);
  mesh.setVerticesData(VertexBuffer.UVKind, flipped);
}

/** Blends a card's normals toward radial-from-the-axis, rounding the shading. */
function roundNormals(mesh: Mesh, height: number): void {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  const normals = mesh.getVerticesData(VertexBuffer.NormalKind);
  if (!positions || !normals) return;
  const blended = Float32Array.from(normals);
  for (let i = 0; i < positions.length; i += 3) {
    const px = positions[i] ?? 0;
    const py = positions[i + 1] ?? 0;
    const pz = positions[i + 2] ?? 0;
    const rx = px;
    const ry = (py - height * 0.45) * 0.4;
    const rz = pz;
    const radial = Math.hypot(rx, ry, rz) || 1;
    const nx = (normals[i] ?? 0) * 0.4 + (rx / radial) * 0.6;
    const ny = (normals[i + 1] ?? 0) * 0.4 + (ry / radial) * 0.6;
    const nz = (normals[i + 2] ?? 1) * 0.4 + (rz / radial) * 0.6;
    const length = Math.hypot(nx, ny, nz) || 1;
    blended[i] = nx / length;
    blended[i + 1] = ny / length;
    blended[i + 2] = nz / length;
  }
  mesh.setVerticesData(VertexBuffer.NormalKind, blended);
}

/**
 * Applies a placement list by MERGING transformed copies into one mesh.
 *
 * This used to be thin instances, and the numbers never justified them: a
 * whole forest of drawn cards is a few thousand STATIC triangles, which is
 * one merged mesh and one draw call with nothing clever left to go wrong.
 * What forced the change was clever going wrong: with any thin-instanced
 * mesh in the scene, turning on scene fog silently killed shadow rendering
 * for every other mesh (Babylon 9.22, reproduced minimally — PBR receiver +
 * fog + one thin-instance batch; opaque or alpha-tested alike). Fog and
 * shadows are both load-bearing here; the instancing was not.
 *
 * Returns the merged batch, or null when there was nothing to place. The
 * prototype is consumed either way.
 */
function instance(mesh: Mesh, placements: readonly Placement[], lift = 0): Mesh | null {
  if (placements.length === 0) {
    mesh.dispose();
    return null;
  }
  const copies = placements.map((placement, index) => {
    const copy = mesh.clone(`${mesh.name}:${index}`);
    // Scale, then yaw, then move. Everything here stands upright, so a
    // quaternion would be machinery for a single angle.
    copy.scaling.setAll(placement.scale);
    copy.rotation.y = placement.angle;
    copy.position.set(placement.x, lift, placement.z);
    copy.computeWorldMatrix(true);
    return copy;
  });
  const name = mesh.name;
  mesh.dispose();
  // `multiMultiMaterials` keeps each source's material split as submeshes,
  // which is what lets a textured board face and its blank steel back merge
  // into the same batch without the text bleeding through the back.
  const merged = Mesh.MergeMeshes(copies, true, true, undefined, false, true);
  if (!merged) return null;
  merged.name = name;
  merged.isPickable = false;
  merged.receiveShadows = false;
  return merged;
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
  /** One bark material shared by every species' trunk. */
  #bark: PBRMaterial | null = null;

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
      const pines = instance(this.#pine(scene, index, species), share);
      if (pines) this.#casters.push(this.#keep(pines));
    });

    // The tyre walls are NOT here any more. A stack is a body the cars can
    // hit — simulated, snapshotted, and drawn by `TyreStackView` from the
    // live state on every device — so it cannot live behind the dressing
    // gate with the props that are only ever looked at.

    // Guardrail posts, one every few metres on both sides. They are what stop
    // a hundred-metre barrier reading as one extruded slab.
    const postMaterial = this.#material(scene, 'scenery:guard', new Color3(0.32, 0.34, 0.38), 0.55);
    const posts = [
      ...alongTrack(path, lap, barrier + 0.55, 4.2),
      ...alongTrack(path, lap, -(barrier + 0.55), 4.2),
    ];
    const postRun = instance(this.#guardPost(scene, postMaterial), posts);
    if (postRun) this.#casters.push(this.#keep(postRun));

    // Advertising boards along the straights, both sides, faces toward the
    // road. Two designs, alternated by placement so neighbours differ.
    const boardSpecs: Array<{ text: string; background: string; foreground: string }> = [
      { text: 'APEX AERO', background: '#d8dde2', foreground: '#16233c' },
      { text: 'VELOCE', background: '#b32531', foreground: '#f4f1ea' },
      { text: 'TARMAC PRO', background: '#12386b', foreground: '#e9edf3' },
    ];
    // A metre behind the rail, not flush against it: the wall ribbon bends
    // smoothly while a board is flat, and near the entry to a curve the two
    // normals disagree by enough centimetres to push a flush board's corner
    // through the corrugation.
    const runs = [
      ...boardRun(path, lap, barrier + 1, 7, 1),
      ...boardRun(path, lap, -(barrier + 1), 7, -1),
    ];
    boardSpecs.forEach((spec, index) => {
      const share = runs.filter((_, i) => i % boardSpecs.length === index);
      const boards = instance(this.#board(scene, spec), share);
      if (boards) this.#casters.push(this.#keep(boards));
    });

    // Marshal posts, sparser than the corners so they read as punctuation.
    const marshalSpots = tyreWalls(path, lap, barrier + 2.2, 26).map((placement) => ({
      ...placement,
      scale: 1,
    }));
    const marshals = instance(
      this.#marshalPost(
        scene,
        this.#material(scene, 'scenery:post', new Color3(0.55, 0.56, 0.6), 0.6),
      ),
      marshalSpots,
    );
    if (marshals) this.#casters.push(this.#keep(marshals));

    // Contact shadows: a soft dark disc under everything that stands. One
    // merged batch, one draw. Cheaper than ambient occlusion and better at
    // the one thing that matters — saying "this object is ON the ground,
    // not floating near it" — because it works on every tier and never
    // depends on a screen-space pass finding the geometry.
    this.#contacts(scene, [
      ...trees.map((tree) => ({ ...tree, radius: 1.7 * tree.scale })),
      ...posts.map((post) => ({ ...post, radius: 0.4 })),
      ...runs.map((run) => ({ ...run, radius: 2.6 })),
      ...marshalSpots.map((spot) => ({ ...spot, radius: 0.9 })),
    ]);
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

  /**
   * Whether the dressing also RECEIVES shadows.
   *
   * On the cascade tier trees shade trees, and that is what turns the wood
   * from a flat green mass into a volume — every card in it used to resolve
   * to the same lambert value. The blob tiers keep it off: their map has no
   * scenery in it, so sampling it from hundreds of cards would spend
   * fragment work to learn nothing.
   */
  setReceiveShadows(on: boolean): void {
    for (const mesh of this.#meshes) {
      if (!mesh.isDisposed()) mesh.receiveShadows = on;
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

  /** One merged batch of soft dark discs under every placement. */
  #contacts(scene: Scene, spots: ReadonlyArray<Placement & { radius: number }>): void {
    if (spots.length === 0) return;

    const size = 64;
    const texture = new DynamicTexture(
      'scenery:contact',
      { width: size, height: size },
      scene,
      false,
    );
    texture.hasAlpha = true;
    const ctx = texture.getContext() as unknown as CanvasRenderingContext2D;
    const half = size / 2;
    const gradient = ctx.createRadialGradient(half, half, 2, half, half, half);
    gradient.addColorStop(0, 'rgba(8, 10, 8, 0.5)');
    gradient.addColorStop(0.65, 'rgba(8, 10, 8, 0.2)');
    gradient.addColorStop(1, 'rgba(8, 10, 8, 0)');
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    texture.update();
    this.#textures.push(texture);

    const material = new StandardMaterial('scenery:contact:mat', scene);
    material.diffuseTexture = texture;
    material.useAlphaFromDiffuseTexture = true;
    material.emissiveColor = new Color3(0.05, 0.06, 0.05);
    material.disableLighting = true;
    material.zOffset = -0.1;
    material.backFaceCulling = false;
    this.#materials.push(material);

    const proto = CreatePlane('scenery:contact:proto', { size: 2 }, scene);
    proto.rotation.x = Math.PI / 2;
    proto.bakeCurrentTransformIntoVertices();
    proto.material = material;

    const copies = spots.map((spot, index) => {
      const copy = proto.clone(`scenery:contact:${index}`);
      copy.scaling.setAll(spot.radius);
      copy.position.set(spot.x, 0.015, spot.z);
      copy.computeWorldMatrix(true);
      return copy;
    });
    proto.dispose();
    const merged = Mesh.MergeMeshes(copies, true, true, undefined, false, false);
    if (!merged) return;
    merged.name = 'scenery:contacts';
    merged.isPickable = false;
    merged.receiveShadows = false;
    this.#keep(merged);
  }

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
    // Dark bark: once the canopy dropped below the turf's value, the old
    // brown was the brightest thing on the tree.
    if (!this.#bark) {
      this.#bark = this.#material(scene, 'scenery:bark', new Color3(0.14, 0.1, 0.07), 0.95);
    }
    const merged = assemblePine(scene, index, species, material, this.#bark);
    if (!merged) {
      const fallback = CreatePlane(
        `scenery:pine${index}`,
        { width: species.width, height: species.height },
        scene,
      );
      fallback.position.y = species.height / 2;
      fallback.bakeCurrentTransformIntoVertices();
      fallback.material = material;
      return this.#keep(fallback);
    }
    merged.name = `scenery:pine${index}`;
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

    // The sign sits with its bottom edge a clear quarter-metre above the
    // 1.1m rail in front of it, so from the cockpit's low eye the board
    // reads as mounted BEHIND the wall instead of growing out of it.
    const face = CreatePlane('scenery:board', { width: 5.6, height: 1.05 }, scene);
    face.position.y = 1.95;
    face.bakeCurrentTransformIntoVertices();
    face.material = material;

    const back = CreatePlane('scenery:board:back', { width: 5.6, height: 1.05 }, scene);
    back.rotation.y = Math.PI;
    back.position.y = 1.95;
    back.bakeCurrentTransformIntoVertices();
    back.material = backing;

    // Two posts that actually reach the ground. The first cut was a plate
    // spanning 0.7-1.2m, which left every hoarding floating on 70cm of air —
    // the kind of wrongness nobody names but everybody feels.
    const legs = [-2.2, 2.2].map((x, index) => {
      const leg = CreateBox(
        `scenery:board:leg${index}`,
        { width: 0.16, height: 1.5, depth: 0.1 },
        scene,
      );
      leg.position.set(x, 0.75, 0.02);
      leg.bakeCurrentTransformIntoVertices();
      leg.material = backing;
      return leg;
    });

    const merged = Mesh.MergeMeshes([face, back, ...legs], true, true, undefined, false, true);
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
