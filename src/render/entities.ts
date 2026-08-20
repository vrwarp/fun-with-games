import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { CreateCapsule } from '@babylonjs/core/Meshes/Builders/capsuleBuilder.js';
import { CreatePolyhedron } from '@babylonjs/core/Meshes/Builders/polyhedronBuilder.js';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder.js';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator.js';
import type { SimConfig } from '../sim/config.js';
import type { RenderPickup, RenderPlayer, RenderState } from '../net/view.js';
import { createLabelTexture } from './textures.js';

interface PlayerView {
  root: TransformNode;
  body: Mesh;
  label: Mesh;
  material: StandardMaterial;
  name: string;
  color: string;
  baseColor: Color3;
  baseEmissive: Color3;
}

interface PickupView {
  mesh: AbstractMesh;
}

/**
 * Keeps Babylon meshes in sync with the network's view of the world.
 *
 * This is a pure projection: state flows one way, from `RenderState` into
 * meshes, and nothing here ever writes back. Gameplay questions ("did I score?")
 * are answered by the simulation, never by reading a mesh position — which is
 * what makes the renderer replaceable and the gameplay testable headlessly.
 */
export class EntityViews {
  readonly #scene: Scene;
  readonly #config: SimConfig;
  readonly #shadows: ShadowGenerator | null;

  #players = new Map<string, PlayerView>();
  #pickups = new Map<number, PickupView>();

  /** Prototype meshes; per-entity meshes are clones/instances of these. */
  #playerProto: Mesh;
  /** One prototype per pickup kind, so a speed boost reads differently. */
  #pickupProtos = new Map<string, { mesh: Mesh; material: StandardMaterial }>();

  #spinRadians = 0;

  constructor(scene: Scene, config: SimConfig, shadows: ShadowGenerator | null) {
    this.#scene = scene;
    this.#config = config;
    this.#shadows = shadows;

    this.#playerProto = CreateCapsule(
      'player:proto',
      { radius: config.playerRadius, height: config.playerRadius * 3.4, tessellation: 12 },
      scene,
    );
    this.#playerProto.isVisible = false;
    this.#playerProto.setEnabled(false);

    const pickupColors: Record<string, { diffuse: string; emissive: string }> = {
      score: { diffuse: '#f5c518', emissive: '#5a4708' },
      speed: { diffuse: '#4cc9f0', emissive: '#0f4d5e' },
      shield: { diffuse: '#9d4edd', emissive: '#3c1b5a' },
      heal: { diffuse: '#06d6a0', emissive: '#02543e' },
    };
    for (const [kind, colors] of Object.entries(pickupColors)) {
      const mesh = CreatePolyhedron(
        `pickup:proto:${kind}`,
        { type: 1, size: config.pickupRadius * 0.7 },
        scene,
      );
      const material = new StandardMaterial(`pickup:mat:${kind}`, scene);
      material.diffuseColor = Color3.FromHexString(colors.diffuse);
      material.emissiveColor = Color3.FromHexString(colors.emissive);
      material.specularColor = new Color3(0.6, 0.6, 0.4);
      mesh.material = material;
      mesh.isVisible = false;
      mesh.setEnabled(false);
      this.#pickupProtos.set(kind, { mesh, material });
    }
  }

  /** Replaces the procedural player mesh with a loaded model, if one exists. */
  setPlayerPrototype(mesh: Mesh): void {
    this.#playerProto.dispose();
    this.#playerProto = mesh;
    this.#playerProto.isVisible = false;
    this.#playerProto.setEnabled(false);
    // Existing views still reference the old prototype's clones; rebuild them.
    for (const [id, view] of this.#players) {
      this.#disposePlayer(view);
      this.#players.delete(id);
    }
  }

  /** Projects one frame of state onto the scene. */
  sync(state: RenderState, deltaSeconds: number): void {
    this.#spinRadians = (this.#spinRadians + deltaSeconds * 2) % (Math.PI * 2);
    this.#syncPlayers(state.players);
    this.#syncPickups(state.pickups);
  }

  /**
   * Status effects, drawn on the body itself rather than as extra meshes:
   * "it" burns, frozen is icy, KO fades out, protected blinks. Cheap enough
   * for a phone (a couple of colour writes per player per frame) and readable
   * over any arena content because it changes the character, not the ground.
   */
  #applyStatus(view: PlayerView, player: RenderPlayer): void {
    const material = view.material;
    const body = view.body;

    const isIt = player.role === 1;
    const frozen = player.effects.includes('frozen') || player.effects.includes('stun');
    const knockedOut = player.effects.includes('ko');
    const protectedNow = player.effects.includes('safe') || player.effects.includes('shield');

    if (knockedOut) {
      material.alpha = 0.25;
      body.scaling.setAll(0.8);
      material.diffuseColor = view.baseColor.scale(0.6);
      material.emissiveColor = view.baseEmissive.scale(0.2);
      view.label.visibility = 0.25;
      return;
    }

    body.scaling.setAll(1);
    view.label.visibility = 1;

    // Blinking beats a steady tint for protection: it reads as "temporary".
    material.alpha = protectedNow ? 0.55 + 0.35 * Math.sin(this.#spinRadians * 6) : 1;

    if (frozen) {
      material.diffuseColor = Color3.FromHexString('#a8dadc');
      material.emissiveColor = Color3.FromHexString('#457b9d').scale(0.5);
      return;
    }

    material.diffuseColor = view.baseColor;
    if (isIt) {
      // A pulsing hot glow marks the player to run from (or cheer for).
      const pulse = 0.5 + 0.35 * Math.sin(this.#spinRadians * 4);
      material.emissiveColor = Color3.FromHexString('#e63946').scale(pulse);
    } else {
      material.emissiveColor = view.baseEmissive;
    }
  }

  /** World position of a player, for the camera to follow. */
  playerPosition(id: string): Vector3 | null {
    return this.#players.get(id)?.root.position ?? null;
  }

  dispose(): void {
    for (const view of this.#players.values()) this.#disposePlayer(view);
    this.#players.clear();
    for (const view of this.#pickups.values()) view.mesh.dispose();
    this.#pickups.clear();
    this.#playerProto.dispose();
    for (const proto of this.#pickupProtos.values()) {
      proto.material.dispose();
      proto.mesh.dispose();
    }
    this.#pickupProtos.clear();
  }

  // -------------------------------------------------------------- internals

  #syncPlayers(players: readonly RenderPlayer[]): void {
    const seen = new Set<string>();

    for (const player of players) {
      seen.add(player.id);
      let view = this.#players.get(player.id);

      if (!view) {
        view = this.#createPlayer(player);
        this.#players.set(player.id, view);
      } else if (view.name !== player.name || view.color !== player.color) {
        // Name or colour changed (a late `hello` landed): rebuild the label.
        this.#refreshPlayerAppearance(view, player);
      }

      view.root.position.set(player.x, this.#config.playerRadius * 1.7, player.z);
      view.root.rotation.y = player.heading;
      this.#applyStatus(view, player);
    }

    for (const [id, view] of this.#players) {
      if (seen.has(id)) continue;
      this.#disposePlayer(view);
      this.#players.delete(id);
    }
  }

  #createPlayer(player: RenderPlayer): PlayerView {
    const root = new TransformNode(`player:${player.id}`, this.#scene);
    root.position = new Vector3(player.x, this.#config.playerRadius * 1.7, player.z);

    const body = this.#playerProto.clone(`player:${player.id}:body`, root);
    body.isVisible = true;
    body.setEnabled(true);

    const material = new StandardMaterial(`player:${player.id}:mat`, this.#scene);
    const baseColor = Color3.FromHexString(player.color);
    material.diffuseColor = baseColor;
    material.specularColor = new Color3(0.25, 0.25, 0.25);
    // The local player gets a faint glow so you can always find yourself.
    const baseEmissive = player.isLocal ? baseColor.scale(0.35) : new Color3(0, 0, 0);
    material.emissiveColor = baseEmissive;
    body.material = material;

    this.#shadows?.addShadowCaster(body);

    const label = this.#createLabel(player, root);

    return {
      root,
      body,
      label,
      material,
      name: player.name,
      color: player.color,
      baseColor,
      baseEmissive,
    };
  }

  #createLabel(player: RenderPlayer, parent: TransformNode): Mesh {
    const label = CreatePlane(`player:${player.id}:label`, { width: 3, height: 0.75 }, this.#scene);
    label.parent = parent;
    label.position = new Vector3(0, this.#config.playerRadius * 2.6, 0);
    label.billboardMode = 2; // BILLBOARDMODE_Y — spin about Y only, stays upright.
    label.isPickable = false;

    const material = new StandardMaterial(`player:${player.id}:label:mat`, this.#scene);
    material.diffuseTexture = createLabelTexture(this.#scene, player.name, player.color);
    material.emissiveColor = new Color3(1, 1, 1);
    material.disableLighting = true;
    material.useAlphaFromDiffuseTexture = true;
    material.backFaceCulling = false;
    label.material = material;

    return label;
  }

  #refreshPlayerAppearance(view: PlayerView, player: RenderPlayer): void {
    view.name = player.name;
    view.color = player.color;
    view.baseColor = Color3.FromHexString(player.color);
    view.baseEmissive = player.isLocal ? view.baseColor.scale(0.35) : new Color3(0, 0, 0);
    view.material.diffuseColor = view.baseColor;

    const parent = view.root;
    view.label.material?.dispose(true, true);
    view.label.dispose();
    view.label = this.#createLabel(player, parent);
  }

  #syncPickups(pickups: readonly RenderPickup[]): void {
    const seen = new Set<number>();

    for (const pickup of pickups) {
      seen.add(pickup.id);
      let view = this.#pickups.get(pickup.id);

      if (!view) {
        const proto = this.#pickupProtos.get(pickup.kind) ?? this.#pickupProtos.get('score');
        if (!proto) continue;
        const mesh = proto.mesh.createInstance(`pickup:${pickup.id}`);
        this.#shadows?.addShadowCaster(mesh);
        view = { mesh };
        this.#pickups.set(pickup.id, view);
      }

      view.mesh.setEnabled(pickup.active);
      if (!pickup.active) continue;

      // A slow spin and bob; purely cosmetic, driven by frame time, never by
      // the simulation clock.
      const bob = Math.sin(this.#spinRadians * 1.5 + pickup.id) * 0.15;
      view.mesh.position.set(pickup.x, this.#config.pickupRadius + 0.35 + bob, pickup.z);
      view.mesh.rotation.y = this.#spinRadians + pickup.id;
    }

    for (const [id, view] of this.#pickups) {
      if (seen.has(id)) continue;
      view.mesh.dispose();
      this.#pickups.delete(id);
    }
  }

  #disposePlayer(view: PlayerView): void {
    view.label.material?.dispose(true, true);
    view.label.dispose();
    view.material.dispose();
    view.body.dispose();
    view.root.dispose();
  }
}
