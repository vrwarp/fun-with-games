import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder.js';
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder.js';
import { CreateTorus } from '@babylonjs/core/Meshes/Builders/torusBuilder.js';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { Material } from '@babylonjs/core/Materials/material.js';
import type { Scene } from '@babylonjs/core/scene.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';

/**
 * A racing car, built out of about forty primitives and merged into five.
 *
 * ## Why this replaced five boxes
 *
 * The previous car was a box for the body, a box for the nose, a box for the
 * airbox, two boxes for wings and four cylinders for wheels. It read as a car
 * only because it was car-COLOURED and pointing the right way. No amount of
 * lighting, tone mapping or post-processing fixes that, and reaching for those
 * first was the wrong order — the silhouette is what the eye reads before
 * anything else, and at speed on a small screen it is very nearly all it reads.
 *
 * ## Detail is not the same as cost
 *
 * The counter-intuitive part, and the reason this is affordable on a phone:
 * **more geometry here means FEWER draw calls than before.** Forty primitives
 * are built, positioned, and then merged by material into five meshes — paint,
 * carbon, rubber, polished metal, and the rear wing flap, which stays separate
 * only because DRS has to move it. Five is less than the nine the boxes cost.
 *
 * A GPU does not care about triangles at this scale; it cares about state
 * changes. Ten thousand triangles in one buffer is cheaper than nine boxes in
 * nine buffers, and that is the whole budget argument for building the car
 * properly rather than crudely.
 *
 * ## Everything is derived from `playerRadius`
 *
 * The simulation collides a circle of `playerRadius`, so a car drawn to any
 * other scale is a car that fits through gaps it visually should not. Every
 * number below is a multiple of `r` for that reason, exactly as the boxes were.
 *
 * The body points along +Z, matching `heading = atan2(vx, vz)`.
 */

/** The materials a car is assembled from. One merged mesh comes out of each. */
export interface CarMaterials {
  /** The livery. Per car, because it carries the player's colour. */
  readonly paint: Material;
  /** Carbon fibre: wings, floor, suspension. Shared between cars. */
  readonly carbon: Material;
  /** Tyres. Shared. */
  readonly rubber: Material;
  /** The exhaust. Shared. */
  readonly metal: Material;
  /**
   * Wheel rims and spokes. Per CAR, not shared, because the rims are the brake
   * glow: their emissive is driven by that car's own deceleration, and a
   * shared material would glow every rim on the grid when anyone braked.
   */
  readonly wheelMetal: Material;
}

/** One corner of the car, live: the parts of a wheel that move. */
export interface CarWheel {
  /**
   * Steers. Sits at the wheel's centre, so yawing it is the upright turning
   * about its kingpin rather than the wheel swinging on an arm.
   */
  readonly pivot: TransformNode;
  /** Spins, about its own X axis — the axle. */
  readonly mesh: Mesh;
  /** Front wheels steer; rears only spin. */
  readonly front: boolean;
  /** Rolling radius, for turning speed into spin. */
  readonly radius: number;
}

export interface CarMesh {
  /** The painted bodywork, and the mesh the rest of the game treats as "body". */
  readonly chassis: Mesh;
  /** The rear wing flap. Kept separate so DRS can lay it flat. */
  readonly wing: Mesh;
  /**
   * The sprung mass: everything except the wheels hangs under this, so the
   * body can pitch under braking and roll in a corner while the wheels stay
   * planted on the road — which is what suspension IS, seen from outside.
   */
  readonly attitude: TransformNode;
  /** The four corners. */
  readonly wheels: readonly CarWheel[];
  /** Turns with the steering estimate, visible from the cockpit. */
  readonly steeringWheel: TransformNode;
  /** Everything else, for disposal and shadow registration. */
  readonly parts: Mesh[];
}

/** Segments round a wheel. Enough that a tyre reads as round, not as a nut. */
const WHEEL_SIDES = 18;

/**
 * Builds one car under `root`.
 *
 * `id` only names the meshes, which matters when reading a frame capture.
 */
export function buildCarMesh(
  scene: Scene,
  id: string,
  root: TransformNode,
  materials: CarMaterials,
  radius: number,
): CarMesh {
  const r = radius;
  // The root sits at the middle of a capsule's height; a car has to be put
  // back down on the road.
  const floor = -r * 1.7;

  // The sprung mass. Bodywork parents here; wheels parent to the root, so a
  // pitching body does not lift its own wheels off the ground.
  const attitude = new TransformNode(`${id}:attitude`, scene);
  attitude.parent = root;

  const paint: Mesh[] = [];
  const carbon: Mesh[] = [];
  const rubber: Mesh[] = [];
  const metal: Mesh[] = [];

  /** A box, placed. Every part below is one of these or a cylinder. */
  const box = (
    name: string,
    size: { w: number; h: number; d: number },
    at: { x: number; y: number; z: number },
    into: Mesh[],
  ): Mesh => {
    const mesh = CreateBox(
      `${id}:${name}`,
      { width: size.w, height: size.h, depth: size.d },
      scene,
    );
    mesh.position.set(at.x, floor + at.y, at.z);
    into.push(mesh);
    return mesh;
  };

  /** A cylinder lying along an axis, which is how every round part here sits. */
  const tube = (
    name: string,
    spec: { top: number; bottom: number; height: number; sides?: number },
    at: { x: number; y: number; z: number },
    axis: 'x' | 'y' | 'z',
    into: Mesh[],
  ): Mesh => {
    const mesh = CreateCylinder(
      `${id}:${name}`,
      {
        diameterTop: spec.top,
        diameterBottom: spec.bottom,
        height: spec.height,
        tessellation: spec.sides ?? 12,
      },
      scene,
    );
    // Cylinders stand up Y by default.
    if (axis === 'x') mesh.rotation.z = Math.PI / 2;
    if (axis === 'z') mesh.rotation.x = Math.PI / 2;
    mesh.position.set(at.x, floor + at.y, at.z);
    into.push(mesh);
    return mesh;
  };

  // --- Nose ------------------------------------------------------------------
  // Tapered, and this single shape does more for the silhouette than anything
  // else on the car: a blunt front end reads as a brick from any distance.
  tube(
    'nosecone',
    { top: r * 0.24, bottom: r * 0.62, height: r * 2.1, sides: 10 },
    { x: 0, y: r * 0.52, z: r * 2.5 },
    'z',
    paint,
  );
  // The tip, rounded off. A cone that ends in a flat disc catches the light as
  // a bright circle and gives the whole nose away.
  const tip = CreateSphere(`${id}:nosetip`, { diameter: r * 0.24, segments: 8 }, scene);
  tip.position.set(0, floor + r * 0.52, r * 3.55);
  paint.push(tip);

  // --- Monocoque -------------------------------------------------------------
  // Six-sided rather than square: a tub is a moulded shell and the chamfers
  // are what catch the sun along the flank.
  tube(
    'tub',
    { top: r * 0.95, bottom: r * 0.95, height: r * 2.6, sides: 6 },
    { x: 0, y: r * 0.6, z: r * 1.0 },
    'z',
    paint,
  );

  // --- Sidepods --------------------------------------------------------------
  // Tapering inward toward the back, which is the "coke bottle" shape every
  // racing car has and the thing that makes it look designed rather than
  // extruded.
  for (const side of [1, -1]) {
    // A tapered tube rather than a box, because the taper is the point: the
    // pod is wide at the inlet and pinched to nothing at the back, and that
    // waist is what stops a car looking like a brick with wheels.
    tube(
      `sidepod${side}`,
      { top: r * 0.72, bottom: r * 0.3, height: r * 1.9, sides: 6 },
      { x: side * r * 0.74, y: r * 0.5, z: 0 },
      'z',
      paint,
    );

    // The inlet, dark and recessed.
    box(
      `inlet${side}`,
      { w: r * 0.4, h: r * 0.42, d: r * 0.12 },
      { x: side * r * 0.74, y: r * 0.5, z: r * 0.94 },
      carbon,
    );
  }

  // --- Airbox and engine cover ----------------------------------------------
  // `top` is the +Z end once the tube is laid down, so it is the FRONT: an
  // airbox is a mouth at the front that narrows toward the engine behind it.
  tube(
    'airbox',
    { top: r * 0.62, bottom: r * 0.46, height: r * 0.6, sides: 8 },
    { x: 0, y: r * 1.32, z: -r * 0.5 },
    'z',
    paint,
  );
  // The intake mouth: a dark disc set into the front of the airbox.
  tube(
    'intake',
    { top: r * 0.34, bottom: r * 0.34, height: r * 0.1, sides: 10 },
    { x: 0, y: r * 1.34, z: -r * 0.22 },
    'z',
    carbon,
  );
  // Engine cover, tapering to a point over the gearbox.
  tube(
    'cover',
    { top: r * 0.72, bottom: r * 0.22, height: r * 2.1, sides: 8 },
    { x: 0, y: r * 1.0, z: -r * 1.75 },
    'z',
    paint,
  );

  // --- Halo ------------------------------------------------------------------
  // The single most recognisable thing on a modern car, and one torus.
  const halo = CreateTorus(
    `${id}:halo`,
    { diameter: r * 1.15, thickness: r * 0.11, tessellation: 16 },
    scene,
  );
  // A torus is already flat in XZ, which is how a halo sits — a ring around the
  // cockpit opening, not a hoop the driver looks through. Tipped up at the
  // front by the same few degrees the real one is.
  halo.rotation.x = -0.14;
  halo.position.set(0, floor + r * 1.1, r * 0.6);
  carbon.push(halo);
  box(
    'halopost',
    { w: r * 0.1, h: r * 0.4, d: r * 0.1 },
    { x: 0, y: r * 0.94, z: r * 1.16 },
    carbon,
  );

  // --- Floor and diffuser ----------------------------------------------------
  // Narrower than the track width on purpose: the floor runs the length of the
  // car, past both axles, so anything wider than the gap between the tyres
  // would grow through them.
  box('floor', { w: r * 1.28, h: r * 0.08, d: r * 4.3 }, { x: 0, y: r * 0.14, z: r * 0.3 }, carbon);
  const diffuser = box(
    'diffuser',
    { w: r * 1.34, h: r * 0.42, d: r * 0.8 },
    { x: 0, y: r * 0.3, z: -r * 2.55 },
    carbon,
  );
  // Raked, which is what a diffuser IS.
  diffuser.rotation.x = -0.35;

  // --- Front wing ------------------------------------------------------------
  // Two elements and two endplates. A single flat plank reads as a shelf; the
  // gap between elements is what says "wing".
  box('fw:main', { w: r * 2.3, h: r * 0.07, d: r * 0.5 }, { x: 0, y: r * 0.2, z: r * 3.5 }, carbon);
  const flap = box(
    'fw:flap',
    { w: r * 2.2, h: r * 0.06, d: r * 0.34 },
    { x: 0, y: r * 0.34, z: r * 3.3 },
    carbon,
  );
  flap.rotation.x = 0.22;
  for (const side of [1, -1]) {
    box(
      `fw:endplate${side}`,
      { w: r * 0.07, h: r * 0.42, d: r * 0.8 },
      { x: side * r * 1.15, y: r * 0.3, z: r * 3.4 },
      carbon,
    );
  }

  // --- Rear wing -------------------------------------------------------------
  for (const side of [1, -1]) {
    box(
      `rw:endplate${side}`,
      { w: r * 0.07, h: r * 0.62, d: r * 0.72 },
      { x: side * r * 0.92, y: r * 1.36, z: -r * 2.15 },
      carbon,
    );
  }
  box(
    'rw:pylon',
    { w: r * 0.12, h: r * 0.5, d: r * 0.3 },
    { x: 0, y: r * 1.2, z: -r * 2.2 },
    carbon,
  );
  box(
    'rw:main',
    { w: r * 1.85, h: r * 0.07, d: r * 0.52 },
    { x: 0, y: r * 1.5, z: -r * 2.15 },
    carbon,
  );

  // The flap DRS lays flat. Built last and kept out of every merge list.
  const wing = CreateBox(
    `${id}:rw:flap`,
    { width: r * 1.8, height: r * 0.07, depth: r * 0.4 },
    scene,
  );
  wing.position.set(0, floor + r * 1.66, -r * 2.3);

  // --- Exhaust ---------------------------------------------------------------
  tube(
    'exhaust',
    { top: r * 0.16, bottom: r * 0.2, height: r * 0.4, sides: 8 },
    { x: 0, y: r * 0.95, z: -r * 2.7 },
    'z',
    metal,
  );

  // --- Steering wheel --------------------------------------------------------
  // Small, near-vertical, and the only reason it exists is the cockpit camera:
  // a wheel that visibly counter-rotates through a corner is the strongest
  // "hands on the car" cue an onboard shot has, and it costs one torus.
  const column = new TransformNode(`${id}:column`, scene);
  column.parent = attitude;
  column.position.set(0, floor + r * 1.12, r * 0.98);
  // Tilted back toward the driver the way a real one rakes.
  column.rotation.x = -0.35;
  const steeringWheel = new TransformNode(`${id}:swheel`, scene);
  steeringWheel.parent = column;
  const rim = CreateTorus(
    `${id}:swheel:rim`,
    { diameter: r * 0.56, thickness: r * 0.055, tessellation: 12 },
    scene,
  );
  // A torus lies flat; stand it up to face the driver.
  rim.rotation.x = Math.PI / 2;
  rim.bakeCurrentTransformIntoVertices();
  rim.parent = steeringWheel;
  rim.material = materials.carbon;
  rim.isPickable = false;
  const spokeBar = CreateBox(
    `${id}:swheel:spoke`,
    { width: r * 0.5, height: r * 0.07, depth: r * 0.05 },
    scene,
  );
  spokeBar.parent = steeringWheel;
  spokeBar.material = materials.carbon;
  spokeBar.isPickable = false;

  // --- Wheels ----------------------------------------------------------------
  // Live, not merged into the bodywork: each corner is a pivot (which steers)
  // holding a wheel mesh (which spins). The wheel itself is still ONE mesh —
  // tyre, rim and spokes merged with their materials kept as submeshes — so a
  // corner costs a pivot and one mesh, not eight.
  const corners: Array<{ x: number; z: number; front: boolean }> = [
    { x: r * 0.95, z: r * 1.75, front: true },
    { x: -r * 0.95, z: r * 1.75, front: true },
    { x: r * 1.0, z: -r * 1.5, front: false },
    { x: -r * 1.0, z: -r * 1.5, front: false },
  ];

  // One prototype per axle — the pairs differ only in placement, and clones
  // share geometry.
  const frontProto = buildWheel(scene, `${id}:wheel:front`, r * 0.46, r * 0.46, r, materials);
  const rearProto = buildWheel(scene, `${id}:wheel:rear`, r * 0.55, r * 0.6, r, materials);

  const wheels: CarWheel[] = corners.map((corner, index) => {
    const proto = corner.front ? frontProto : rearProto;
    const mesh = index % 2 === 0 ? proto : proto.clone(`${proto.name}:${index}`);
    const tyreRadius = corner.front ? r * 0.46 : r * 0.55;

    const pivot = new TransformNode(`${id}:pivot${index}`, scene);
    pivot.parent = root;
    pivot.position.set(corner.x, floor + tyreRadius, corner.z);
    mesh.parent = pivot;
    mesh.position.setAll(0);
    mesh.isPickable = false;
    return { pivot, mesh, front: corner.front, radius: tyreRadius };
  });

  // Suspension: two wishbones per corner, angled in toward the tub. They stay
  // with the BODY: the mismatch as a wheel steers a few visual degrees is
  // invisible, and merging them keeps the corner at one mesh.
  for (const corner of corners) {
    const tyreRadius = corner.front ? r * 0.46 : r * 0.55;
    const side = Math.sign(corner.x);
    for (const level of [0.55, 1.05]) {
      const arm = CreateBox(
        `${id}:wishbone${corner.x}:${level}`,
        { width: Math.abs(corner.x) - r * 0.35, height: r * 0.07, depth: r * 0.1 },
        scene,
      );
      arm.position.set(
        corner.x - (side * (Math.abs(corner.x) - r * 0.35)) / 2,
        floor + tyreRadius * level,
        corner.z,
      );
      arm.rotation.y = side * 0.28;
      carbon.push(arm);
    }
  }

  // --- Merge -----------------------------------------------------------------
  // The whole budget argument. Forty primitives in; out come the body groups
  // plus one live mesh per wheel.
  const chassis = mergeInto(paint, `${id}:paint`, materials.paint, attitude);
  const parts: Mesh[] = [];
  for (const [group, material, name] of [
    [carbon, materials.carbon, 'carbon'],
    [rubber, materials.rubber, 'rubber'],
    [metal, materials.metal, 'metal'],
  ] as const) {
    const merged = mergeInto(group, `${id}:${name}`, material, attitude);
    if (merged) parts.push(merged);
  }
  parts.push(rim, spokeBar);
  for (const wheel of wheels) parts.push(wheel.mesh);

  wing.material = materials.carbon;
  wing.parent = attitude;
  wing.isPickable = false;

  return { chassis: chassis ?? wing, wing, attitude, wheels, steeringWheel, parts };
}

/**
 * One wheel, centred at the origin with its axle along X, as a single mesh.
 *
 * Tyre, rim and spokes are merged with `multiMultiMaterials`, which keeps each
 * source's material as a submesh instead of flattening them — so the wheel
 * stays one mesh while the tyre can be matte rubber and the rim can carry the
 * per-car brake glow. Built at the origin ON PURPOSE: the spin is
 * `mesh.rotation.x`, and a mesh that was merged in place would orbit the car
 * instead of turning on its axle.
 */
function buildWheel(
  scene: Scene,
  name: string,
  tyreRadius: number,
  width: number,
  r: number,
  materials: CarMaterials,
): Mesh {
  const lay = (mesh: Mesh): Mesh => {
    // Cylinders stand up Y; an axle lies along X. Baked, so the merged
    // vertices carry the orientation and the mesh's own rotation stays free
    // for the spin.
    mesh.rotation.z = Math.PI / 2;
    mesh.bakeCurrentTransformIntoVertices();
    return mesh;
  };

  const tyre = lay(
    CreateCylinder(
      `${name}:tyre`,
      { diameter: tyreRadius * 2, height: width, tessellation: WHEEL_SIDES },
      scene,
    ),
  );
  tyre.material = materials.rubber;

  const rim = lay(
    CreateCylinder(
      `${name}:rim`,
      { diameter: tyreRadius * 1.2, height: width * 1.02, tessellation: WHEEL_SIDES },
      scene,
    ),
  );
  rim.material = materials.wheelMetal;

  const spokes: Mesh[] = [];
  for (let spoke = 0; spoke < 5; spoke++) {
    const arm = CreateBox(
      `${name}:spoke${spoke}`,
      { width: width * 1.04, height: tyreRadius * 1.05, depth: r * 0.07 },
      scene,
    );
    arm.rotation.x = (spoke / 5) * Math.PI;
    arm.bakeCurrentTransformIntoVertices();
    arm.material = materials.wheelMetal;
    spokes.push(arm);
  }

  const merged = Mesh.MergeMeshes([tyre, rim, ...spokes], true, true, undefined, false, true);
  if (!merged) return tyre;
  merged.name = name;
  merged.isPickable = false;
  return merged;
}

/**
 * Merges a group into one mesh, parents it, and gives it its material.
 *
 * Merging AFTER positioning and BEFORE parenting is the order that works: the
 * merge bakes each source's world transform into the vertices, so anything
 * parented first would have the parent's transform baked in too and then have
 * it applied again.
 */
function mergeInto(
  meshes: Mesh[],
  name: string,
  material: Material,
  root: TransformNode,
): Mesh | null {
  if (meshes.length === 0) return null;
  const merged = Mesh.MergeMeshes(meshes, true, true, undefined, false, false);
  if (!merged) return null;
  merged.name = name;
  merged.material = material;
  merged.parent = root;
  merged.isPickable = false;
  // Merged geometry spans the whole car, so a bounding sphere fitted to it is
  // what culling should use — the default from the first source would be a
  // wheel.
  merged.refreshBoundingInfo();
  merged.position = Vector3.Zero();
  return merged;
}
