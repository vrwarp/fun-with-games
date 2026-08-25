import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder.js';
import { CreateDisc } from '@babylonjs/core/Meshes/Builders/discBuilder.js';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder.js';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder.js';
import { CreateTorus } from '@babylonjs/core/Meshes/Builders/torusBuilder.js';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator.js';

import { TEAM_INFO } from '../shared/modes.js';
import type { SimConfig } from '../sim/config.js';
import type { RenderState, RenderZone } from '../net/view.js';

/** Zone tint when nothing owns it, by kind. */
const ZONE_BASE_COLORS: Record<RenderZone['kind'], string> = {
  hill: '#ffd166',
  goal: '#9aa0a6',
  base: '#9aa0a6',
  checkpoint: '#4cc9f0',
  drs: '#06d6a0',
  pit: '#adb5bd',
};

/**
 * Renders the game kit's world entities: zones, the ball, projectiles and
 * carryable items. Same contract as `EntityViews` — a pure projection of
 * `RenderState`, no gameplay reads, everything procedural so it works with no
 * art assets at all.
 *
 * Static zone discs are built once from the config; only their colours change
 * (ownership, the local player's next checkpoint). Dynamic entities are
 * created and disposed as they appear in the state.
 */
export class KitViews {
  readonly #scene: Scene;
  readonly #config: SimConfig;
  #shadows: ShadowGenerator | null;
  /** Meshes registered at construction, to re-register on a generator swap. */
  #staticCasters: Mesh[] = [];

  #zones = new Map<number, { mesh: Mesh; material: StandardMaterial }>();
  #ball: { mesh: Mesh; material: StandardMaterial } | null = null;
  #projectiles = new Map<number, AbstractMesh>();
  #projectileProto: Mesh | null = null;
  #items = new Map<number, { root: TransformNode; spin: boolean }>();

  #time = 0;

  constructor(scene: Scene, config: SimConfig, shadows: ShadowGenerator | null) {
    this.#scene = scene;
    this.#config = config;
    this.#shadows = shadows;

    // On a circuit, timing gates and DRS zones are painted onto the road by
    // `TrackView` instead. Their radii are deliberately wider than the tarmac
    // — so that running wide costs time rather than stranding a driver — and
    // drawing that honestly as a disc would bury the whole circuit.
    const onTrack = config.track.enabled && config.trackPath.length >= 2;
    const drawn = config.zones.filter(
      (spec) =>
        !(onTrack && (spec.kind === 'checkpoint' || spec.kind === 'drs' || spec.kind === 'pit')),
    );

    config.zones.forEach((spec, id) => {
      if (!drawn.includes(spec)) return;
      // On a circuit a zone is a painted RING, not a filled disc. A translucent
      // dinner plate the size of a pit box is pure interface floating in a
      // scene that otherwise works hard to look like a place; a painted circle
      // is how a real circuit marks designated ground.
      const ring = onTrack;
      const mesh = ring
        ? CreateTorus(
            `zone:${id}`,
            { diameter: spec.radius * 2, thickness: 0.16, tessellation: 40 },
            scene,
          )
        : CreateDisc(`zone:${id}`, { radius: spec.radius, tessellation: 48 }, scene);
      if (ring) {
        // Squashed nearly flat: paint has no height, and a torus lying in the
        // plane already, so only its tube needs flattening.
        mesh.scaling.y = 0.12;
      } else {
        mesh.rotation.x = Math.PI / 2;
      }
      mesh.position.set(spec.x, 0.03, spec.z);
      mesh.isPickable = false;

      const material = new StandardMaterial(`zone:${id}:mat`, scene);
      // Faint for a ring: it is road paint seen from altitude, not signage.
      material.alpha = ring ? 0.38 : 0.32;
      material.disableLighting = true;
      // The disc lies flat and is viewed from above; culling would decide its
      // visibility by winding order, which is exactly the kind of silent bug
      // nobody notices until the demo. Draw both faces.
      material.backFaceCulling = false;
      material.emissiveColor = Color3.FromHexString(ZONE_BASE_COLORS[spec.kind]);
      mesh.material = material;

      this.#zones.set(id, { mesh, material });
    });

    if (config.ball.enabled) {
      const mesh = CreateSphere('ball', { diameter: config.ball.radius * 2, segments: 16 }, scene);
      const material = new StandardMaterial('ball:mat', scene);
      material.diffuseColor = Color3.FromHexString('#f8f9fa');
      material.emissiveColor = Color3.FromHexString('#2b2d42').scale(0.2);
      mesh.material = material;
      mesh.isPickable = false;
      this.#shadows?.addShadowCaster(mesh);
      this.#staticCasters.push(mesh);
      this.#ball = { mesh, material };
    }

    if (config.projectiles.enabled) {
      const proto = CreateSphere(
        'projectile:proto',
        { diameter: config.projectiles.radius * 2, segments: 8 },
        scene,
      );
      const material = new StandardMaterial('projectile:mat', scene);
      material.emissiveColor = Color3.FromHexString('#ffb703');
      material.disableLighting = true;
      proto.material = material;
      proto.isVisible = false;
      proto.setEnabled(false);
      this.#projectileProto = proto;
    }

    config.items.forEach((spec, id) => {
      const root = new TransformNode(`item:${id}`, scene);
      if (spec.kind === 'flag') {
        this.#buildFlag(root, id, spec.team);
        this.#items.set(id, { root, spin: false });
      } else {
        this.#buildCrown(root, id);
        this.#items.set(id, { root, spin: true });
      }
    });
  }

  /** Projects one frame of kit state onto the scene. */
  sync(state: RenderState, deltaSeconds: number): void {
    this.#time = (this.#time + deltaSeconds) % 3600;
    this.#syncZones(state);
    this.#syncBall(state);
    this.#syncProjectiles(state);
    this.#syncItems(state);
  }

  /**
   * Swaps in a new shadow generator after a tier change.
   *
   * Static kit meshes (zones, the ball) were registered at construction, so
   * they re-register here; dynamic ones (projectiles, items) go through
   * `#shadows` at spawn and pick the new generator up on their own.
   */
  setShadows(shadows: ShadowGenerator | null): void {
    this.#shadows = shadows;
    if (!shadows) return;
    for (const caster of this.#staticCasters) {
      if (!caster.isDisposed()) shadows.addShadowCaster(caster);
    }
  }

  dispose(): void {
    for (const { mesh, material } of this.#zones.values()) {
      material.dispose();
      mesh.dispose();
    }
    this.#zones.clear();
    if (this.#ball) {
      this.#ball.material.dispose();
      this.#ball.mesh.dispose();
      this.#ball = null;
    }
    for (const mesh of this.#projectiles.values()) mesh.dispose();
    this.#projectiles.clear();
    this.#projectileProto?.material?.dispose();
    this.#projectileProto?.dispose();
    for (const { root } of this.#items.values()) root.dispose(false, true);
    this.#items.clear();
  }

  // -------------------------------------------------------------- internals

  #syncZones(state: RenderState): void {
    const local = state.players.find((player) => player.isLocal);

    for (const zone of state.zones) {
      const view = this.#zones.get(zone.id);
      if (!view) continue;

      let color: string | null = null;
      let alpha = 0.32;

      if (zone.kind === 'hill') {
        if (zone.ownerTeam >= 0) color = TEAM_INFO[zone.ownerTeam]?.color ?? null;
        else if (zone.ownerId !== '') {
          color = state.players.find((p) => p.id === zone.ownerId)?.color ?? null;
        }
        if (color) alpha = 0.45;
      } else if (zone.kind === 'goal' || zone.kind === 'base') {
        color = TEAM_INFO[zone.team]?.color ?? null;
      } else if (zone.kind === 'checkpoint') {
        // The local player's NEXT gate glows; passed/future gates stay dim.
        const isNext = local !== undefined && zone.order === local.checkpoint;
        alpha = isNext ? 0.55 : 0.18;
      } else if (zone.kind === 'pit') {
        // The pit lane is tarmac you drive on, so it has to look like tarmac.
        alpha = 0.75;
      }

      view.material.emissiveColor = Color3.FromHexString(color ?? ZONE_BASE_COLORS[zone.kind]);
      view.material.alpha = alpha;
    }
  }

  #syncBall(state: RenderState): void {
    if (!this.#ball) return;
    if (!state.ball) {
      this.#ball.mesh.setEnabled(false);
      return;
    }
    this.#ball.mesh.setEnabled(true);
    this.#ball.mesh.position.set(state.ball.x, this.#config.ball.radius, state.ball.z);
    this.#ball.mesh.rotation.y = this.#time * 2;
  }

  #syncProjectiles(state: RenderState): void {
    if (!this.#projectileProto) return;
    const seen = new Set<number>();

    for (const projectile of state.projectiles) {
      seen.add(projectile.id);
      let mesh = this.#projectiles.get(projectile.id);
      if (!mesh) {
        mesh = this.#projectileProto.createInstance(`projectile:${projectile.id}`);
        this.#projectiles.set(projectile.id, mesh);
      }
      mesh.position.set(projectile.x, projectile.y, projectile.z);
    }

    for (const [id, mesh] of this.#projectiles) {
      if (seen.has(id)) continue;
      mesh.dispose();
      this.#projectiles.delete(id);
    }
  }

  #syncItems(state: RenderState): void {
    for (const item of state.items) {
      const view = this.#items.get(item.id);
      if (!view) continue;

      const carrier = item.carrierId
        ? state.players.find((player) => player.id === item.carrierId)
        : undefined;

      if (carrier) {
        // Ride above the carrier's head so possession reads at a glance.
        view.root.position.set(carrier.x, carrier.y + 2.3, carrier.z);
      } else {
        const bob = view.spin ? Math.sin(this.#time * 2) * 0.1 : 0;
        view.root.position.set(item.x, item.y + (view.spin ? 0.9 : 0) + bob, item.z);
      }
      if (view.spin) view.root.rotation.y = this.#time;
    }
  }

  #buildFlag(root: TransformNode, id: number, team: number): void {
    const pole = CreateCylinder(`item:${id}:pole`, { height: 1.8, diameter: 0.08 }, this.#scene);
    pole.parent = root;
    pole.position.y = 0.9;
    const poleMaterial = new StandardMaterial(`item:${id}:pole:mat`, this.#scene);
    poleMaterial.diffuseColor = Color3.FromHexString('#ced4da');
    pole.material = poleMaterial;

    const cloth = CreateBox(
      `item:${id}:cloth`,
      { width: 0.75, height: 0.5, depth: 0.05 },
      this.#scene,
    );
    cloth.parent = root;
    cloth.position.set(0.42, 1.5, 0);
    const clothMaterial = new StandardMaterial(`item:${id}:cloth:mat`, this.#scene);
    const teamColor = TEAM_INFO[team]?.color ?? '#ffd166';
    clothMaterial.diffuseColor = Color3.FromHexString(teamColor);
    clothMaterial.emissiveColor = Color3.FromHexString(teamColor).scale(0.4);
    cloth.material = clothMaterial;

    this.#shadows?.addShadowCaster(pole);
    this.#shadows?.addShadowCaster(cloth);
  }

  #buildCrown(root: TransformNode, id: number): void {
    const ring = CreateTorus(
      `item:${id}:crown`,
      { diameter: 0.7, thickness: 0.16, tessellation: 24 },
      this.#scene,
    );
    ring.parent = root;
    const material = new StandardMaterial(`item:${id}:crown:mat`, this.#scene);
    material.diffuseColor = Color3.FromHexString('#ffd166');
    material.emissiveColor = Color3.FromHexString('#b8860b').scale(0.6);
    material.specularColor = new Color3(0.9, 0.8, 0.4);
    ring.material = material;
    this.#shadows?.addShadowCaster(ring);
  }
}
