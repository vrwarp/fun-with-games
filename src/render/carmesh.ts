import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder.js';
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder.js';
import { CreateTorus } from '@babylonjs/core/Meshes/Builders/torusBuilder.js';
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
  // Tapered AND drooping: the axis falls toward the tip so the nose dives at
  // the front wing instead of spearing level through the air above it. The
  // droop is most of what separates a modern front end from a Sixties cigar.
  const nose = tube(
    'nosecone',
    { top: r * 0.18, bottom: r * 0.66, height: r * 1.4, sides: 10 },
    { x: 0, y: r * 0.51, z: r * 2.65 },
    'z',
    paint,
  );
  nose.rotation.x = Math.PI / 2 + 0.16;
  // The tip: a slim flat pad, not a ball and not a log end — a sphere
  // caught a klaxon specular head-on, and a wide facet read as sawn timber
  // from three-quarters.
  const tip = CreateBox(
    `${id}:nosetip`,
    { width: r * 0.16, height: r * 0.12, depth: r * 0.16 },
    scene,
  );
  tip.position.set(0, floor + r * 0.4, r * 3.36);
  tip.rotation.x = -0.16;
  paint.push(tip);
  // The shoulder where the drooping nose leaves the tub: the droop swings
  // the cone's base up off the tub's flat front face, and without a fairing
  // over the joint the front elevation shows the tub as a bare open ring.
  const shoulder = tube(
    'noseshoulder',
    { top: r * 0.62, bottom: r * 0.92, height: r * 0.7, sides: 6 },
    { x: 0, y: r * 0.58, z: r * 2.25 },
    'z',
    paint,
  );
  shoulder.rotation.x = Math.PI / 2 + 0.12;

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
  // extruded. The taper alone is not enough, though: the tails also converge
  // toward the centreline (yaw) and the bellies ride the floor all the way
  // back (pitch), so the waist shows in plan and nothing floats in profile.
  for (const side of [1, -1]) {
    // Pulled well inboard of the tyre faces: an open-wheeler read from
    // above is defined by how much naked tyre stands proud of the body.
    const pod = tube(
      `sidepod${side}`,
      { top: r * 0.68, bottom: r * 0.24, height: r * 2.35, sides: 6 },
      { x: side * r * 0.62, y: r * 0.43, z: -r * 0.53 },
      'z',
      paint,
    );
    pod.rotation.x = Math.PI / 2 - 0.11;
    pod.rotation.y = side * 0.16;

    // The inlet, dark and recessed, at the pod's fat front face.
    box(
      `inlet${side}`,
      { w: r * 0.42, h: r * 0.42, d: r * 0.14 },
      { x: side * r * 0.63, y: r * 0.52, z: r * 0.62 },
      carbon,
    );
  }

  // --- Airbox and engine cover ----------------------------------------------
  // `top` is the +Z end once the tube is laid down, so it is the FRONT: an
  // airbox is a mouth at the front that narrows toward the engine behind it.
  tube(
    'airbox',
    { top: r * 0.6, bottom: r * 0.44, height: r * 0.6, sides: 8 },
    { x: 0, y: r * 1.2, z: -r * 0.5 },
    'z',
    paint,
  );
  // The intake mouth: a dark disc set into the front of the airbox.
  tube(
    'intake',
    { top: r * 0.32, bottom: r * 0.32, height: r * 0.1, sides: 10 },
    { x: 0, y: r * 1.22, z: -r * 0.22 },
    'z',
    carbon,
  );
  // Engine cover: a FALLING wedge, not a level cigar. The spine drops from
  // the airbox toward a low tail that stops at the rear-wing plane, so the
  // wing stands alone above it instead of a muzzle poking out beneath.
  const cover = tube(
    'cover',
    { top: r * 0.72, bottom: r * 0.3, height: r * 2.0, sides: 8 },
    { x: 0, y: r * 0.84, z: -r * 1.55 },
    'z',
    paint,
  );
  cover.rotation.x = Math.PI / 2 - 0.21;

  // --- Halo ------------------------------------------------------------------
  // The single most recognisable thing on a modern car, and one torus.
  // 28 sides: the halo frames the driver's whole view in the cockpit, so
  // its facets are as close to the eye as the wheel's.
  const halo = CreateTorus(
    `${id}:halo`,
    { diameter: r * 1.1, thickness: r * 0.1, tessellation: 28 },
    scene,
  );
  // A torus is already flat in XZ, which is how a halo sits — a ring around
  // the cockpit opening, not a hoop the driver looks through. Barely tilted
  // and held ABOVE the cowl line: what a head-on view may show is the top
  // arc and the pillar, never a closed circle — a full ring face-on reads
  // as a wreath leaning against the airbox. (Rotation sign fixed by
  // measuring the rendered profile: positive x lowers the ring's +Z edge.)
  halo.rotation.x = 0.25;
  halo.position.set(0, floor + r * 1.26, r * 0.6);
  // Into the RUBBER merge on purpose: the tyre compound's near-black matte
  // grain is the closest material the car carries to real halo carbon, and
  // the glossy weave read as a chromed hula-hoop from every angle.
  rubber.push(halo);
  // The central pillar, from the tub up to the ring's front edge — the strut
  // the driver actually looks past, and the strut that holds the ring up.
  tube(
    'halopost',
    { top: r * 0.09, bottom: r * 0.11, height: r * 0.55, sides: 6 },
    { x: 0, y: r * 0.87, z: r * 1.05 },
    'y',
    rubber,
  );

  // --- Floor and diffuser ----------------------------------------------------
  // Narrower than the track width on purpose: the floor runs the length of the
  // car, past both axles, so anything wider than the gap between the tyres
  // would grow through them.
  box(
    'floor',
    { w: r * 1.28, h: r * 0.08, d: r * 4.65 },
    { x: 0, y: r * 0.14, z: r * 0.12 },
    carbon,
  );
  // The diffuser GROWS OUT of the floor: its front edge overlaps the floor
  // plate under the rear axle and the rake carries its trailing edge up
  // behind it. Detached, it read as a slab of debris being towed.
  const diffuser = box(
    'diffuser',
    { w: r * 1.34, h: r * 0.34, d: r * 0.8 },
    { x: 0, y: r * 0.33, z: -r * 2.3 },
    carbon,
  );
  // Raked, which is what a diffuser IS. The rake swings the box's corners,
  // so the height and seat are chosen to keep the lowest one just above the
  // contact plane — a floor below the tyres' ground line is not only wrong
  // in an elevation, it z-fights the track in game.
  diffuser.rotation.x = -0.35;
  // The exit cavity: a near-black inset in the diffuser's rear face, so the
  // rear elevation shows an upswept dark mouth instead of a flat bulkhead.
  const cavity = box(
    'diffuser:cavity',
    { w: r * 1.0, h: r * 0.3, d: r * 0.1 },
    { x: 0, y: r * 0.3, z: -r * 2.62 },
    rubber,
  );
  cavity.rotation.x = -0.35;

  // --- Front wing ------------------------------------------------------------
  // Two elements and two endplates, pulled BACK until the trailing edge
  // nearly kisses the front tyres — the gap a real wing leaves is air the
  // tyre needs, not daylight. A short central pylon marries it to the
  // drooped nose above; a wing that floats free of the nose reads as
  // arriving separately in the post.
  box(
    'fw:main',
    { w: r * 2.3, h: r * 0.07, d: r * 0.55 },
    { x: 0, y: r * 0.18, z: r * 3.2 },
    carbon,
  );
  const flap = box(
    'fw:flap',
    { w: r * 2.2, h: r * 0.06, d: r * 0.36 },
    { x: 0, y: r * 0.32, z: r * 3.04 },
    carbon,
  );
  flap.rotation.x = 0.22;
  box(
    'fw:pylon',
    { w: r * 0.14, h: r * 0.18, d: r * 0.3 },
    { x: 0, y: r * 0.3, z: r * 3.12 },
    carbon,
  );
  // Endplates capped LOW: in a pure profile every part of the wing projects
  // onto the same silhouette, and full-height plates entombed the dropped
  // nose tip the rest of the front end was rebuilt to show off.
  for (const side of [1, -1]) {
    box(
      `fw:endplate${side}`,
      { w: r * 0.07, h: r * 0.26, d: r * 0.85 },
      { x: side * r * 1.15, y: r * 0.2, z: r * 3.15 },
      carbon,
    );
  }

  // --- Tail fairing ----------------------------------------------------------
  // The gearbox bodywork between the sidepod tails and the wing pylon. Ends
  // the "wing on stilts" read: the pylon roots into this instead of air,
  // and the coke-bottle waist has something to converge onto.
  tube(
    'tail',
    { top: r * 0.5, bottom: r * 0.2, height: r * 1.05, sides: 6 },
    { x: 0, y: r * 0.55, z: -r * 1.87 },
    'z',
    paint,
  );

  // --- Rear wing -------------------------------------------------------------
  // One assembly, essentially over the axle: endplates just inside the rear
  // tyres carry the main plane and the DRS flap, a beam wing closes the
  // bottom against the diffuser's exit, and a single centre pylon roots the
  // lot into the tail fairing — daylight under the wing, but only a wing's
  // worth: the top plane clears the rear tyre by a fraction, not a storey.
  for (const side of [1, -1]) {
    box(
      `rw:endplate${side}`,
      { w: r * 0.07, h: r * 0.5, d: r * 0.7 },
      { x: side * r * 0.68, y: r * 1.15, z: -r * 2.3 },
      carbon,
    );
  }
  box(
    'rw:pylon',
    { w: r * 0.09, h: r * 0.45, d: r * 0.2 },
    { x: 0, y: r * 1.05, z: -r * 2.25 },
    carbon,
  );
  box(
    'rw:main',
    { w: r * 1.35, h: r * 0.07, d: r * 0.48 },
    { x: 0, y: r * 1.26, z: -r * 2.3 },
    carbon,
  );
  const beam = box(
    'rw:beam',
    { w: r * 1.25, h: r * 0.06, d: r * 0.32 },
    { x: 0, y: r * 0.78, z: -r * 2.28 },
    carbon,
  );
  beam.rotation.x = 0.25;

  // The flap DRS lays flat. Built last and kept out of every merge list.
  const wing = CreateBox(
    `${id}:rw:flap`,
    { width: r * 1.32, height: r * 0.06, depth: r * 0.36 },
    scene,
  );
  wing.position.set(0, floor + r * 1.37, -r * 2.44);

  // --- Exhaust ---------------------------------------------------------------
  // Low and tucked under the beam wing, where the tailpipe actually lives —
  // a mid-height exit past the wing reads as a stern cannon.
  tube(
    'exhaust',
    { top: r * 0.15, bottom: r * 0.18, height: r * 0.35, sides: 8 },
    { x: 0, y: r * 0.58, z: -r * 2.35 },
    'z',
    metal,
  );

  // --- Steering wheel --------------------------------------------------------
  // Small, near-vertical, and the only reason it exists is the cockpit camera:
  // a wheel that visibly counter-rotates through a corner is the strongest
  // "hands on the car" cue an onboard shot has, and it costs one torus.
  const column = new TransformNode(`${id}:column`, scene);
  column.parent = attitude;
  // Sunk INTO the cockpit, inside the halo's perimeter, below the cowl line:
  // from outside the car you should barely know it is there. It used to sit
  // proud of the bodywork like a Sixties roll hoop, and in the front
  // elevation it was the tallest thing on the car.
  // Placed by two constraints at once: low enough that the rim stays under
  // the cowl line in a side elevation, far enough forward and high enough
  // that the cockpit camera's bottom edge still catches it — the wheel's
  // whole purpose is counter-rotating in that view, and a first sinking of
  // it to please the elevation made it vanish from the cockpit entirely.
  column.position.set(0, floor + r * 0.95, r * 0.95);
  // Raked hard back toward the driver the way a real one is (negative tips
  // the wheel's top toward the seat — same measured convention as the halo).
  column.rotation.x = -0.6;
  const steeringWheel = new TransformNode(`${id}:swheel`, scene);
  steeringWheel.parent = column;
  // Tessellated far above the car's usual budget, because nothing else in
  // the game sits this close to a camera: the cockpit eye is centimetres
  // away, and at 12 sides the rim read as a dodecagonal nut in every frame.
  const rim = CreateTorus(
    `${id}:swheel:rim`,
    { diameter: r * 0.36, thickness: r * 0.045, tessellation: 36 },
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
    { width: r * 0.32, height: r * 0.06, depth: r * 0.05 },
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
  //
  // The axles sit far apart on purpose: wheels-at-the-corners is the single
  // strongest proportion cue a single-seater has, and the 18-inch era's other
  // signature is diameters within a few percent of each other — the rears
  // are WIDER, not taller. Big-rear stagger is a vintage tell.
  // Front wheels sit further outboard than the rears' centres so that with
  // their narrower section the OUTER faces line up in plan — a square
  // stance at both axles is the ground-effect era's footprint, and a
  // pigeon-toed front is what the old numbers read as from above.
  const corners: Array<{ x: number; z: number; front: boolean }> = [
    { x: r * 1.05, z: r * 2.15, front: true },
    { x: -r * 1.05, z: r * 2.15, front: true },
    { x: r * 0.98, z: -r * 1.95, front: false },
    { x: -r * 0.98, z: -r * 1.95, front: false },
  ];

  // One prototype per axle: equal diameters — the modern signature — with
  // the rears wider, and clones share geometry.
  const frontProto = buildWheel(scene, `${id}:wheel:front`, r * 0.55, r * 0.5, r, materials);
  const rearProto = buildWheel(scene, `${id}:wheel:rear`, r * 0.55, r * 0.65, r, materials);

  const wheels: CarWheel[] = corners.map((corner, index) => {
    const proto = corner.front ? frontProto : rearProto;
    const mesh = index % 2 === 0 ? proto : proto.clone(`${proto.name}:${index}`);
    const tyreRadius = r * 0.55;

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
    const tyreRadius = r * 0.55;
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
