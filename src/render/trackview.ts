import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import type { Material } from '@babylonjs/core/Materials/material.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import { CreateRibbon } from '@babylonjs/core/Meshes/Builders/ribbonBuilder.js';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder.js';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer.js';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import type { Scene } from '@babylonjs/core/scene.js';

import type { SimConfig, TrackPoint } from '../sim/config.js';
import { sampleTrack, trackLength, trackPoseAt } from '../sim/track.js';
import { createKerbTexture, createStartLineTexture } from './textures.js';
import { asphalt, corrugation, createSurface, kerbRibs, type Surface } from './surfaces.js';

/**
 * Draws the circuit: tarmac, kerbs, the start/finish line, sector marks and
 * the DRS zones.
 *
 * Entirely static — a road does not move — so it is built once and then simply
 * exists. Every shape is derived from `SimConfig.trackPath`, the same list the
 * simulation uses to decide what counts as on-track, which is what keeps the
 * picture and the physics from disagreeing about where the road is. Nothing
 * here reads gameplay state or draws a gameplay conclusion.
 *
 * Everything is a **band**: a strip of road between two distances along the
 * centreline. Building all of it from one primitive is what makes a DRS zone
 * line up with the tarmac around a corner without any special-casing.
 *
 * Heights are hair's-breadth offsets rather than real thickness, because the
 * surface is flat in the simulation and anything with depth here would be a
 * lie a driver could hit. The ordering below is the paint order.
 */
const ROAD_Y = 0.02;
/** Texels per side of the generated asphalt. */
const ROAD_TEXTURE_SIZE = 256;
/** World units one tile of asphalt covers. Roughly a car's length. */
const ROAD_TILE = 6;
const DRS_Y = 0.05;
const KERB_Y = 0.08;
const LIMIT_Y = 0.095;
/** Where the laid-in rubber sits: on the road, under everything painted. */
const RUBBER_Y = 0.03;
const SECTOR_Y = 0.11;
const LINE_Y = 0.14;

/**
 * Depth bias per layer, in the order they are painted.
 *
 * Height alone is not enough. These surfaces are all but coplanar, and a
 * first-person camera looks *along* them from 1.35 units up — the worst case
 * for depth precision, where a few centimetres of separation at the far end of
 * a straight is less than the depth buffer can resolve and the road stripes
 * itself. A polygon offset biases the comparison rather than the geometry, so
 * the paint stays flat and still wins.
 */
const LAYER_BIAS = { rubber: -0.5, drs: -1, kerb: -2, limit: -2.5, sector: -3, line: -4 } as const;

/**
 * How far the ideal line moves toward the inside of a corner, as a fraction of
 * the half-width.
 *
 * Not all the way to the kerb: the strip has width of its own, and a racing
 * line whose outer edge hangs over the kerb reads as a mistake rather than as
 * commitment.
 */
const LINE_REACH = 0.62;
/** Half-width of the rubbered-in strip, in world units. */
const LINE_HALF_WIDTH = 0.85;
/**
 * Turn angle over the sampling chord at which a driver is fully committed to
 * the inside. About 26 degrees over twelve metres — a properly slow corner.
 */
const TURN_FULL = 0.45;
/**
 * Half-width of the line painted at each end of a DRS zone, in world units.
 *
 * Wider than it was, and carrying the brightness the fill gave up. Where a
 * zone BEGINS is the thing a driver has to see; that it continues is something
 * the HUD already says.
 */
const DRS_EDGE = 0.35;

/** Barrier height. Low enough to see the circuit over from the cockpit. */
const BARRIER_HEIGHT = 1.1;
/** How high the start gantry's beam sits. Tall enough for a car to pass under. */
const GANTRY_HEIGHT = 5.5;

/**
 * The ribbons are built `sideOrientation: 2`, which bakes both facings into
 * the geometry. Culling back faces therefore still leaves every surface
 * visible from anywhere — and stops each one being drawn twice, which on a
 * translucent overlay double-blends every seam into a visible stripe.
 */
const CULL_BACK_FACES = true;

/** Spacing between road-surface samples along a band, in world units. */
const BAND_STEP = 1.5;
/**
 * Half the chord used to work out which way the road faces at a sample.
 *
 * `trackPoseAt` reports the *segment's* tangent, which jumps by the whole
 * corner angle as a sample crosses a vertex — and a quad whose two ends face
 * that differently folds over itself, which shows up as a wedge of kerb lying
 * across the racing line. Measuring the direction from a chord that straddles
 * the sample averages the two segments instead, which is a mitre.
 */
const NORMAL_CHORD = 1.2;

/** What the current quality tier will pay for on the circuit's surfaces. */
export interface TrackViewOptions {
  /** Normal-mapped aggregate on the tarmac. Off on the cheapest tier. */
  readonly normalMaps: boolean;
}

/**
 * Where the fast line runs, as a lateral offset from the centreline at even
 * distances around the lap.
 *
 * Every circuit has one and it is the first thing a driver reads: a dark strip
 * of laid-in rubber that swings wide, dives to the apex and runs out again. A
 * track without it is a road; a track with it tells you which way the next
 * corner goes before you can see it.
 *
 * ## Why smoothing does the work
 *
 * The raw signal is only "how hard is the road turning here, and which way",
 * which on its own would put the line hard against the inside kerb through the
 * corner and hard back to the middle the instant it straightened — a zig-zag,
 * not a line. What makes it a racing line is the SMOOTHING: averaging the
 * offset over a long window pulls the commitment backward and forward in time,
 * so the line drifts out before the corner and unwinds after it. Turn-in and
 * exit fall out of the filter rather than being written down.
 *
 * Circular, because a lap is. Smoothing a lap as an open sequence leaves a
 * kink at the start/finish line, which is exactly where everybody is looking.
 */
export function racingLineOffsets(
  path: readonly TrackPoint[],
  lap: number,
  samples: number,
  maxOffset: number,
): number[] {
  if (path.length < 2 || samples < 4 || lap <= 0) return [];
  const chord = 6;
  const raw: number[] = [];

  for (let i = 0; i < samples; i++) {
    const at = (lap * i) / samples;
    const behind = trackPoseAt(path, at - chord);
    const ahead = trackPoseAt(path, at + chord);
    const cross = behind.dirX * ahead.dirZ - behind.dirZ * ahead.dirX;
    const dot = behind.dirX * ahead.dirX + behind.dirZ * ahead.dirZ;
    const turn = Math.atan2(cross, dot);
    // A positive turn is a left-hander, and the inside of a left-hander is the
    // left — the negative direction along the right-hand normal everything
    // else here is measured with.
    const commitment = Math.min(1, Math.abs(turn) / TURN_FULL);
    raw.push(-Math.sign(turn) * commitment * maxOffset);
  }

  return smoothLoop(raw, 7, 4);
}

/** Moving average over a sequence that wraps. */
function smoothLoop(values: readonly number[], window: number, passes: number): number[] {
  let current = [...values];
  const count = current.length;
  for (let pass = 0; pass < passes; pass++) {
    const next = new Array<number>(count);
    for (let i = 0; i < count; i++) {
      let sum = 0;
      for (let k = -window; k <= window; k++) {
        sum += current[(((i + k) % count) + count) % count] ?? 0;
      }
      next[i] = sum / (window * 2 + 1);
    }
    current = next;
  }
  return current;
}

export class TrackView {
  readonly #scene: Scene;
  readonly #normalMaps: boolean;
  #meshes: Mesh[] = [];
  #pitMaterial: StandardMaterial | null = null;
  #materials: Material[] = [];
  #surfaces: Surface[] = [];
  #textures: Texture[] = [];

  constructor(scene: Scene, config: SimConfig, options: TrackViewOptions = { normalMaps: true }) {
    this.#scene = scene;
    this.#normalMaps = options.normalMaps;
    if (!config.track.enabled || config.trackPath.length < 2) return;

    const path = config.trackPath;
    const half = config.track.halfWidth;
    const lap = trackLength(path);

    // The road itself, as one band around the entire lap.
    this.#band('track:road', path, 0, lap, -half, half, ROAD_Y, this.#roadMaterial(lap, half));

    // Kerbs, painted just INSIDE the edge. A kerb drawn beyond the limit would
    // invite exactly the line that runs out of grip, because the simulation
    // stops calling it road at `halfWidth`.
    const kerb = this.#kerbMaterial(lap);
    this.#band('track:kerb:l', path, 0, lap, half - 0.9, half, KERB_Y, kerb);
    this.#band('track:kerb:r', path, 0, lap, -half, -half + 0.9, KERB_Y, kerb);

    // The fast line, and the white paint that says where the road ends.
    this.#racingLine(path, lap, half);
    const limit = this.#limitMaterial();
    this.#band('track:limit:l', path, 0, lap, half - 1.08, half - 0.9, LIMIT_Y, limit);
    this.#band('track:limit:r', path, 0, lap, -half + 0.9, -half + 1.08, LIMIT_Y, limit);

    this.#buildZoneMarks(config, path, half, lap);

    // The chequered board, last so it sits on top of everything else.
    this.#band('track:line', path, -1.3, 1.3, -half, half, LINE_Y, this.#startLineMaterial(half));

    // Barriers, set back from the kerb by a run-off so a small mistake is a
    // moment rather than the end of a race. They are scenery: the simulation's
    // track limits are still the grass, and nothing here collides. The circuit
    // decides whether it has room for them — see `track.barrierRunoff`.
    const runoff = config.track.barrierRunoff;
    if (runoff > 0) {
      const barrier = this.#barrierMaterial(lap);
      const back = half + runoff;
      this.#wall('track:barrier:l', path, lap, back, BARRIER_HEIGHT, barrier);
      this.#wall('track:barrier:r', path, lap, -back, BARRIER_HEIGHT, barrier);
    }

    this.#gantry(path, half);
  }

  dispose(): void {
    for (const mesh of this.#meshes) mesh.dispose();
    for (const material of this.#materials) material.dispose();
    for (const texture of this.#textures) texture.dispose();
    for (const surface of this.#surfaces) surface.dispose();
    this.#meshes = [];
    this.#materials = [];
    this.#textures = [];
    this.#surfaces = [];
  }

  // -------------------------------------------------------------- internals

  /**
   * A strip of road surface between two distances along the centreline and
   * two lateral offsets from it.
   *
   * Sampled at a fixed spacing rather than at the path's own vertices, so a
   * band that starts halfway round a corner still follows the corner. `u` runs
   * along the road and `v` across it — which is the mapping every texture here
   * assumes.
   */
  #band(
    name: string,
    path: readonly TrackPoint[],
    from: number,
    to: number,
    fromOffset: number,
    toOffset: number,
    y: number,
    material: Material,
  ): void {
    const span = to - from;
    const steps = Math.max(2, Math.ceil(Math.abs(span) / BAND_STEP));
    const inner: Vector3[] = [];
    const outer: Vector3[] = [];

    for (let i = 0; i <= steps; i++) {
      const at = from + (span * i) / steps;
      const pose = trackPoseAt(path, at);
      const behind = trackPoseAt(path, at - NORMAL_CHORD);
      const ahead = trackPoseAt(path, at + NORMAL_CHORD);

      // Right-hand normal of the road, matching the simulation's convention:
      // forward is (sin h, cos h), so right is (cos h, -sin h). Taken from the
      // chord rather than the tangent — see NORMAL_CHORD.
      const dirX = ahead.x - behind.x;
      const dirZ = ahead.z - behind.z;
      const length = Math.hypot(dirX, dirZ) || 1;
      const normalX = dirZ / length;
      const normalZ = -dirX / length;

      inner.push(new Vector3(pose.x + normalX * fromOffset, y, pose.z + normalZ * fromOffset));
      outer.push(new Vector3(pose.x + normalX * toOffset, y, pose.z + normalZ * toOffset));
    }

    const mesh = CreateRibbon(name, { pathArray: [inner, outer], sideOrientation: 2 }, this.#scene);
    mesh.material = material;
    mesh.isPickable = false;
    mesh.receiveShadows = true;
    this.#meshes.push(mesh);
  }

  /**
   * A vertical wall following the road, at a fixed offset across it.
   *
   * The horizontal counterpart of `#band`, and deliberately built the same
   * way: one ribbon, one draw call, however long the circuit is. A barrier
   * assembled from a box per segment would be a hundred draw calls to say the
   * same thing, which on the device this game is aimed at is the difference
   * between a barrier and no barrier.
   */
  #wall(
    name: string,
    path: readonly TrackPoint[],
    lap: number,
    offset: number,
    height: number,
    material: Material,
  ): void {
    const steps = Math.max(2, Math.ceil(lap / BAND_STEP));
    const foot: Vector3[] = [];
    const top: Vector3[] = [];

    for (let i = 0; i <= steps; i++) {
      const at = (lap * i) / steps;
      const pose = trackPoseAt(path, at);
      const behind = trackPoseAt(path, at - NORMAL_CHORD);
      const ahead = trackPoseAt(path, at + NORMAL_CHORD);
      const dirX = ahead.x - behind.x;
      const dirZ = ahead.z - behind.z;
      const length = Math.hypot(dirX, dirZ) || 1;
      const normalX = dirZ / length;
      const normalZ = -dirX / length;

      const x = pose.x + normalX * offset;
      const z = pose.z + normalZ * offset;
      foot.push(new Vector3(x, 0.02, z));
      top.push(new Vector3(x, height, z));
    }

    const mesh = CreateRibbon(name, { pathArray: [foot, top], sideOrientation: 2 }, this.#scene);
    mesh.material = material;
    mesh.isPickable = false;
    // Receives but does not cast. A barrier casting along the whole circuit
    // would double what the shadow map has to hold for a strip of shade nobody
    // is looking at, and the frame budget is the phone's, not the desktop's.
    mesh.receiveShadows = true;
    this.#meshes.push(mesh);
  }

  /**
   * Sector marks and DRS zones, placed by where their zone falls on the road.
   *
   * A timing gate is a line across the tarmac, not a glowing dinner plate: the
   * gates are wider than the road on purpose (so running wide costs time
   * rather than stranding a driver), and drawing that radius honestly would
   * bury the circuit under translucent discs. `KitViews` skips these kinds on
   * a circuit for the same reason.
   */
  #buildZoneMarks(config: SimConfig, path: readonly TrackPoint[], half: number, lap: number): void {
    const sector = this.#flatMaterial('track:sector', '#8d99ae', 0.35, LAYER_BIAS.sector);
    // A whisper, where it used to be a wash — and the arithmetic is worth
    // writing down, because it is not obvious and it bit twice.
    //
    // These overlays are unlit emissive blended by alpha, so the result is a
    // LERP toward the overlay's colour: `road * (1 - a) + tint * a`. The
    // tarmac underneath is now a true asphalt albedo, which is about a tenth
    // of the light that lands on it — roughly 0.02 in linear terms. The DRS
    // green is 0.84. So even at four percent the fill was contributing more
    // green than the entire road surface had, and a third of the circuit came
    // out as a teal carpet. Halving the alpha barely moved it, because the
    // problem was never the alpha; it was the ratio.
    //
    // The cue therefore moves to where a driver actually looks: the line at
    // the entry. That is also how a real circuit marks one — a board and a
    // painted line, not a repainted road.
    // 0.006, and that number was measured rather than guessed. Sampled off a
    // screenshot: the tarmac reads rgb(32,33,35) outside a zone and
    // rgb(36,39,40) inside — a shade lighter and barely greener, which is a
    // tint. At 0.04 the same pixels read rgb(36,53,48): a carpet.
    // (The band is drawn double-sided, so the effective alpha is about twice
    // what is written here — worth knowing before anyone "corrects" it.)
    const drs = this.#flatMaterial('track:drs', '#06d6a0', 0.006, LAYER_BIAS.drs);

    config.zones.forEach((zone, index) => {
      if (zone.kind === 'pit') {
        this.#pitBox(zone, index, path);
        return;
      }
      if (zone.kind !== 'checkpoint' && zone.kind !== 'drs') return;
      const at = sampleTrack(path, zone.x, zone.z).progress;

      if (zone.kind === 'checkpoint') {
        // Gate 0 is the start/finish line, which already has a board on it.
        if (zone.order === 0) return;
        this.#band(
          `track:sector:${index}`,
          path,
          at - 0.25,
          at + 0.25,
          -half,
          half,
          SECTOR_Y,
          sector,
        );
        return;
      }

      // A DRS zone is a stretch of road, so it is drawn as one — clipped to
      // the tarmac rather than spilling into the run-off the way its circle
      // does. Both ends get a brighter line, which is what a driver looks for.
      const from = Math.max(at - zone.radius, at - lap / 2);
      const to = Math.min(at + zone.radius, at + lap / 2);
      this.#band(`track:drs:${index}`, path, from, to, -half, half, DRS_Y, drs);
      const edge = this.#flatMaterial(
        `track:drs:${index}:edge`,
        '#06d6a0',
        0.85,
        LAYER_BIAS.sector,
      );
      this.#band(
        `track:drs:${index}:in`,
        path,
        from - DRS_EDGE,
        from + DRS_EDGE,
        -half,
        half,
        SECTOR_Y,
        edge,
      );
      this.#band(
        `track:drs:${index}:out`,
        path,
        to - DRS_EDGE,
        to + DRS_EDGE,
        -half,
        half,
        SECTOR_Y,
        edge,
      );
    });
  }

  /**
   * One pit box: a painted white bay on the pit lane.
   *
   * The zone used to be drawn as its literal trigger circle, and four
   * overlapping nine-metre hoops on the grass read as crop circles, not as a
   * pit lane. The circle is gameplay geometry; the PAINT is a bay outline the
   * size of a car, oriented along the lane — which runs parallel to the main
   * straight beside it, so the nearest track direction is the lane's.
   */
  #pitBox(zone: { x: number; z: number }, index: number, path: readonly TrackPoint[]): void {
    const sample = sampleTrack(path, zone.x, zone.z);
    const heading = Math.atan2(sample.dirX, sample.dirZ);

    const mesh = CreatePlane(`track:pit:${index}`, { width: 2.4, height: 4 }, this.#scene);
    mesh.rotation.x = Math.PI / 2;
    mesh.rotation.y = heading;
    mesh.position.set(zone.x, KERB_Y, zone.z);
    mesh.material = this.#pitPaint();
    mesh.isPickable = false;
    this.#meshes.push(mesh);
  }

  /** The paint a pit bay is outlined with: white border, open middle. */
  #pitPaint(): StandardMaterial {
    if (this.#pitMaterial) return this.#pitMaterial;
    const size = 128;
    const texture = new DynamicTexture(
      'track:pit:paint',
      { width: size, height: size },
      this.#scene,
      false,
    );
    texture.hasAlpha = true;
    const ctx = texture.getContext() as unknown as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, size, size);
    ctx.strokeStyle = 'rgba(235, 238, 240, 0.85)';
    ctx.lineWidth = 7;
    // Open at the lane side (top edge undrawn): a bay is a slot, not a cage.
    ctx.beginPath();
    ctx.moveTo(4, 4);
    ctx.lineTo(4, size - 4);
    ctx.lineTo(size - 4, size - 4);
    ctx.lineTo(size - 4, 4);
    ctx.stroke();
    texture.update();
    this.#textures.push(texture);

    const material = new StandardMaterial('track:pit:mat', this.#scene);
    material.diffuseTexture = texture;
    material.useAlphaFromDiffuseTexture = true;
    material.emissiveColor = new Color3(0.8, 0.8, 0.82);
    material.disableLighting = true;
    material.zOffset = LAYER_BIAS.sector;
    material.backFaceCulling = false;
    this.#materials.push(material);
    this.#pitMaterial = material;
    return material;
  }

  /**
   * Tarmac.
   *
   * The biggest surface in the game and the one the camera is pointed at for
   * the entire race, so it is the surface most worth spending on. It used to
   * be a flat grey with a faint reflection, and the giveaway was that it
   * stayed perfectly smooth at every distance: a road that is as featureless
   * two metres ahead as it is on the horizon is not a road, it is a floor.
   *
   * Now it is physically based, and made of stones. `surfaces.ts` generates a
   * bed of aggregate as an albedo and a height field; the height becomes a
   * normal map, which is what makes the chips catch the low sun and what puts
   * a *texture* under the tyres at cockpit height. Nothing here is a photo and
   * nothing is downloaded — see the note in that file.
   */
  #roadMaterial(lap: number, half: number): PBRMaterial {
    const material = new PBRMaterial('track:road:mat', this.#scene);
    const surface = createSurface(this.#scene, 'track:road', asphalt(ROAD_TEXTURE_SIZE), {
      size: ROAD_TEXTURE_SIZE,
      // A ribbon's UVs run 0..1 along its whole length and across its width,
      // so the tiling has to be worked out from the circuit's real size or
      // the aggregate is stretched into kilometre-long smears. One tile per
      // `ROAD_TILE` world units, in both directions, so the stones stay square.
      uScale: Math.max(1, Math.round(lap / ROAD_TILE)),
      vScale: Math.max(1, Math.round((half * 2) / ROAD_TILE)),
      strength: 5,
      withNormal: this.#normalMaps,
    });
    this.#surfaces.push(surface);

    material.albedoTexture = surface.albedo;
    if (surface.normal) material.bumpTexture = surface.normal;
    // Asphalt is not a metal and it is not polished. What it does do is get
    // *less* rough where the racing line has polished it — which is a refinement
    // for another day; a single value that is rough but not matte is already
    // the difference between tarmac and felt.
    material.metallic = 0;
    material.roughness = 0.72;
    material.backFaceCulling = CULL_BACK_FACES;
    this.#materials.push(material);
    return material;
  }

  /**
   * The gantry over the start/finish line.
   *
   * Three boxes, built once for the circuit rather than per car, and worth
   * every one of them: a lap counter needs somewhere to *be*, and until now
   * the most important place on the circuit was a painted stripe you crossed
   * without noticing. It is the landmark that turns a loop of tarmac into a
   * lap.
   *
   * Placed and oriented from the road itself, so it stands square across the
   * line on any circuit rather than needing a per-track constant.
   */
  #gantry(path: readonly TrackPoint[], half: number): void {
    const pose = trackPoseAt(path, 0);
    const heading = Math.atan2(pose.dirX, pose.dirZ);
    const normalX = pose.dirZ;
    const normalZ = -pose.dirX;
    const reach = half + 1.4;

    const material = this.#gantryMaterial();
    for (const side of [1, -1]) {
      const post = CreateBox(
        `track:gantry:post${side}`,
        { width: 0.5, height: GANTRY_HEIGHT, depth: 0.5 },
        this.#scene,
      );
      post.position.set(
        pose.x + normalX * reach * side,
        GANTRY_HEIGHT / 2,
        pose.z + normalZ * reach * side,
      );
      post.rotation.y = heading;
      post.material = material;
      post.isPickable = false;
      this.#meshes.push(post);
    }

    const beam = CreateBox(
      'track:gantry:beam',
      { width: reach * 2, height: 0.9, depth: 0.6 },
      this.#scene,
    );
    beam.position.set(pose.x, GANTRY_HEIGHT, pose.z);
    beam.rotation.y = heading;
    beam.material = material;
    beam.isPickable = false;
    this.#meshes.push(beam);
  }

  #gantryMaterial(): StandardMaterial {
    const material = new StandardMaterial('track:gantry:mat', this.#scene);
    material.diffuseColor = Color3.FromHexString('#2b2f3a');
    material.specularColor = new Color3(0.25, 0.25, 0.3);
    this.#materials.push(material);
    return material;
  }

  #barrierMaterial(lap: number): PBRMaterial {
    // Corrugated guardrail, not a painted slab. The wave profile lives in a
    // normal map — what makes corrugation read is the light rolling across
    // the ridges — and the albedo rides along from the same pattern, a
    // galvanised grey a step darker than the old wall so it stops being the
    // brightest thing on the horizon.
    const steel = createSurface(this.#scene, 'track:barrier:steel', corrugation(128), {
      size: 128,
      // One tile every couple of metres along the run; the ribbon's V spans
      // foot-to-top once, which is exactly one wave profile.
      uScale: Math.max(8, Math.round(lap / 2.4)),
      vScale: 1,
      strength: 9,
      withNormal: this.#normalMaps,
    });
    this.#surfaces.push(steel);

    const material = new PBRMaterial('track:barrier:mat', this.#scene);
    material.albedoTexture = steel.albedo;
    if (steel.normal) material.bumpTexture = steel.normal;
    // Weathered galvanised steel: metallic enough to take the sky, rough
    // enough not to mirror it.
    material.metallic = 0.55;
    material.roughness = 0.5;
    material.backFaceCulling = false;
    this.#materials.push(material);
    return material;
  }

  /**
   * The rubbered-in racing line.
   *
   * Built as a four-path ribbon so it can fade at its edges. A hard-edged
   * strip reads as a painted stripe, which is the one thing a racing line is
   * not — it is rubber ground into the surface, and rubber has no edge. The
   * two outer paths carry zero alpha and the two inner ones carry full, which
   * costs one extra quad across the width and buys the whole effect.
   */
  #racingLine(path: readonly TrackPoint[], lap: number, half: number): void {
    const samples = Math.max(16, Math.round(lap / 1.5));
    const offsets = racingLineOffsets(path, lap, samples, (half - LINE_HALF_WIDTH) * LINE_REACH);
    if (offsets.length === 0) return;

    // Four paths across: fade, solid, solid, fade.
    const across = [-1.9, -1, 1, 1.9].map((k) => k * LINE_HALF_WIDTH);
    const alphas = [0, 1, 1, 0];
    const paths: Vector3[][] = across.map(() => []);

    // One extra sample so the ribbon closes on itself rather than leaving a
    // seam at the start/finish line.
    for (let i = 0; i <= samples; i++) {
      const index = i % samples;
      const at = (lap * i) / samples;
      const pose = trackPoseAt(path, at);
      // Right of the road, matching every other band here.
      const normalX = pose.dirZ;
      const normalZ = -pose.dirX;
      const centre = offsets[index] ?? 0;
      across.forEach((lateral, lane) => {
        const offset = centre + lateral;
        paths[lane]?.push(
          new Vector3(pose.x + normalX * offset, RUBBER_Y, pose.z + normalZ * offset),
        );
      });
    }

    const mesh = CreateRibbon(
      'track:rubber',
      { pathArray: paths, sideOrientation: 2 },
      this.#scene,
    );
    const colours = new Float32Array((samples + 1) * across.length * 4);
    let at = 0;
    for (let lane = 0; lane < across.length; lane++) {
      for (let i = 0; i <= samples; i++) {
        colours[at] = 1;
        colours[at + 1] = 1;
        colours[at + 2] = 1;
        colours[at + 3] = alphas[lane] ?? 0;
        at += 4;
      }
    }
    mesh.setVerticesData(VertexBuffer.ColorKind, colours);
    mesh.hasVertexAlpha = true;
    mesh.material = this.#rubberMaterial();
    mesh.isPickable = false;
    mesh.receiveShadows = false;
    this.#meshes.push(mesh);
  }

  /**
   * Laid-in rubber: darker than the tarmac and, crucially, SMOOTHER.
   *
   * A racing line is not paint, it is the surface polished by a season of
   * tyres. Dropping the roughness is what makes it catch the sky along a
   * straight while the tarmac either side of it stays dull — which is how you
   * see it at all from a camera a metre off the ground.
   */
  #rubberMaterial(): PBRMaterial {
    const material = new PBRMaterial('track:rubber:mat', this.#scene);
    material.albedoColor = Color3.FromHexString('#17171a').toLinearSpace();
    material.metallic = 0;
    material.roughness = 0.55;
    material.zOffset = LAYER_BIAS.rubber;
    material.backFaceCulling = CULL_BACK_FACES;
    this.#materials.push(material);
    return material;
  }

  /** The white line at the track limit. Paint: bright, flat, slightly glossy. */
  #limitMaterial(): PBRMaterial {
    const material = new PBRMaterial('track:limit:mat', this.#scene);
    material.albedoColor = Color3.FromHexString('#d9dbdd').toLinearSpace();
    material.metallic = 0;
    material.roughness = 0.55;
    material.zOffset = LAYER_BIAS.limit;
    material.backFaceCulling = CULL_BACK_FACES;
    this.#materials.push(material);
    return material;
  }

  #kerbMaterial(lap: number): PBRMaterial {
    const texture = createKerbTexture(this.#scene);
    texture.wrapU = Texture.WRAP_ADDRESSMODE;
    texture.wrapV = Texture.WRAP_ADDRESSMODE;
    // One red/white pair every ~3 units of road, along `u` — the axis that
    // runs down the circuit.
    const uScale = Math.max(8, Math.round(lap / 3));
    texture.uScale = uScale;
    this.#textures.push(texture);

    // The stripes are paint; the RIBS are the kerb. A rumble strip with no
    // relief is a sticker on the tarmac, and the sun catching each rib's
    // leading face is what makes the strip read as a thing a car would jolt
    // over. The relief rides a normal map whose tiling matches the paint,
    // four ribs to each stripe pair.
    const ribs = createSurface(this.#scene, 'track:kerb:ribs', kerbRibs(128), {
      size: 128,
      uScale,
      vScale: 1,
      strength: 10,
      withNormal: this.#normalMaps,
    });
    this.#surfaces.push(ribs);

    const material = new PBRMaterial('track:kerb:mat', this.#scene);
    material.albedoTexture = texture;
    if (ribs.normal) material.bumpTexture = ribs.normal;
    material.metallic = 0;
    // Painted concrete: glossier than tarmac, duller than bodywork.
    material.roughness = 0.62;
    material.zOffset = LAYER_BIAS.kerb;
    material.backFaceCulling = CULL_BACK_FACES;
    this.#materials.push(material);
    return material;
  }

  #startLineMaterial(half: number): StandardMaterial {
    const texture = createStartLineTexture(this.#scene);
    texture.wrapU = Texture.WRAP_ADDRESSMODE;
    texture.wrapV = Texture.WRAP_ADDRESSMODE;
    // Two rows of roughly square cells: `v` spans the road's width, `u` the
    // board's short depth.
    texture.vScale = Math.max(3, Math.round(half));
    this.#textures.push(texture);

    const material = new StandardMaterial('track:line:mat', this.#scene);
    material.zOffset = LAYER_BIAS.line;
    material.diffuseTexture = texture;
    material.emissiveColor = new Color3(0.55, 0.55, 0.55);
    material.specularColor = new Color3(0, 0, 0);
    material.backFaceCulling = CULL_BACK_FACES;
    this.#materials.push(material);
    return material;
  }

  #flatMaterial(name: string, hex: string, alpha: number, bias = 0): StandardMaterial {
    const material = new StandardMaterial(`${name}:mat`, this.#scene);
    material.zOffset = bias;
    material.emissiveColor = Color3.FromHexString(hex);
    material.disableLighting = true;
    material.alpha = alpha;
    material.backFaceCulling = CULL_BACK_FACES;
    this.#materials.push(material);
    return material;
  }
}
