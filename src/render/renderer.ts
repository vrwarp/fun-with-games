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
import { KitViews } from './kitviews.js';
import { TrackView } from './trackview.js';
import {
  applyView,
  viewFollowsHeading,
  viewSpec,
  type EyeSpec,
  type ViewMode,
  type ViewSpec,
  type WallSide,
} from './views.js';
import { createCheckerTexture } from './textures.js';

export interface RendererOptions {
  canvas: HTMLCanvasElement;
  config: SimConfig;
  obstacles: readonly Obstacle[];
  /** How to frame the world — 3D follow, isometric, top-down or side-on. */
  view?: ViewMode;
  /** Draw players as billboarded sprites instead of 3D bodies. */
  sprites?: boolean;
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
  #kit: KitViews;
  #track: TrackView;
  /**
   * How far back the camera sits, relative to the on-foot framing the view
   * specs are written for. Driven by top speed: what a player needs to see is
   * a second or two of road, and a car covers three times a runner's ground
   * in that time.
   */
  #framingScale: number;
  /** Every arena wall by side, so a view change can hide and show them. */
  #walls = new Map<WallSide, Mesh>();
  #shadows: ShadowGenerator | null = null;
  #localId: string | null = null;
  #cameraTarget = new Vector3(0, 0, 0);
  #disposed = false;

  #canvas: HTMLCanvasElement;
  #config: SimConfig;
  #view: ViewMode;
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
    this.#config = options.config;
    this.#view = options.view ?? 'follow';
    this.camera = this.#createCamera(options.canvas, options.config);
    this.#shadows = this.#createLights(options.config);
    this.#createArena(options.config, options.obstacles);

    this.#entities = new EntityViews(this.scene, options.config, this.#shadows, {
      sprites: options.sprites ?? false,
      // Derived rather than passed in: the renderer already knows which view
      // it is drawing, and a second flag would only be a way to disagree.
      firstPerson: viewSpec(this.#view).eye !== undefined,
    });
    this.#kit = new KitViews(this.scene, options.config, this.#shadows);
    this.#track = new TrackView(this.scene, options.config);
    this.#framingScale = options.config.vehicle.enabled
      ? Math.min(1.7, Math.max(1, options.config.playerMaxSpeed / 14))
      : 1;

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
    this.#kit.sync(state, deltaSeconds);
    this.#sinceManualCamera += deltaSeconds;

    if (this.#localId) {
      const position = this.#entities.playerPosition(this.#localId);
      const spec = viewSpec(this.#view);
      const local = state.players.find((player) => player.id === this.#localId);

      if (position && spec.eye && local) {
        this.#trackCockpit(local.heading, position, spec.eye);
        this.scene.render();
        return;
      }

      if (position) {
        // Ease the camera towards the player so corrections and interpolation
        // hitches do not translate into a jerky view.
        const smoothing = Math.min(1, deltaSeconds * 8);
        this.#cameraTarget.x += (position.x - this.#cameraTarget.x) * smoothing;
        this.#cameraTarget.z += (position.z - this.#cameraTarget.z) * smoothing;
        // Vertical tracking is slower: a platformer camera that matched every
        // hop one-for-one would make the whole level bounce.
        const verticalSmoothing = Math.min(1, deltaSeconds * 4);
        const desiredY = position.y - this.#config.playerRadius * 1.7 + spec.targetHeight;
        this.#cameraTarget.y += (desiredY - this.#cameraTarget.y) * verticalSmoothing;
        this.#clampTargetToArena(spec);
        this.camera.target.copyFrom(this.#cameraTarget);
      }

      if (local && viewFollowsHeading(this.#view, this.#config.vehicle.enabled)) {
        this.#followHeading(local.x, local.z, local.heading, deltaSeconds);
      }
    }

    this.scene.render();
  }

  /**
   * Puts the camera in the driver's head, looking down the road.
   *
   * Nothing here is smoothed, and that is the point. Every other view eases
   * toward the player because a little lag reads as a camera operator doing
   * their job; a head is bolted to the chassis, so the same lag reads as the
   * whole world sliding around — and it is what makes a first-person view
   * genuinely unpleasant to sit behind.
   *
   * For the same reason the heading is taken directly rather than through
   * `#followHeading`, which eases and only chases while the player is moving:
   * turning on the spot has to turn the view.
   */
  #trackCockpit(heading: number, position: Vector3, eye: EyeSpec): void {
    const forwardX = Math.sin(heading);
    const forwardZ = Math.cos(heading);
    const feet = position.y - this.#config.playerRadius * 1.7;

    this.#cameraTarget.set(
      position.x + forwardX * eye.lookahead,
      feet + eye.height,
      position.z + forwardZ * eye.lookahead,
    );
    this.camera.target.copyFrom(this.#cameraTarget);
    this.camera.radius = eye.lookahead - eye.forward;
    this.camera.beta = Math.PI / 2;
    // The alpha that sits an orbit camera behind its target, along the
    // player's forward vector — the same solve `#followHeading` uses.
    this.camera.alpha = Math.atan2(-forwardZ, -forwardX);
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
    this.#track.dispose();
    this.#kit.dispose();
    this.#entities.dispose();
    this.scene.dispose();
    this.engine.dispose();
  }

  // -------------------------------------------------------------- internals

  /**
   * Which walls to leave undrawn for a view.
   *
   * A fixed camera hides the two walls standing between it and the game. A
   * camera that chases a heading orbits, so it has no stable "near" wall and
   * hiding any of them would open a hole in the arena from three quarters of
   * the angles it passes through.
   */
  #hiddenWallsFor(view: ViewMode): Set<WallSide> {
    if (viewFollowsHeading(view, this.#config.vehicle.enabled)) return new Set<WallSide>();
    return new Set<WallSide>(viewSpec(view).hiddenWalls);
  }

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
   * Keeps an orthographic camera from panning off the edge of the world.
   *
   * A fixed 2D camera that scrolls past the arena shows a band of void, which
   * reads as a bug even though nothing is wrong. Where the arena is smaller
   * than the frustum the view simply centres instead — the classic 2D
   * camera-bounds rule. The perspective follow camera is left alone: it
   * orbits, so it has no stable notion of a screen edge.
   */
  #clampTargetToArena(spec: ReturnType<typeof viewSpec>): void {
    const halfHeight = spec.orthoHalfHeight;
    if (halfHeight === undefined) return;

    const width = this.engine.getRenderWidth();
    const height = this.engine.getRenderHeight();
    if (width === 0 || height === 0) return;

    // Must match `applyView`'s framing exactly: a clamp computed from the
    // unscaled spec would let a pulled-back camera see past the arena walls.
    const viewHalfHeight = halfHeight * this.#framingScale * (this.#isPortrait ? 1.25 : 1);
    const viewHalfWidth = viewHalfHeight * (width / height);

    const clampAxis = (value: number, arenaHalf: number, viewHalf: number): number => {
      const slack = arenaHalf - viewHalf;
      if (slack <= 0) return 0; // arena narrower than the view: centre it
      return Math.max(-slack, Math.min(slack, value));
    };

    this.#cameraTarget.x = clampAxis(
      this.#cameraTarget.x,
      this.#config.arenaHalfExtentX,
      viewHalfWidth,
    );

    if (this.#view === 'side') {
      // A side-scroller scrolls along X and climbs with the player, but never
      // sinks: this floor puts the ground line around three-quarters of the
      // way down the frame when the player is standing on it, which is where
      // a platformer wants it — most of the screen is the space you are about
      // to jump into.
      this.#cameraTarget.y = Math.max(this.#cameraTarget.y, viewHalfHeight * 0.45);
      return;
    }

    this.#cameraTarget.z = clampAxis(
      this.#cameraTarget.z,
      this.#config.arenaHalfExtentZ,
      viewHalfHeight,
    );
  }

  /**
   * Frames the arena for the current viewport shape.
   *
   * A portrait phone is narrow, so the same camera distance shows far less of
   * the arena horizontally than a desktop window does — you end up walking
   * into things you never saw. Pulling back and raising the angle restores a
   * comparable view.
   *
   * The 3D follow camera is only re-framed when the orientation actually
   * flips, never on every resize: mobile browsers fire resize constantly as
   * the URL bar retracts, and resetting a player's chosen zoom mid-game would
   * be maddening. The orthographic views have no player-chosen zoom to
   * disturb, and their frustum is an absolute box that MUST track the aspect
   * ratio, so those re-apply every time.
   */
  #applyViewportFraming(force: boolean): void {
    const width = this.engine.getRenderWidth();
    const height = this.engine.getRenderHeight();
    if (width === 0 || height === 0) return;

    const isPortrait = height > width;
    const orientationChanged = isPortrait !== this.#isPortrait;
    this.#isPortrait = isPortrait;

    const spec = viewSpec(this.#view);
    if (spec.orthoHalfHeight === undefined && !force && !orientationChanged) return;

    applyView(this.camera, this.#view, width, height, isPortrait, this.#framingScale);
  }

  #createCamera(canvas: HTMLCanvasElement, config: SimConfig): ArcRotateCamera {
    const spec = viewSpec(this.#view);
    const camera = new ArcRotateCamera(
      'camera',
      spec.alpha,
      spec.beta,
      spec.radius,
      new Vector3(0, spec.targetHeight, 0),
      this.scene,
    );
    // A fixed projection is part of what the view *is*; letting a drag rotate
    // an isometric or side-on camera would quietly turn it into a third view
    // nobody designed.
    if (spec.manualControl) camera.attachControl(canvas, true);
    applyCameraLimits(camera, spec);
    camera.wheelPrecision = 12;
    camera.panningSensibility = 0; // Panning would decouple the follow target.
    camera.maxZ = Math.max(config.arenaHalfExtentX, config.arenaHalfExtentZ) * 8;
    return camera;
  }

  /**
   * Switches the camera at runtime.
   *
   * Everything a view decides has to be re-decided here, not just the angles:
   * which walls stand between the camera and the game, whether the player may
   * drag it, how the orbit is limited, and whether the local player's own body
   * is drawn. Miss one and the scene is left half in the old view — a dragged
   * isometric camera, or a cockpit staring at the back of a wall.
   */
  setView(view: ViewMode): void {
    if (view === this.#view) return;
    this.#view = view;
    const spec = viewSpec(view);

    const hidden = this.#hiddenWallsFor(view);
    for (const [side, wall] of this.#walls) wall.setEnabled(!hidden.has(side));

    this.camera.detachControl();
    if (spec.manualControl) this.camera.attachControl(this.#canvas, true);
    applyCameraLimits(this.camera, spec);
    // Changing view is not a drag. Leaving the hold in place would strand the
    // new camera facing wherever the old one happened to be pointing.
    this.#sinceManualCamera = MANUAL_CAMERA_HOLD_SECONDS;

    this.#entities.setFirstPerson(spec.eye !== undefined);
    this.#applyViewportFraming(true);
  }

  /** Draw players as sprites or as bodies, from now on. */
  setSprites(sprites: boolean): void {
    this.#entities.setSprites(sprites);
  }

  get view(): ViewMode {
    return this.#view;
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

    // A deep slab, not a plane. A zero-thickness ground is invisible to the
    // side-on camera, which would leave a platformer's characters standing on
    // nothing; a *thin* one leaves a band of void under the level. Making it
    // deep means everything below the floor reads as solid earth. The top
    // face still sits exactly at y = 0, where the simulation puts the floor.
    const groundThickness = 8;
    const ground = CreateBox('ground', { width, height: groundThickness, depth }, this.scene);
    ground.position.y = -groundThickness / 2;
    const groundMaterial = new StandardMaterial('ground:mat', this.scene);
    // A circuit gets grass. The road is the one thing a driver has to be able
    // to find instantly, and grey-on-grey is a road you discover by leaving it.
    const racing = config.track.enabled && config.trackPath.length >= 2;
    const checker = createCheckerTexture(this.scene, {
      cells: Math.round(width / 3),
      ...(racing ? { colorA: '#1c3325', colorB: '#20392a', lineColor: '#294a36' } : {}),
    });
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
    const hidden = this.#hiddenWallsFor(this.#view);
    const allWalls: Array<{ w: number; d: number; x: number; z: number; side: WallSide }> = [
      {
        w: width + wallThickness * 2,
        d: wallThickness,
        x: 0,
        z: config.arenaHalfExtentZ,
        side: 'northZ',
      },
      {
        w: width + wallThickness * 2,
        d: wallThickness,
        x: 0,
        z: -config.arenaHalfExtentZ,
        side: 'southZ',
      },
      { w: wallThickness, d: depth, x: config.arenaHalfExtentX, z: 0, side: 'eastX' },
      { w: wallThickness, d: depth, x: -config.arenaHalfExtentX, z: 0, side: 'westX' },
    ];
    // All four are built and then hidden per view, rather than filtered here:
    // the camera can change at runtime now, and a wall that was never created
    // cannot come back when the player switches to a view that needs it.
    for (const [index, spec] of allWalls.entries()) {
      const wall = CreateBox(
        `wall:${index}`,
        { width: spec.w, height: wallHeight, depth: spec.d },
        this.scene,
      );
      wall.position.set(spec.x, wallHeight / 2, spec.z);
      wall.material = wallMaterial;
      wall.receiveShadows = true;
      wall.setEnabled(!hidden.has(spec.side));
      this.#shadows?.addShadowCaster(wall);
      this.#walls.set(spec.side, wall);
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
      // Height comes from the simulation now: with gravity on, the top of a
      // box is a surface players stand on, so drawing a different height
      // would be drawing a lie.
      const height = Math.max(0.1, obstacle.top - obstacle.baseY);
      const instance = proto.createInstance(`obstacle:${obstacle.id}`);
      instance.position.set(obstacle.x, obstacle.baseY + height / 2, obstacle.z);
      instance.scaling.set(obstacle.halfX * 2, height, obstacle.halfZ * 2);
      instance.receiveShadows = true;
      this.#shadows?.addShadowCaster(instance);
    }
  }
}

/**
 * Pins or bounds the camera's orbit for a view.
 *
 * A cockpit's orbit is one arrangement rather than a range: pin the radius and
 * the pitch, or Babylon's own limits quietly clamp the eye out of the car (the
 * default upper beta stops short of level). Every other view keeps a range,
 * because the player may be allowed to drag it.
 */
function applyCameraLimits(camera: ArcRotateCamera, spec: ViewSpec): void {
  if (spec.eye) {
    camera.lowerRadiusLimit = spec.radius;
    camera.upperRadiusLimit = spec.radius;
    camera.lowerBetaLimit = spec.beta;
    camera.upperBetaLimit = spec.beta;
    // Default near plane is 1 unit, which would slice away the bodywork the
    // driver is sitting behind — the whole reason to be in here.
    camera.minZ = 0.2;
    return;
  }

  camera.lowerRadiusLimit = 8;
  camera.upperRadiusLimit = 40;
  // Stop the camera from dropping below the floor or flipping overhead.
  camera.lowerBetaLimit = 0.25;
  camera.upperBetaLimit = Math.PI / 2.15;
  camera.minZ = 1;
}
