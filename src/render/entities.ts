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
import { createLabelTexture, createSpriteTexture } from './textures.js';
import { buildCarMesh } from './carmesh.js';
import { CarFinishes, type FinishOptions } from './carmaterials.js';
import { pbrSkin, standardSkin, type PlayerSkin } from './skin.js';

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
  /**
   * What the current quality tier will pay for in a car's materials.
   *
   * Passed in rather than read here, because the tier is the renderer's
   * business and this class should not have to know that a phone exists.
   */
  finish?: FinishOptions;
}

interface PlayerView {
  root: TransformNode;
  body: Mesh;
  label: Mesh;
  /** The body's surface, whatever kind of material it turned out to be. */
  skin: PlayerSkin;
  /**
   * Set only when the body is a sprite, whose colour lives in a texture rather
   * than in a colour channel and so has to be swapped rather than assigned.
   */
  sprite: StandardMaterial | null;
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
  /**
   * Carbon, rubber and metal, shared by every car on the grid.
   *
   * Built on first use rather than in the constructor, because a mode with no
   * cars in it should not pay to generate two textures it will never sample.
   */
  #finishes: CarFinishes | null = null;
  #finish: FinishOptions;

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
    this.#finish = options.finish ?? { normalMaps: true, clearCoat: true };

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

  /**
   * Rebuilds car materials for a new quality tier.
   *
   * Whether a material has a normal map is compiled into its shader, so this
   * cannot be a property assignment — the materials are thrown away and the
   * next `sync` builds them again. Cars go with them, because each one holds a
   * paint material from the bank being discarded.
   */
  setFinish(finish: FinishOptions): void {
    if (
      finish.normalMaps === this.#finish.normalMaps &&
      finish.clearCoat === this.#finish.clearCoat
    ) {
      return;
    }
    this.#finish = finish;
    this.#rebuildPlayers();
    this.#finishes?.dispose();
    this.#finishes = null;
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
    const skin = view.skin;
    const body = view.body;

    const isIt = player.role === 1;
    const frozen = player.effects.includes('frozen') || player.effects.includes('stun');
    const knockedOut = player.effects.includes('ko');
    const protectedNow = player.effects.includes('safe') || player.effects.includes('shield');

    if (knockedOut) {
      skin.setAlpha(0.25);
      body.scaling.setAll(0.8);
      view.label.visibility = 0.25;
      if (this.#sprites) {
        skin.setGlow(new Color3(0.4, 0.4, 0.45));
      } else {
        skin.setBase(view.baseColor.scale(0.6));
        skin.setGlow(view.baseEmissive.scale(0.2));
      }
      return;
    }

    body.scaling.setAll(1);
    view.label.visibility = 1;

    // Blinking beats a steady tint for protection: it reads as "temporary".
    skin.setAlpha(protectedNow ? 0.55 + 0.35 * Math.sin(this.#spinRadians * 6) : 1);

    // A sprite carries its colour in its texture, so status has to be a
    // multiply on top (emissive) rather than a diffuse swap, which would
    // simply be ignored.
    if (this.#sprites) {
      if (frozen) {
        skin.setGlow(Color3.FromHexString('#8fd3e8'));
      } else if (isIt) {
        const pulse = 0.6 + 0.4 * Math.sin(this.#spinRadians * 4);
        skin.setGlow(new Color3(1, pulse * 0.55, pulse * 0.45));
      } else {
        skin.setGlow(new Color3(1, 1, 1));
      }
      return;
    }

    if (frozen) {
      skin.setBase(Color3.FromHexString('#a8dadc'));
      skin.setGlow(Color3.FromHexString('#457b9d').scale(0.5));
      return;
    }

    skin.setBase(view.baseColor);
    if (isIt) {
      // A pulsing hot glow marks the player to run from (or cheer for).
      const pulse = 0.5 + 0.35 * Math.sin(this.#spinRadians * 4);
      skin.setGlow(Color3.FromHexString('#e63946').scale(pulse));
    } else {
      skin.setGlow(view.baseEmissive);
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
    this.#finishes?.dispose();
    this.#finishes = null;
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

    const baseColor = Color3.FromHexString(player.color);
    if (this.#vehicle && !this.#sprites) return this.#createCar(player, root, baseColor);

    const material = new StandardMaterial(`player:${player.id}:mat`, this.#scene);
    const baseEmissive = this.#glow(player, baseColor);
    let body: Mesh;
    let sprite: StandardMaterial | null = null;

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
      sprite = material;
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

    return {
      root,
      body,
      label: this.#createLabel(player, root),
      skin: standardSkin(material),
      sprite,
      name: player.name,
      color: player.color,
      baseColor,
      baseEmissive,
      wing: null,
      parts: [],
    };
  }

  /**
   * A racing car: real geometry, real materials.
   *
   * The shape is `carmesh.ts` and the substances are `carmaterials.ts`; what
   * happens here is only the joining of the two, plus the one thing neither of
   * them can know — which car belongs to the person holding the phone.
   */
  #createCar(player: RenderPlayer, root: TransformNode, baseColor: Color3): PlayerView {
    const finishes = (this.#finishes ??= new CarFinishes(this.#scene, this.#finish));
    const paint = finishes.createPaint(`player:${player.id}:paint`, baseColor);
    const car = buildCarMesh(
      this.#scene,
      `player:${player.id}`,
      root,
      {
        paint,
        carbon: finishes.carbon,
        rubber: finishes.rubber,
        metal: finishes.metal,
      },
      this.#config.playerRadius,
    );

    const skin = pbrSkin(paint);
    const baseEmissive = this.#glow(player, baseColor);
    skin.setGlow(baseEmissive);

    const parts = [...car.parts];
    this.#shadows?.addShadowCaster(car.chassis);
    this.#shadows?.addShadowCaster(car.wing);
    for (const part of parts) this.#shadows?.addShadowCaster(part);

    return {
      root,
      body: car.chassis,
      label: this.#createLabel(player, root),
      skin,
      sprite: null,
      name: player.name,
      color: player.color,
      baseColor,
      baseEmissive,
      wing: car.wing,
      parts,
    };
  }

  /**
   * How much the local player's own body glows, so they can find themselves.
   *
   * Far weaker on a car, and deliberately: emissive is light no shading can
   * touch, so on a physically-based surface it is the one term that can undo
   * everything the material is doing — a car lit from inside stops reflecting
   * the sky and starts looking like a lamp in the shape of a car. On a car the
   * camera is following you anyway; the glow is a hint, not a beacon.
   */
  #glow(player: RenderPlayer, baseColor: Color3): Color3 {
    if (!player.isLocal) return new Color3(0, 0, 0);
    return baseColor.scale(this.#vehicle && !this.#sprites ? 0.05 : 0.2);
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
    view.baseEmissive = this.#glow(player, view.baseColor);
    if (view.sprite) {
      // A sprite's colour is in its pixels, so it has to be redrawn rather
      // than assigned.
      view.sprite.diffuseTexture?.dispose();
      const texture = createSpriteTexture(this.#scene, player.color);
      texture.hasAlpha = true;
      view.sprite.diffuseTexture = texture;
    } else {
      view.skin.setBase(view.baseColor);
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
    view.skin.dispose();
    view.wing?.dispose();
    for (const part of view.parts) part.dispose();
    view.body.dispose();
    view.root.dispose();
  }
}
