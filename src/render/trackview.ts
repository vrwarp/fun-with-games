import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import { CreateRibbon } from '@babylonjs/core/Meshes/Builders/ribbonBuilder.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import type { Scene } from '@babylonjs/core/scene.js';

import type { SimConfig, TrackPoint } from '../sim/config.js';
import { sampleTrack, trackLength, trackPoseAt } from '../sim/track.js';
import { createKerbTexture, createStartLineTexture } from './textures.js';

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
const DRS_Y = 0.025;
const KERB_Y = 0.03;
const SECTOR_Y = 0.035;
const LINE_Y = 0.04;

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

export class TrackView {
  readonly #scene: Scene;
  #meshes: Mesh[] = [];
  #materials: StandardMaterial[] = [];
  #textures: Texture[] = [];

  constructor(scene: Scene, config: SimConfig) {
    this.#scene = scene;
    if (!config.track.enabled || config.trackPath.length < 2) return;

    const path = config.trackPath;
    const half = config.track.halfWidth;
    const lap = trackLength(path);

    // The road itself, as one band around the entire lap.
    this.#band('track:road', path, 0, lap, -half, half, ROAD_Y, this.#roadMaterial());

    // Kerbs, painted just INSIDE the edge. A kerb drawn beyond the limit would
    // invite exactly the line that runs out of grip, because the simulation
    // stops calling it road at `halfWidth`.
    const kerb = this.#kerbMaterial(lap);
    this.#band('track:kerb:l', path, 0, lap, half - 0.9, half, KERB_Y, kerb);
    this.#band('track:kerb:r', path, 0, lap, -half, -half + 0.9, KERB_Y, kerb);

    this.#buildZoneMarks(config, path, half, lap);

    // The chequered board, last so it sits on top of everything else.
    this.#band('track:line', path, -1.3, 1.3, -half, half, LINE_Y, this.#startLineMaterial(half));
  }

  dispose(): void {
    for (const mesh of this.#meshes) mesh.dispose();
    for (const material of this.#materials) material.dispose();
    for (const texture of this.#textures) texture.dispose();
    this.#meshes = [];
    this.#materials = [];
    this.#textures = [];
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
    material: StandardMaterial,
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
   * Sector marks and DRS zones, placed by where their zone falls on the road.
   *
   * A timing gate is a line across the tarmac, not a glowing dinner plate: the
   * gates are wider than the road on purpose (so running wide costs time
   * rather than stranding a driver), and drawing that radius honestly would
   * bury the circuit under translucent discs. `KitViews` skips these kinds on
   * a circuit for the same reason.
   */
  #buildZoneMarks(config: SimConfig, path: readonly TrackPoint[], half: number, lap: number): void {
    const sector = this.#flatMaterial('track:sector', '#8d99ae', 0.35);
    const drs = this.#flatMaterial('track:drs', '#06d6a0', 0.11);

    config.zones.forEach((zone, index) => {
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
      const edge = this.#flatMaterial(`track:drs:${index}:edge`, '#06d6a0', 0.7);
      this.#band(
        `track:drs:${index}:in`,
        path,
        from - 0.2,
        from + 0.2,
        -half,
        half,
        SECTOR_Y,
        edge,
      );
      this.#band(`track:drs:${index}:out`, path, to - 0.2, to + 0.2, -half, half, SECTOR_Y, edge);
    });
  }

  #roadMaterial(): StandardMaterial {
    const material = new StandardMaterial('track:road:mat', this.#scene);
    // Deliberately lighter than the arena floor. The road has to be the first
    // thing the eye finds, and a dark ribbon on a dark ground is a road you
    // discover by driving off it.
    material.diffuseColor = Color3.FromHexString('#565d6d');
    material.emissiveColor = Color3.FromHexString('#1a1d24');
    material.specularColor = new Color3(0.04, 0.04, 0.05);
    material.backFaceCulling = false;
    this.#materials.push(material);
    return material;
  }

  #kerbMaterial(lap: number): StandardMaterial {
    const texture = createKerbTexture(this.#scene);
    texture.wrapU = Texture.WRAP_ADDRESSMODE;
    texture.wrapV = Texture.WRAP_ADDRESSMODE;
    // One red/white pair every ~3 units of road, along `u` — the axis that
    // runs down the circuit.
    texture.uScale = Math.max(8, Math.round(lap / 3));
    this.#textures.push(texture);

    const material = new StandardMaterial('track:kerb:mat', this.#scene);
    material.diffuseTexture = texture;
    material.emissiveColor = new Color3(0.4, 0.4, 0.4);
    material.specularColor = new Color3(0, 0, 0);
    material.backFaceCulling = false;
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
    material.diffuseTexture = texture;
    material.emissiveColor = new Color3(0.55, 0.55, 0.55);
    material.specularColor = new Color3(0, 0, 0);
    material.backFaceCulling = false;
    this.#materials.push(material);
    return material;
  }

  #flatMaterial(name: string, hex: string, alpha: number): StandardMaterial {
    const material = new StandardMaterial(`${name}:mat`, this.#scene);
    material.emissiveColor = Color3.FromHexString(hex);
    material.disableLighting = true;
    material.alpha = alpha;
    material.backFaceCulling = false;
    this.#materials.push(material);
    return material;
  }
}
