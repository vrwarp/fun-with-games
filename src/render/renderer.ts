import { Engine } from '@babylonjs/core/Engines/engine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator.js';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder.js';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';

// Side-effect import: registers the scene component that makes shadow
// generators actually render. Deep imports skip it, and the failure mode is a
// silent absence of shadows rather than an error.
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent.js';

import { lerpAngle } from '../shared/math.js';
import type { SimConfig } from '../sim/config.js';
import type { Obstacle } from '../sim/types.js';
import type { RenderState } from '../net/view.js';
import { EntityViews } from './entities.js';
import { createCheckerTexture } from './textures.js';

export interface RendererOptions {
  canvas: HTMLCanvasElement;
  config: SimConfig;
  obstacles: readonly Obstacle[];
}

/** How long a manual camera adjustment suspends auto-follow, in seconds. */
const MANUAL_CAMERA_HOLD_SECONDS = 2.5;
/** Below this speed (world units/second) the camera stops chasing. */
const MIN_FOLLOW_SPEED = 1.5;
/** Higher swings the camera behind the player faster; too high is nauseating. */
const FOLLOW_RESPONSIVENESS = 1.6;

/**
 * Owns the Babylon engine, scene and camera, and projects `RenderState` into
 * it every frame.
 *
 * Contains no gameplay logic whatsoever — deleting this file and writing a
 * different renderer against the same `RenderState` would leave the game fully
 * playable and every simulation test passing.
 */
export class Renderer {
  readonly engine: Engine;
  readonly scene: Scene;
  readonly camera: ArcRotateCamera;

  #entities: EntityViews;
  #shadows: ShadowGenerator | null = null;
  #localId: string | null = null;
  #cameraTarget = new Vector3(0, 0, 0);
  #disposed = false;

  #canvas: HTMLCanvasElement;
  /** Seconds since the player last adjusted the camera by hand. */
  #sinceManualCamera = Number.POSITIVE_INFINITY;
  #isPortrait = false;
  #lastLocalX: number | null = null;
  #lastLocalZ: number | null = null;

  #onManualCamera = (): void => {
    this.#sinceManualCamera = 0;
  };

  constructor(options: RendererOptions) {
    this.engine = new Engine(options.canvas, true, {
      preserveDrawingBuffer: true,
      stencil: true,
      antialias: true,
      // Lets the page keep working on machines without a usable GPU, which
      // includes most CI containers.
      failIfMajorPerformanceCaveat: false,
    });

    // Phones routinely report a device pixel ratio of 3, which means rendering
    // nine times the pixels of a logical viewport — the fastest way to turn a
    // playable game into a slideshow. Cap the effective ratio at 2.
    const pixelRatio = Math.min(globalThis.devicePixelRatio || 1, 2);
    this.engine.setHardwareScalingLevel(1 / pixelRatio);

    this.scene = new Scene(this.engine);
    this.scene.clearColor = new Color4(0.05, 0.06, 0.09, 1);

    this.#canvas = options.canvas;
    this.camera = this.#createCamera(options.canvas, options.config);
    this.#shadows = this.#createLights(options.config);
    this.#createArena(options.config, options.obstacles);

    this.#entities = new EntityViews(this.scene, options.config, this.#shadows);

    // Manual camera input suspends auto-follow. Registered as non-passive
    // capture listeners so they see the gesture even though Babylon's own
    // handlers are attached to the same element.
    options.canvas.addEventListener('pointerdown', this.#onManualCamera, { passive: true });
    options.canvas.addEventListener('wheel', this.#onManualCamera, { passive: true });

    this.#applyViewportFraming(true);
  }

  get entities(): EntityViews {
    return this.#entities;
  }

  /** Which player the camera follows. */
  setLocalPlayer(id: string): void {
    this.#localId = id;
  }

  /**
   * The compass direction the camera looks along, so that "forward" on the
   * keyboard means "away from the camera" rather than a fixed world axis.
   *
   * An `ArcRotateCamera` sits at `target + r * (cos a * sin b, cos b, sin a * sin b)`,
   * so its horizontal forward vector is `(-cos a, -sin a)`. Expressed as a yaw
   * measured from +Z, that is:
   */
  get cameraYaw(): number {
    const alpha = this.camera.alpha;
    return Math.atan2(-Math.cos(alpha), -Math.sin(alpha));
  }

  /** Projects one frame of state and draws it. */
  renderFrame(state: RenderState, deltaSeconds: number): void {
    if (this.#disposed) return;

    this.#entities.sync(state, deltaSeconds);
    this.#sinceManualCamera += deltaSeconds;

    if (this.#localId) {
      const position = this.#entities.playerPosition(this.#localId);
      if (position) {
        // Ease the camera towards the player so corrections and interpolation
        // hitches do not translate into a jerky view.
        const smoothing = Math.min(1, deltaSeconds * 8);
        this.#cameraTarget.x += (position.x - this.#cameraTarget.x) * smoothing;
        this.#cameraTarget.z += (position.z - this.#cameraTarget.z) * smoothing;
        this.camera.target.copyFromFloats(this.#cameraTarget.x, 1, this.#cameraTarget.z);
      }

      const local = state.players.find((player) => player.id === this.#localId);
      if (local) this.#followHeading(local.x, local.z, local.heading, deltaSeconds);
    }

    this.scene.render();
  }

  resize(): void {
    if (this.#disposed) return;
    this.engine.resize();
    this.#applyViewportFraming(false);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#canvas.removeEventListener('pointerdown', this.#onManualCamera);
    this.#canvas.removeEventListener('wheel', this.#onManualCamera);
    this.#entities.dispose();
    this.scene.dispose();
    this.engine.dispose();
  }

  // -------------------------------------------------------------- internals

  /**
   * Swings the camera around behind the direction of travel.
   *
   * This is the single most important concession to playing on a phone. With a
   * purely manual camera you need one thumb on the stick and a second to drag
   * the view — and on a phone you are usually holding the device with the
   * hand attached to that second thumb. Following automatically means the game
   * is playable one-handed.
   *
   * Manual control still wins: any drag or wheel suspends this for a few
   * seconds, so a player who wants to look around is never fighting it.
   */
  #followHeading(x: number, z: number, heading: number, deltaSeconds: number): void {
    const previousX = this.#lastLocalX;
    const previousZ = this.#lastLocalZ;
    this.#lastLocalX = x;
    this.#lastLocalZ = z;

    if (this.#sinceManualCamera < MANUAL_CAMERA_HOLD_SECONDS) return;
    if (previousX === null || previousZ === null) return;

    // Only chase while actually moving; otherwise a stationary player's camera
    // would creep toward whatever direction they last happened to face.
    const travelled = Math.hypot(x - previousX, z - previousZ);
    if (travelled < deltaSeconds * MIN_FOLLOW_SPEED) return;

    // An ArcRotateCamera looks along (-cos a, -sin a). Solving that for the
    // player's forward vector (sin h, cos h) gives the alpha that sits the
    // camera directly behind them.
    const desiredAlpha = Math.atan2(-Math.cos(heading), -Math.sin(heading));
    const blend = Math.min(1, deltaSeconds * FOLLOW_RESPONSIVENESS);
    this.camera.alpha = lerpAngle(this.camera.alpha, desiredAlpha, blend);
  }

  /**
   * Frames the arena for the current viewport shape.
   *
   * A portrait phone is narrow, so the same camera distance shows far less of
   * the arena horizontally than a desktop window does — you end up walking
   * into things you never saw. Pulling back and raising the angle restores a
   * comparable view.
   *
   * Only re-applied when the orientation actually flips, never on every
   * resize: mobile browsers fire resize constantly as the URL bar retracts,
   * and resetting a player's chosen zoom mid-game would be maddening.
   */
  #applyViewportFraming(force: boolean): void {
    const width = this.engine.getRenderWidth();
    const height = this.engine.getRenderHeight();
    if (width === 0 || height === 0) return;

    const isPortrait = height > width;
    if (!force && isPortrait === this.#isPortrait) return;
    this.#isPortrait = isPortrait;

    // `beta` is measured from straight up, so a *smaller* value is a more
    // overhead view. Portrait gets both: pulled back, and tilted down. A
    // phone-shaped viewport is narrow, so a near-horizon camera spends the top
    // third of the screen on empty sky and still shows less arena than a
    // desktop window does.
    // The tilt already buys back most of the visible ground, so the distance
    // only needs a nudge — push it much further and the player character
    // becomes an unreadable speck on a 6-inch screen.
    this.camera.radius = isPortrait ? 25 : 22;
    this.camera.beta = isPortrait ? Math.PI / 4 : Math.PI / 3.2;
  }

  #createCamera(canvas: HTMLCanvasElement, config: SimConfig): ArcRotateCamera {
    const camera = new ArcRotateCamera(
      'camera',
      -Math.PI / 2,
      Math.PI / 3.2,
      22,
      new Vector3(0, 1, 0),
      this.scene,
    );
    camera.attachControl(canvas, true);
    camera.lowerRadiusLimit = 8;
    camera.upperRadiusLimit = 40;
    // Stop the camera from dropping below the floor or flipping overhead.
    camera.lowerBetaLimit = 0.25;
    camera.upperBetaLimit = Math.PI / 2.15;
    camera.wheelPrecision = 12;
    camera.panningSensibility = 0; // Panning would decouple the follow target.
    camera.maxZ = Math.max(config.arenaHalfExtentX, config.arenaHalfExtentZ) * 8;
    return camera;
  }

  #createLights(config: SimConfig): ShadowGenerator | null {
    const ambient = new HemisphericLight('ambient', new Vector3(0, 1, 0), this.scene);
    ambient.intensity = 0.55;
    ambient.groundColor = new Color3(0.12, 0.13, 0.18);

    const sun = new DirectionalLight('sun', new Vector3(-0.5, -1, 0.4), this.scene);
    sun.position = new Vector3(20, 40, -20);
    sun.intensity = 1.1;

    const span = Math.max(config.arenaHalfExtentX, config.arenaHalfExtentZ);
    sun.shadowMinZ = 1;
    sun.shadowMaxZ = span * 6;

    try {
      // Shadow maps are the single most expensive thing in this scene. Halve
      // the resolution on touch devices, where the GPU is weaker and the
      // screen is too small to notice.
      const isCoarsePointer = globalThis.matchMedia?.('(pointer: coarse)').matches ?? false;
      const shadows = new ShadowGenerator(isCoarsePointer ? 512 : 1024, sun);
      shadows.useBlurExponentialShadowMap = true;
      shadows.blurKernel = isCoarsePointer ? 16 : 24;
      shadows.darkness = 0.35;
      return shadows;
    } catch {
      // Some software renderers refuse the shadow map format. Losing shadows
      // is strictly better than losing the whole scene.
      return null;
    }
  }

  #createArena(config: SimConfig, obstacles: readonly Obstacle[]): void {
    const width = config.arenaHalfExtentX * 2;
    const depth = config.arenaHalfExtentZ * 2;

    const ground = CreateGround('ground', { width, height: depth }, this.scene);
    const groundMaterial = new StandardMaterial('ground:mat', this.scene);
    const checker = createCheckerTexture(this.scene, { cells: Math.round(width / 3) });
    checker.wrapU = Texture.WRAP_ADDRESSMODE;
    checker.wrapV = Texture.WRAP_ADDRESSMODE;
    groundMaterial.diffuseTexture = checker;
    groundMaterial.specularColor = new Color3(0.05, 0.05, 0.06);
    ground.material = groundMaterial;
    ground.receiveShadows = true;

    const wallMaterial = new StandardMaterial('wall:mat', this.scene);
    wallMaterial.diffuseColor = Color3.FromHexString('#39415a');
    wallMaterial.specularColor = new Color3(0.1, 0.1, 0.12);

    const wallHeight = 2.5;
    const wallThickness = 0.6;
    const walls: Array<{ w: number; d: number; x: number; z: number }> = [
      { w: width + wallThickness * 2, d: wallThickness, x: 0, z: config.arenaHalfExtentZ },
      { w: width + wallThickness * 2, d: wallThickness, x: 0, z: -config.arenaHalfExtentZ },
      { w: wallThickness, d: depth, x: config.arenaHalfExtentX, z: 0 },
      { w: wallThickness, d: depth, x: -config.arenaHalfExtentX, z: 0 },
    ];

    for (const [index, spec] of walls.entries()) {
      const wall = CreateBox(
        `wall:${index}`,
        { width: spec.w, height: wallHeight, depth: spec.d },
        this.scene,
      );
      wall.position.set(spec.x, wallHeight / 2, spec.z);
      wall.material = wallMaterial;
      wall.receiveShadows = true;
      this.#shadows?.addShadowCaster(wall);
    }

    if (obstacles.length > 0) {
      this.#createObstacles(obstacles);
    }
  }

  /**
   * Obstacles are instances of one prototype box.
   *
   * Instances share a single draw call and a single material, so the arena
   * costs the same whether it has ten blocks or a thousand. Per-instance
   * scaling is what lets one prototype cover every size.
   */
  #createObstacles(obstacles: readonly Obstacle[]): void {
    const material = new StandardMaterial('obstacle:mat', this.scene);
    material.diffuseColor = Color3.FromHexString('#4d5675');
    material.specularColor = new Color3(0.12, 0.12, 0.15);

    const proto: Mesh = CreateBox('obstacle:proto', { size: 1 }, this.scene);
    proto.material = material;
    proto.receiveShadows = true;
    proto.isVisible = false;
    proto.setEnabled(false);

    for (const obstacle of obstacles) {
      const height = 1.6 + obstacle.halfX * 0.4;
      const instance = proto.createInstance(`obstacle:${obstacle.id}`);
      instance.position.set(obstacle.x, height / 2, obstacle.z);
      instance.scaling.set(obstacle.halfX * 2, height, obstacle.halfZ * 2);
      instance.receiveShadows = true;
      this.#shadows?.addShadowCaster(instance);
    }
  }
}
