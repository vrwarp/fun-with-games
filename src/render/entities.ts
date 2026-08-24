import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { CreateCapsule } from '@babylonjs/core/Meshes/Builders/capsuleBuilder.js';
import { CreatePolyhedron } from '@babylonjs/core/Meshes/Builders/polyhedronBuilder.js';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder.js';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder.js';
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder.js';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator.js';
import type { SimConfig } from '../sim/config.js';
import type { RenderPickup, RenderPlayer, RenderState } from '../net/view.js';
import { createLabelTexture, createSpriteTexture } from './textures.js';

export interface EntityViewOptions {
  /**
   * Draw players as camera-facing sprites instead of 3D bodies.
   *
   * This is the visual half of "2D game": paired with the top-down or side
   * view it reads as a pixel-art game, while the simulation underneath is
   * completely unchanged.
   */
  sprites?: boolean;
  /**
   * The camera is inside the local player's head.
   *
   * Their name label is a billboard, so at zero distance it fills the screen;
   * their body is whatever the camera is sitting in. A car stays — the nose
   * and front wheels ahead of you are the whole appeal of an onboard shot —
   * but a capsule or a sprite has to go, or the view is the inside of your
   * own chest.
   */
  firstPerson?: boolean;
}

interface PlayerView {
  root: TransformNode;
  body: Mesh;
  label: Mesh;
  material: StandardMaterial;
  name: string;
  color: string;
  baseColor: Color3;
  baseEmissive: Color3;
  /** Rear wing, when this body is a car. Lies flat while DRS is open. */
  wing: Mesh | null;
  /** Extra meshes (wheels, wings) to dispose with the body. */
  parts: Mesh[];
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
  #sprites: boolean;
  #firstPerson: boolean;
  /**
   * Draw cars instead of bodies.
   *
   * Read from the config rather than passed in as an option: whether the game
   * is driven is already decided by `vehicle.enabled`, and a second switch
   * would only be a way for the two to disagree.
   */
  readonly #vehicle: boolean;
  /** Shared trim materials — every car uses the same dark bodywork. */
  #carTrim: StandardMaterial | null = null;
  #carRubber: StandardMaterial | null = null;

  /** Prototype meshes; per-entity meshes are clones/instances of these. */
  #playerProto: Mesh;
  /** One prototype per pickup kind, so a speed boost reads differently. */
  #pickupProtos = new Map<string, { mesh: Mesh; material: StandardMaterial }>();

  #spinRadians = 0;

  constructor(
    scene: Scene,
    config: SimConfig,
    shadows: ShadowGenerator | null,
    options: EntityViewOptions = {},
  ) {
    this.#scene = scene;
    this.#config = config;
    this.#shadows = shadows;
    this.#sprites = options.sprites ?? false;
    this.#firstPerson = options.firstPerson ?? false;
    this.#vehicle = config.vehicle.enabled;

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
    this.#rebuildPlayers();
  }

  /**
   * Switches between sprite billboards and 3D bodies.
   *
   * What a player is made of is decided when their view is built, so this
   * throws the views away rather than trying to mutate them; the next `sync`
   * builds the other kind. There are never more than a handful.
   */
  setSprites(sprites: boolean): void {
    if (sprites === this.#sprites) return;
    this.#sprites = sprites;
    this.#rebuildPlayers();
  }

  /** Whether the camera is inside the local player. See `EntityViewOptions`. */
  setFirstPerson(firstPerson: boolean): void {
    this.#firstPerson = firstPerson;
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
      view.label.visibility = 0.25;
      if (this.#sprites) {
        material.emissiveColor = new Color3(0.4, 0.4, 0.45);
      } else {
        material.diffuseColor = view.baseColor.scale(0.6);
        material.emissiveColor = view.baseEmissive.scale(0.2);
      }
      return;
    }

    body.scaling.setAll(1);
    view.label.visibility = 1;

    // Blinking beats a steady tint for protection: it reads as "temporary".
    material.alpha = protectedNow ? 0.55 + 0.35 * Math.sin(this.#spinRadians * 6) : 1;

    // A sprite carries its colour in its texture, so status has to be a
    // multiply on top (emissive) rather than a diffuse swap, which would
    // simply be ignored.
    if (this.#sprites) {
      if (frozen) {
        material.emissiveColor = Color3.FromHexString('#8fd3e8');
      } else if (isIt) {
        const pulse = 0.6 + 0.4 * Math.sin(this.#spinRadians * 4);
        material.emissiveColor = new Color3(1, pulse * 0.55, pulse * 0.45);
      } else {
        material.emissiveColor = new Color3(1, 1, 1);
      }
      return;
    }

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
    this.#carTrim?.dispose();
    this.#carTrim = null;
    this.#carRubber?.dispose();
    this.#carRubber = null;
    for (const proto of this.#pickupProtos.values()) {
      proto.material.dispose();
      proto.mesh.dispose();
    }
    this.#pickupProtos.clear();
  }

  // -------------------------------------------------------------- internals

  #rebuildPlayers(): void {
    for (const [id, view] of this.#players) {
      this.#disposePlayer(view);
      this.#players.delete(id);
    }
  }

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

      view.root.position.set(player.x, player.y + this.#config.playerRadius * 1.7, player.z);
      // A sprite is a billboard: it must not yaw with the player, or it would
      // turn edge-on and vanish. The 3D body still faces where it is going.
      if (!this.#sprites) view.root.rotation.y = player.heading;
      // The wing lies flat when the driver opens it — visible from behind,
      // which is exactly who needs to know.
      if (view.wing) view.wing.rotation.x = player.effects.includes('drs') ? -1.15 : 0;

      const inside = this.#firstPerson && player.isLocal;
      view.label.setEnabled(!inside);
      const showBody = !inside || (this.#vehicle && !this.#sprites);
      view.body.setEnabled(showBody);
      view.wing?.setEnabled(showBody);
      for (const part of view.parts) part.setEnabled(showBody);

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
    root.position = new Vector3(player.x, player.y + this.#config.playerRadius * 1.7, player.z);

    const material = new StandardMaterial(`player:${player.id}:mat`, this.#scene);
    const baseColor = Color3.FromHexString(player.color);
    const baseEmissive = player.isLocal ? baseColor.scale(0.35) : new Color3(0, 0, 0);

    // Car paint, not plastic. A tight bright highlight is the whole difference
    // between a coloured shape and a body panel — it is what tells the eye the
    // surface is curved and lacquered, and it is one line rather than a second
    // material or a texture.
    if (this.#vehicle && !this.#sprites) {
      material.specularColor = new Color3(0.85, 0.85, 0.9);
      material.specularPower = 96;
    }

    let body: Mesh;
    let wing: Mesh | null = null;
    const parts: Mesh[] = [];

    if (this.#vehicle && !this.#sprites) {
      const car = this.#buildCar(player.id, root, material);
      body = car.chassis;
      wing = car.wing;
      parts.push(...car.parts);
      material.diffuseColor = baseColor;
      material.specularColor = new Color3(0.45, 0.45, 0.45);
      material.emissiveColor = baseEmissive;
      body.material = material;
      this.#shadows?.addShadowCaster(body);
      for (const part of parts) this.#shadows?.addShadowCaster(part);

      return {
        root,
        body,
        label: this.#createLabel(player, root),
        material,
        name: player.name,
        color: player.color,
        baseColor,
        baseEmissive,
        wing,
        parts,
      };
    }

    if (this.#sprites) {
      const height = this.#config.playerHeight * 1.2;
      body = CreatePlane(`player:${player.id}:body`, { width: height, height }, this.#scene);
      body.parent = root;
      // BILLBOARDMODE_ALL, not _Y. A Y-only billboard is seen edge-on by a
      // top-down camera and disappears into a one-pixel sliver; facing the
      // camera on every axis is what makes one sprite work in all four views
      // (upright side-on, lying flat from above).
      body.billboardMode = 7;
      // Sprite art carries its own shading, so lighting it twice muddies it.
      material.diffuseTexture = createSpriteTexture(this.#scene, player.color);
      material.useAlphaFromDiffuseTexture = true;
      material.diffuseTexture.hasAlpha = true;
      material.emissiveColor = new Color3(1, 1, 1);
      material.disableLighting = true;
      material.backFaceCulling = false;
      // Cut out rather than blend: a blended sprite sorts badly against other
      // sprites and leaves halos where they overlap.
      material.alphaCutOff = 0.4;
    } else {
      body = this.#playerProto.clone(`player:${player.id}:body`, root);
      body.isVisible = true;
      body.setEnabled(true);
      material.diffuseColor = baseColor;
      material.specularColor = new Color3(0.25, 0.25, 0.25);
      // The local player gets a faint glow so you can always find yourself.
      material.emissiveColor = baseEmissive;
    }
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
      wing,
      parts,
    };
  }

  /**
   * A single-seater from seven boxes and four cylinders.
   *
   * Procedural like everything else here, because the kit must look
   * intentional on a fresh clone with no art at all. Proportions are all
   * derived from `playerRadius`, which is what the simulation actually
   * collides with — so a car that looks like it fits through a gap does.
   *
   * The body points along +Z, matching `heading = atan2(vx, vz)`. That is the
   * one detail a symmetric capsule let everyone ignore and a car cannot.
   */
  #buildCar(
    id: string,
    root: TransformNode,
    chassisMaterial: StandardMaterial,
  ): { chassis: Mesh; wing: Mesh; parts: Mesh[] } {
    const scene = this.#scene;
    const r = this.#config.playerRadius;
    // The root is lifted so a capsule's middle sits at mid-height; a car has
    // to be put back down on the road.
    const floor = -r * 1.7;
    const parts: Mesh[] = [];

    const trim = this.#trimMaterial();
    const rubber = this.#rubberMaterial();

    const chassis = CreateBox(
      `player:${id}:body`,
      { width: r * 1.15, height: r * 0.55, depth: r * 3.4 },
      scene,
    );
    chassis.parent = root;
    chassis.position.set(0, floor + r * 0.62, 0);
    chassis.material = chassisMaterial;

    const nose = CreateBox(
      `player:${id}:nose`,
      { width: r * 0.5, height: r * 0.3, depth: r * 1.5 },
      scene,
    );
    nose.parent = root;
    nose.position.set(0, floor + r * 0.5, r * 2.2);
    nose.material = chassisMaterial;
    parts.push(nose);

    const airbox = CreateBox(
      `player:${id}:airbox`,
      { width: r * 0.5, height: r * 0.5, depth: r * 0.8 },
      scene,
    );
    airbox.parent = root;
    airbox.position.set(0, floor + r * 1.15, -r * 0.5);
    airbox.material = chassisMaterial;
    parts.push(airbox);

    const frontWing = CreateBox(
      `player:${id}:fwing`,
      { width: r * 2.1, height: r * 0.12, depth: r * 0.6 },
      scene,
    );
    frontWing.parent = root;
    frontWing.position.set(0, floor + r * 0.22, r * 2.9);
    frontWing.material = trim;
    parts.push(frontWing);

    // The rear wing is kept as its own handle: opening DRS lays it flat, which
    // is the only way a rival can see the overtake coming.
    const wing = CreateBox(
      `player:${id}:rwing`,
      { width: r * 1.9, height: r * 0.14, depth: r * 0.7 },
      scene,
    );
    wing.parent = root;
    wing.position.set(0, floor + r * 1.35, -r * 1.9);
    wing.material = trim;

    const wheelSpecs: Array<[number, number]> = [
      [r * 0.85, r * 1.6],
      [-r * 0.85, r * 1.6],
      [r * 0.9, -r * 1.35],
      [-r * 0.9, -r * 1.35],
    ];
    wheelSpecs.forEach(([x, z], index) => {
      const front = index < 2;
      const radius = front ? r * 0.42 : r * 0.5;
      const wheel = CreateCylinder(
        `player:${id}:wheel${index}`,
        { diameter: radius * 2, height: r * 0.5, tessellation: 12 },
        scene,
      );
      wheel.parent = root;
      // Cylinders stand up the Y axis by default; a wheel lies on X.
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(x, floor + radius, z);
      wheel.material = rubber;
      parts.push(wheel);
    });

    return { chassis, wing, parts };
  }

  #trimMaterial(): StandardMaterial {
    if (!this.#carTrim) {
      const material = new StandardMaterial('car:trim', this.#scene);
      material.diffuseColor = Color3.FromHexString('#20242e');
      // Between the two: dark composite with a sheen, not a mirror.
      material.specularColor = new Color3(0.35, 0.35, 0.4);
      material.specularPower = 32;
      this.#carTrim = material;
    }
    return this.#carTrim;
  }

  #rubberMaterial(): StandardMaterial {
    if (!this.#carRubber) {
      const material = new StandardMaterial('car:rubber', this.#scene);
      material.diffuseColor = Color3.FromHexString('#15171d');
      // Dead matte, and deliberately the opposite of the bodywork above. A
      // tyre that catches the light the way a wing does reads as painted
      // metal, and the contrast between the two is most of what makes either
      // of them convincing.
      material.specularColor = new Color3(0.02, 0.02, 0.02);
      material.specularPower = 4;
      this.#carRubber = material;
    }
    return this.#carRubber;
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
    if (this.#sprites) {
      view.material.diffuseTexture?.dispose();
      const texture = createSpriteTexture(this.#scene, player.color);
      texture.hasAlpha = true;
      view.material.diffuseTexture = texture;
    } else {
      view.material.diffuseColor = view.baseColor;
    }

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
      view.mesh.position.set(pickup.x, pickup.y + this.#config.pickupRadius + 0.35 + bob, pickup.z);
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
    view.wing?.dispose();
    for (const part of view.parts) part.dispose();
    view.body.dispose();
    view.root.dispose();
  }
}
