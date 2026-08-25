import { Engine } from '@babylonjs/core/Engines/engine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator.js';
import { CascadedShadowGenerator } from '@babylonjs/core/Lights/Shadows/cascadedShadowGenerator.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { createLogger } from '../shared/logger.js';
import { SurfaceMarks } from './marks.js';
import { TyreSmoke } from './smoke.js';
import { LensFlareSystem } from '@babylonjs/core/LensFlares/lensFlareSystem.js';
import { LensFlare } from '@babylonjs/core/LensFlares/lensFlare.js';
import '@babylonjs/core/LensFlares/lensFlareSystemSceneComponent.js';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js';
import { ColorCurves } from '@babylonjs/core/Materials/colorCurves.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { SUN_TRAVEL, createSkyDome, createSkyEnvironment } from './environment.js';
import { corrugation, createSurface, grass } from './surfaces.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import {
  QualityGovernor,
  qualitySettings,
  readDeviceHints,
  startingTier,
  type QualityTier,
} from './quality.js';
import { DefaultRenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline.js';
import { SSAO2RenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/ssao2RenderingPipeline.js';
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration.js';
import { isOnTrack } from '../sim/track.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import type { Material } from '@babylonjs/core/Materials/material.js';
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
import { finishOptions } from './carmaterials.js';
import { KitViews } from './kitviews.js';
import { TrackView } from './trackview.js';
import { Scenery } from './scenery.js';
import {
  applyView,
  groundFootprint,
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
  /** Force a quality tier. Omitted means "work out what this device can take". */
  quality?: QualityTier;
}

const log = createLogger('render:renderer');

/**
 * How far the drawn ground reaches, as world half-extents.
 *
 * One definition, used both to build the ground and to decide how far the
 * camera may pan. They were separate, and the camera clamp was written against
 * the ARENA — which stopped being the edge of the world the moment a circuit's
 * ground was extended past it.
 */
function groundExtent(config: SimConfig): { x: number; z: number } {
  const racing = config.track.enabled && config.trackPath.length >= 2;
  if (!racing) return { x: config.arenaHalfExtentX, z: config.arenaHalfExtentZ };
  const outer = Math.max(config.arenaHalfExtentX, config.arenaHalfExtentZ) * GROUND_REACH;
  return { x: outer, z: outer };
}

/**
 * How far a circuit's ground runs past its arena, as a multiple of the arena's
 * larger half-extent.
 *
 * Five puts the edge well beyond `fogEnd`, so the world fades out rather than
 * stopping. The arena walls still mark the play area; this is only about where
 * the LAND ends.
 */
const GROUND_REACH = 5;

/** Texels per side of the generated grass. */
const GRASS_TEXTURE_SIZE = 512;
/**
 * World units one tile of grass covers.
 *
 * Large, because the tile now carries the mowing stripes and a stripe is
 * metres wide: at the old five units per tile the bands would repeat like
 * wallpaper. Twelve puts a light/dark pair every twelve metres, which is what
 * a mown verge actually looks like from a camera at altitude.
 */
const GRASS_TILE = 12;

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
/**
 * How much wider the frustum gets at top speed, as a fraction.
 *
 * Small on purpose. Enough that a driver feels the difference between a
 * hairpin and the back straight, and not so much that the car appears to
 * shrink — past about a fifth it stops reading as speed and starts reading as
 * a lens change.
 */
const FOV_SPEED_GAIN = 0.16;

export class Renderer {
  readonly engine: Engine;
  readonly scene: Scene;
  readonly camera: ArcRotateCamera;

  #entities: EntityViews;
  #kit: KitViews;
  #track: TrackView;
  #scenery: Scenery | null = null;
  #sun: DirectionalLight | null = null;
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
  #marks: SurfaceMarks | null = null;
  #smoke: TyreSmoke | null = null;
  #flare: LensFlareSystem | null = null;
  #flareTextures: DynamicTexture[] = [];
  /** Cars get a field of view that opens with speed; runners do not. */
  #speedFov = false;
  #baseFov = 0;
  #governor: QualityGovernor;
  #pipeline: DefaultRenderingPipeline | null = null;
  #ssao: SSAO2RenderingPipeline | null = null;
  /** True once the player has chosen a tier by hand; we stop second-guessing. */
  #tierIsChosen = false;
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

    // Which look this device can afford. Everything visual below asks the
    // tier rather than sniffing the platform itself, so there is one policy
    // and it is unit-tested — see `quality.ts` for why that matters here.
    this.#governor = new QualityGovernor(
      options.quality ?? startingTier(readDeviceHints(this.#rendererName())),
    );

    this.scene = new Scene(this.engine);
    this.#createSky(options.config);

    // Something for surfaces to reflect, on every tier and before any material
    // is built. Physically-based materials are DEFINED by what they reflect,
    // so this is not polish that a cheap device can skip — without it metal is
    // a flat black shape and car paint is a flat coloured one. Six 64px faces,
    // generated, owned by the scene and freed with it.
    createSkyEnvironment(this.scene);

    this.#canvas = options.canvas;
    this.#config = options.config;
    this.#view = options.view ?? 'follow';
    this.camera = this.#createCamera(options.canvas, options.config);
    this.#shadows = this.#createLights(options.config);

    // Tyre marks are a racing thing: the modes with a surface to mark and a
    // handling model worth showing. Elsewhere the pool would sit unused.
    const racingScene = options.config.track.enabled && options.config.trackPath.length >= 2;
    if (racingScene) {
      this.#marks = new SurfaceMarks(this.scene, options.config.playerRadius * 1.8);
      this.#smoke = new TyreSmoke(this.scene);
      this.#speedFov = options.config.vehicle.enabled;
      this.#baseFov = this.camera.fov;
    }
    this.#applyQuality(this.#governor.tier);
    this.#createArena(options.config, options.obstacles);

    this.#entities = new EntityViews(this.scene, options.config, this.#shadows, {
      sprites: options.sprites ?? false,
      // Derived rather than passed in: the renderer already knows which view
      // it is drawing, and a second flag would only be a way to disagree.
      firstPerson: viewSpec(this.#view).eye !== undefined,
      finish: finishOptions(this.#governor.tier),
    });
    this.#kit = new KitViews(this.scene, options.config, this.#shadows);
    this.#track = new TrackView(this.scene, options.config, {
      normalMaps: qualitySettings(this.#governor.tier).normalMaps,
    });
    // Everything on the far side of the barrier. Static, tier-independent —
    // it is a handful of draw calls whatever the device, so there is nothing
    // for a quality setting to take away.
    this.#scenery = new Scenery(this.scene, options.config);
    if (this.#shadows && qualitySettings(this.#governor.tier).cascadedShadows) {
      this.#scenery.addCastersTo(this.#shadows);
    }
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

    if (this.#marks || this.#smoke) {
      // One source list for the ground story and the air story: the streaks
      // and the smoke are gated by the same functions, so they can never
      // disagree about whether a car is in trouble.
      const sources = state.players.map((player) => ({
        id: player.id,
        x: player.x,
        z: player.z,
        heading: player.heading,
        vx: player.vx,
        vz: player.vz,
        onTrack: isOnTrack(this.#config, player.x, player.z),
      }));
      this.#marks?.update(sources, deltaSeconds);
      this.#smoke?.update(sources);
    }

    const local = state.players.find((player) => player.id === this.#localId);
    if (this.#speedFov) this.#applySpeedFov(local, deltaSeconds);
    this.#governQuality(deltaSeconds);

    if (this.#localId) {
      const position = this.#entities.playerPosition(this.#localId);
      const spec = viewSpec(this.#view);

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
    this.#marks?.dispose();
    this.#smoke?.dispose();
    this.#flare?.dispose();
    for (const texture of this.#flareTextures) texture.dispose();
    if (this.#disposed) return;
    this.#disposed = true;
    this.#canvas.removeEventListener('pointerdown', this.#onManualCamera);
    this.#canvas.removeEventListener('wheel', this.#onManualCamera);
    this.#track.dispose();
    this.#scenery?.dispose();
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
   * A fixed 2D camera that scrolls past the ground shows a band of void, which
   * reads as a bug even though nothing is wrong. Where the world is smaller
   * than the frustum the view simply centres instead — the classic 2D
   * camera-bounds rule. The perspective follow camera is left alone: it
   * orbits, so it has no stable notion of a screen edge.
   *
   * ## Two things this used to get wrong
   *
   * It compared the frustum's SCREEN half-extents against the ARENA, and both
   * halves of that were wrong once a circuit existed.
   *
   * Screen is not ground. The old code used the ortho box's width and height
   * as if they were world X and Z. That holds for `topdown`, which looks
   * straight down a world axis — and it was clearly written for `topdown`.
   * It does not hold for `iso`, which is rotated 45 degrees and tilted 37
   * above the horizon: measured, the frustum covers 58 x 58 world units where
   * the old arithmetic assumed 40 x 25. `groundFootprint` does the
   * trigonometry properly, from the camera's LIVE alpha, because a view that
   * chases a car's heading orbits and has no fixed angle to assume.
   *
   * The arena is not the edge of the world. A circuit's ground now runs five
   * times past it, so clamping to the arena was defending a boundary that had
   * stopped being one — while still paying the cost, pinning the camera off
   * the car near the arena edge for no benefit at all. It clamps to
   * `groundExtent` now, which on a circuit is far enough away that the camera
   * simply follows the car, and in an arena mode is exactly the old behaviour.
   *
   * Worth noting what the honest arithmetic implies: for `iso` the true
   * footprint is bigger than most arenas, so `slack` goes negative and the
   * rule above centres the view — which is right, because if the whole world
   * is on screen there is nothing to pan toward.
   */
  #clampTargetToArena(spec: ReturnType<typeof viewSpec>): void {
    const halfHeight = spec.orthoHalfHeight;
    if (halfHeight === undefined) return;

    const width = this.engine.getRenderWidth();
    const height = this.engine.getRenderHeight();
    if (width === 0 || height === 0) return;

    // Must match `applyView`'s framing exactly: a clamp computed from the
    // unscaled spec would let a pulled-back camera see past the world's edge.
    const viewHalfHeight = halfHeight * this.#framingScale * (this.#isPortrait ? 1.25 : 1);
    const viewHalfWidth = viewHalfHeight * (width / height);
    // Live alpha, not the spec's: `#followHeading` orbits it. One frame stale,
    // since that runs after this — which at any plausible turn rate is a
    // fraction of a degree.
    const reach = groundFootprint(
      this.camera.alpha,
      this.camera.beta,
      viewHalfWidth,
      viewHalfHeight,
    );
    const world = groundExtent(this.#config);

    const clampAxis = (value: number, worldHalf: number, viewHalf: number): number => {
      const slack = worldHalf - viewHalf;
      if (slack <= 0) return 0; // world narrower than the view: centre it
      return Math.max(-slack, Math.min(slack, value));
    };

    this.#cameraTarget.x = clampAxis(this.#cameraTarget.x, world.x, reach.x);

    if (this.#view === 'side') {
      // A side-scroller scrolls along X and climbs with the player, but never
      // sinks: this floor puts the ground line around three-quarters of the
      // way down the frame when the player is standing on it, which is where
      // a platformer wants it — most of the screen is the space you are about
      // to jump into.
      this.#cameraTarget.y = Math.max(this.#cameraTarget.y, viewHalfHeight * 0.45);
      return;
    }

    this.#cameraTarget.z = clampAxis(this.#cameraTarget.z, world.z, reach.z);
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

  /**
   * Sky, haze and the horizon they meet at.
   *
   * The scene used to end at a flat dark clear colour, which reads as a room
   * with the lights off rather than as outdoors — and worse, gives the eye
   * nothing to judge distance against, so a straight looked the same length at
   * every speed.
   *
   * Three things fix that and none of them costs a draw call:
   *
   *  - **A gradient sky**, painted into the clear colour and echoed by the
   *    ambient light's sky and ground colours, so the scene is lit by
   *    something that agrees with what is behind it.
   *  - **Distance fog** the same colour as that sky. Objects far away fade
   *    into the horizon instead of hanging in a void, which is the single
   *    strongest depth cue available for free — it is a shader term, not
   *    geometry.
   *  - **A warmer, lower sun**, which is what makes a surface read as lit
   *    rather than as tinted. A light straight overhead flattens everything.
   *
   * Fog also earns its keep on the frame budget: the far plane can be pulled
   * in behind it without the player seeing anything pop.
   */
  /**
   * Opens the field of view as the car goes faster.
   *
   * The oldest trick in racing games and still the best value: nothing about
   * the scene changes, but widening the frustum pulls the edges of the frame
   * past the camera faster, and the whole image acquires the stretch that
   * reads as speed. It costs one number a frame.
   *
   * Eased rather than set, because the FOV is the shape of the world and
   * snapping it every time a car brushes a kerb is nauseating. The rate is
   * deliberately slower going back down than up: getting quicker should feel
   * like it happens TO you, and lifting off should feel like relief.
   */
  #applySpeedFov(local: { vx: number; vz: number } | undefined, deltaSeconds: number): void {
    const speed = local ? Math.hypot(local.vx, local.vz) : 0;
    const fraction = Math.min(1, speed / Math.max(1, this.#config.playerMaxSpeed));
    const wanted = this.#baseFov * (1 + FOV_SPEED_GAIN * fraction);
    const opening = wanted > this.camera.fov;
    const rate = Math.min(1, deltaSeconds * (opening ? 1.6 : 3.2));
    this.camera.fov += (wanted - this.camera.fov) * rate;
  }

  /**
   * Gives up a tier when the device plainly cannot hold it.
   *
   * There is no reliable way to ask a browser what GPU it has, so the honest
   * answer is to try and watch. The policy — how long a shortfall has to last
   * before it counts, and that it only ever steps DOWN — lives in
   * `QualityGovernor` where it can be tested; this is only the wiring.
   *
   * Skipped entirely once a player has chosen a tier by hand. Somebody who
   * deliberately asked for the handsome version on a machine that struggles
   * with it has made a decision, and silently undoing it is worse than the
   * frame rate they accepted.
   */
  #governQuality(deltaSeconds: number): void {
    if (this.#tierIsChosen) return;
    const next = this.#governor.update(this.engine.getFps(), deltaSeconds);
    if (next === null) return;
    log.debug('dropping quality tier', next);
    this.#applyQuality(next);
    this.#applyTierToScene(next);
  }

  /**
   * What the driver calls itself, or an empty string if it will not say.
   *
   * Only used to spot a software rasteriser. Wrapped because `getGlInfo` can
   * throw on a context that is already lost, and losing the whole renderer to
   * a failed quality guess would be a poor trade.
   */
  #rendererName(): string {
    try {
      return this.engine.getGlInfo().renderer ?? '';
    } catch {
      return '';
    }
  }

  /** The tier currently in force, after any automatic step down. */
  get quality(): QualityTier {
    return this.#governor.tier;
  }

  /**
   * Switches the whole look, at runtime.
   *
   * Called both by the Settings panel and by the governor below. A player's
   * choice is final — `#tierIsChosen` stops the automatic fallback from
   * quietly overriding somebody who deliberately asked for the handsome
   * version on a device that struggles with it. Their machine, their call.
   */
  setQuality(tier: QualityTier, chosen = true): void {
    if (chosen) this.#tierIsChosen = true;
    if (tier === this.#governor.tier && this.#pipeline) return;
    this.#governor.setTier(tier);
    this.#applyQuality(tier);
    this.#applyTierToScene(tier);
  }

  /**
   * The half of a tier change that lives in the scene rather than the pipeline.
   *
   * Whether a surface has a normal map is compiled into its shader, so neither
   * of these can be a property assignment — the materials have to be built
   * again, and the things holding them go with them. The circuit is static
   * geometry, so rebuilding it is a handful of milliseconds at the moment
   * somebody moved a slider.
   */
  #applyTierToScene(tier: QualityTier): void {
    // Shadows first, so everything rebuilt below registers with the NEW
    // generator rather than a disposed one.
    this.#shadows?.dispose();
    this.#shadows = this.#createShadows(tier);
    this.#entities.setShadows(this.#shadows);
    this.#kit.setShadows(this.#shadows);
    if (this.#shadows && qualitySettings(tier).cascadedShadows) {
      this.#scenery?.addCastersTo(this.#shadows);
    }

    this.#entities.setFinish(finishOptions(tier));
    this.#track.dispose();
    this.#track = new TrackView(this.scene, this.#config, {
      normalMaps: qualitySettings(tier).normalMaps,
    });
  }

  /**
   * Everything a tier decides, applied in one place.
   *
   * Rebuilt rather than mutated: a rendering pipeline is a chain of render
   * targets sized to the canvas, and half-reconfiguring one leaves post
   * processes attached to buffers nothing writes to any more. Tearing it down
   * costs a frame at the moment a player changes a setting, which is exactly
   * when a frame is affordable.
   */
  #applyQuality(tier: QualityTier): void {
    const quality = qualitySettings(tier);

    // Resolution first, because everything below is priced per fragment.
    const ratio = Math.min(globalThis.devicePixelRatio || 1, quality.maxPixelRatio);
    this.engine.setHardwareScalingLevel(1 / ratio);

    this.#applyToneMapping();

    this.#pipeline?.dispose();
    this.#pipeline = null;
    this.#ssao?.dispose();
    this.#ssao = null;
    this.#applyLensFlare(quality.bloom);

    // Nothing at all on the cheapest tier. Not a pipeline with everything
    // switched off: an empty `DefaultRenderingPipeline` still costs a
    // full-screen copy, and a full-screen copy at a phone's pixel ratio is
    // precisely the cost this tier exists to avoid.
    if (!quality.antialias && !quality.bloom) return;

    try {
      const pipeline = new DefaultRenderingPipeline('post', true, this.scene, [this.camera]);
      pipeline.fxaaEnabled = quality.antialias;
      pipeline.bloomEnabled = quality.bloom;
      if (quality.bloom) {
        // Restrained on purpose. This is sunlight on bodywork, not a dream
        // sequence: the threshold is high so only genuine highlights bloom,
        // and the weight is low so they glow rather than smear.
        pipeline.bloomThreshold = 0.85;
        pipeline.bloomWeight = 0.22;
        pipeline.bloomKernel = 32;
        pipeline.bloomScale = 0.5;
      }
      this.#pipeline = pipeline;

      if (quality.ambientOcclusion) {
        // The most expensive thing in this file, and desktop-only for that
        // reason. What it buys is contact: without it every object looks like
        // a sticker floating slightly above whatever it stands on.
        this.#ssao = new SSAO2RenderingPipeline('ssao', this.scene, 0.75, [this.camera]);
        this.#ssao.radius = 1.8;
        // Stronger than before, deliberately. Contact darkening is half of
        // what separates "objects standing on a surface" from "objects pasted
        // onto one", and the old strength was tuned against a scene with no
        // scenery to ground.
        this.#ssao.totalStrength = 1.15;
        this.#ssao.samples = 12;
        this.#ssao.expensiveBlur = false;
      }
    } catch (error) {
      // A software renderer or a locked-down context can refuse a render
      // target outright. Losing the polish is strictly better than losing the
      // scene, which is the same bargain the shadow map already makes.
      log.debug('post-processing unavailable', error);
      this.#pipeline = null;
      this.#ssao = null;
    }
  }

  /**
   * The sun's lens flare: a warm glow on the disc and a few ghosts down the
   * optical axis. Nothing says "footage" rather than "render" more cheaply —
   * a flare is an artefact of a CAMERA, and implying a camera implies a
   * world in front of it. Generated textures, like everything else here.
   *
   * Rides the bloom flag: it is a screen-space luxury with the same budget
   * profile, so the tier that can afford one can afford the other.
   */
  #applyLensFlare(enabled: boolean): void {
    const racing = this.#config.track.enabled && this.#config.trackPath.length >= 2;
    if (!enabled || !racing) {
      this.#flare?.dispose();
      this.#flare = null;
      for (const texture of this.#flareTextures) texture.dispose();
      this.#flareTextures = [];
      return;
    }
    if (this.#flare) return;

    const glow = this.#flareTexture('flare:glow', 1, 0.95, 0.82, 0.5);
    const ghost = this.#flareTexture('flare:ghost', 0.7, 0.85, 1, 0.16);

    // The emitter sits far along the sun's own direction, so the flare and
    // the drawn disc in the sky are the same fact — SUN_TRAVEL again.
    const emitter = new TransformNode('flare:emitter', this.scene);
    emitter.position.set(-SUN_TRAVEL.x * 380, -SUN_TRAVEL.y * 380, -SUN_TRAVEL.z * 380);

    const system = new LensFlareSystem('flare', emitter, this.scene);
    const elements: Array<[number, number, Color3, DynamicTexture]> = [
      [0.35, 0, new Color3(1, 0.97, 0.9), glow],
      [0.11, 0.25, new Color3(0.75, 0.85, 1), ghost],
      [0.06, 0.5, new Color3(0.8, 1, 0.85), ghost],
      [0.16, 0.85, new Color3(1, 0.85, 0.75), ghost],
    ];
    for (const [flareSize, position, color, texture] of elements) {
      // Babylon resolves flare textures by URL; hand each the live texture
      // instead, since these were never files.
      const flare = new LensFlare(flareSize, position, color, texture.name, system);
      flare.texture = texture;
    }
    this.#flare = system;
  }

  /** A soft radial disc for a flare element, drawn once. */
  #flareTexture(name: string, r: number, g: number, b: number, alpha: number): DynamicTexture {
    const size = 128;
    const texture = new DynamicTexture(name, { width: size, height: size }, this.scene, false);
    texture.hasAlpha = true;
    const ctx = texture.getContext() as unknown as CanvasRenderingContext2D;
    const half = size / 2;
    const gradient = ctx.createRadialGradient(half, half, 1, half, half, half);
    const rgb = `${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}`;
    gradient.addColorStop(0, `rgba(${rgb}, ${alpha})`);
    gradient.addColorStop(0.5, `rgba(${rgb}, ${alpha * 0.4})`);
    gradient.addColorStop(1, `rgba(${rgb}, 0)`);
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    texture.update();
    this.#flareTextures.push(texture);
    return texture;
  }

  /**
   * Filmic tone mapping, on every tier including the cheapest.
   *
   * This is the single largest difference between a render and a photograph
   * and it is nearly free — a term in the material's own shader rather than a
   * screen pass, so it costs no bandwidth and no extra target.
   *
   * Without it, everything brighter than white clips to a flat white blob:
   * the sun off a wing, a bloom highlight, the sky near the horizon. ACES
   * rolls those off the way film does, which is why the results look
   * photographed rather than computed.
   */
  #applyToneMapping(): void {
    const image = this.scene.imageProcessingConfiguration;
    image.toneMappingEnabled = true;
    image.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    // Exposure well above 1, and this is the part that is easy to get wrong.
    //
    // ACES is built to roll off values ABOVE white — that is the whole point
    // of it. Handed a scene that was lit for no tone mapping at all, where
    // nothing ever exceeds 1, it has nothing to roll off and simply darkens
    // the midtones: the first attempt at this came out looking like dusk. The
    // fix is not a gentler curve, it is a brighter scene. The lights below are
    // raised to match, so the highlights genuinely go over 1 and the curve
    // does the job it exists for.
    // Raised when the ground and the cars became physically based. A PBR
    // surface with a true albedo is a much darker number than the hand-picked
    // diffuse colour it replaced — real tarmac reflects about a tenth of what
    // hits it — so the scene went murky at an exposure that had been correct.
    // Exposure is the right dial for that: the materials stay honest and the
    // camera is opened up, which is exactly what a photographer would do.
    image.exposure = 1.35;
    image.contrast = 1.08;
    // The grade, and it is one step: pull global saturation DOWN a notch.
    // Everything in the frame is authored a little too pure — the eye of a
    // procedural palette always is — and a uniform pull toward neutral is
    // what a colourist would reach for first. Shadows lose slightly more
    // than highlights, which cools them the way open-sky shade actually is.
    const curves = new ColorCurves();
    curves.globalSaturation = -8;
    curves.shadowsSaturation = -14;
    curves.highlightsSaturation = -4;
    image.colorCurves = curves;
    image.colorCurvesEnabled = true;
    // No vignette, and I tried one. In the isometric view the corners of the
    // frame are SKY, and darkening the sky does not read as a lens — it reads
    // as a dirty screen. A vignette wants a camera pointed at a subject, and
    // half the views here are not.
    image.vignetteEnabled = false;
  }

  #createSky(config: SimConfig): void {
    const racing = config.track.enabled && config.trackPath.length >= 2;
    // A circuit gets daylight; everything else keeps the darker arena mood it
    // was designed against, so this does not quietly restyle fifteen modes.
    const horizon = racing ? new Color3(0.55, 0.65, 0.78) : new Color3(0.09, 0.11, 0.16);
    this.scene.clearColor = horizon.toColor4(1);

    // A circuit gets a real sky rather than a flat fill. It is the same
    // gradient the cars reflect, which is the point: a car mirroring a sky
    // nobody can see is a car from a different scene. The other modes keep
    // their flat backdrop — the arena is meant to read as a room.
    if (racing) createSkyDome(this.scene);

    this.scene.fogMode = Scene.FOGMODE_LINEAR;
    this.scene.fogColor = horizon;
    // Starts well out so nothing a driver is actually looking at is hazed, and
    // ends past the arena so the walls dissolve into the horizon rather than
    // stopping against it.
    // Far out, and retuned once the scene was properly lit. Fog set for a dark
    // scene is barely visible; the same fog over a bright one washes the whole
    // mid-distance flat, because there is far more light for it to scatter.
    // Only the genuine distance should haze.
    const span = Math.max(config.arenaHalfExtentX, config.arenaHalfExtentZ);
    this.scene.fogStart = span * (racing ? 1.1 : 0.8);
    this.scene.fogEnd = span * 3;
  }

  #createLights(config: SimConfig): ShadowGenerator | null {
    const racing = config.track.enabled && config.trackPath.length >= 2;

    const ambient = new HemisphericLight('ambient', new Vector3(0, 1, 0), this.scene);
    // Lit for a tone-mapped pipeline, so these are deliberately hot: see
    // `#applyToneMapping`. The split between ambient and sun is the SHADOW
    // CONTRAST dial: ambient is the light a shadow still receives, so the
    // ratio between the two is how dark a shadow can possibly be. It used to
    // sit near 1:4, which is why the whole scene read as flatly, evenly lit —
    // shadows could never be more than a quarter-step darker than the sun.
    ambient.intensity = racing ? 0.38 : 0.55;
    // Bounced light takes the colour of what it bounced off. Outdoors that is
    // sky above and ground below, and saying so is most of what separates a
    // scene that looks lit from one that looks tinted.
    ambient.diffuse = racing ? new Color3(0.82, 0.88, 1) : new Color3(1, 1, 1);
    ambient.groundColor = racing ? new Color3(0.24, 0.26, 0.21) : new Color3(0.12, 0.13, 0.18);

    // The direction comes from the sky, so the disc a player can see and the
    // light casting their shadow are one fact rather than two constants that
    // can drift. A sun in the wrong half of the sky is wrongness everybody
    // feels and nobody names.
    this.#sun = new DirectionalLight(
      'sun',
      new Vector3(SUN_TRAVEL.x, SUN_TRAVEL.y, SUN_TRAVEL.z),
      this.scene,
    );
    this.#sun.position = new Vector3(-SUN_TRAVEL.x * 40, -SUN_TRAVEL.y * 40, -SUN_TRAVEL.z * 40);
    this.#sun.intensity = racing ? 2.8 : 1.1;
    // Warm, because sunlight is. A neutral key against a cool sky is what
    // makes a scene read as fluorescent.
    if (racing) this.#sun.diffuse = new Color3(1, 0.96, 0.86);

    const span = Math.max(config.arenaHalfExtentX, config.arenaHalfExtentZ);
    this.#sun.shadowMinZ = 1;
    this.#sun.shadowMaxZ = span * 6;

    return this.#createShadows(this.#governor.tier);
  }

  /**
   * The shadow generator a tier can afford. Three genuinely different rigs:
   *
   * ```
   *   low     512 blurred exponential map — soft blobs under the cars.
   *   medium  quality.shadowMapSize, same technique, sharper.
   *   high    CASCADED shadow map: the treeline, the tyre walls and the
   *           boards all cast, and the map follows the camera so near
   *           shadows are sharp and far ones are cheap.
   * ```
   *
   * The cascade rig is the difference between "a game with shadows under the
   * cars" and "an outdoor scene": a world where nothing tall throws shade
   * reads as evenly lit from everywhere, which is exactly the flat look this
   * whole pass exists to kill. It is also several hundred extra draws into
   * the shadow map, which is why it is high-tier only.
   *
   * `quality.shadowMapSize` was, before this, defined in the tier table and
   * then never read — the constructor sniffed the pointer type instead. The
   * tier is the policy; it decides now.
   */
  #createShadows(tier: QualityTier): ShadowGenerator | null {
    if (!this.#sun) return null;
    const quality = qualitySettings(tier);
    try {
      if (quality.cascadedShadows) {
        const cascades = new CascadedShadowGenerator(quality.shadowMapSize, this.#sun);
        cascades.numCascades = 2;
        // Bias the split toward the near field: the far cascade only has to
        // catch the treeline, which nobody reads closely.
        cascades.lambda = 0.85;
        cascades.stabilizeCascades = true;
        // Follows the fog: past it a shadow would land on haze anyway.
        const span = Math.max(this.#config.arenaHalfExtentX, this.#config.arenaHalfExtentZ);
        cascades.shadowMaxZ = span * 3;
        cascades.bias = 0.012;
        cascades.normalBias = 0.02;
        // Alpha-tested casters: the pine cards must punch tree-shaped holes
        // in the light, not card-shaped ones.
        cascades.transparencyShadow = true;
        cascades.usePercentageCloserFiltering = true;
        cascades.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
        cascades.darkness = 0.25;
        return cascades;
      }

      const shadows = new ShadowGenerator(quality.shadowMapSize, this.#sun);
      shadows.useBlurExponentialShadowMap = true;
      shadows.blurKernel = quality.shadowMapSize <= 512 ? 16 : 24;
      shadows.darkness = 0.3;
      return shadows;
    } catch {
      // Some software renderers refuse the shadow map format. Losing shadows
      // is strictly better than losing the whole scene.
      return null;
    }
  }

  /**
   * The arena boundary.
   *
   * A circuit's is physically based, and that is not gilding: it is the only
   * vertical surface of any size in the scene, so it is the one thing lit
   * almost entirely by the sky rather than by the sun. A classic material
   * gets no light from an environment at all, which is why this used to be a
   * hard BLACK band across the horizon whenever the boundary happened to face
   * away from the sun — pale concrete rendering as a hole in the world. Given
   * something to reflect, the same wall takes the sky's colour on every side
   * and recedes the way distance actually looks.
   *
   * The arena modes keep the classic material and their dark navy: indoors
   * there is no sky to catch, and the wall of night is the point there.
   */
  #wallMaterial(racing: boolean): Material {
    if (!racing) {
      const material = new StandardMaterial('wall:mat', this.scene);
      material.diffuseColor = Color3.FromHexString('#39415a');
      material.specularColor = new Color3(0.1, 0.1, 0.12);
      return material;
    }
    const material = new PBRMaterial('wall:mat', this.scene);
    material.albedoColor = Color3.FromHexString('#787f8a').toLinearSpace();
    material.metallic = 0.2;
    // Rough enough to have no highlight of its own, so all it ever shows is
    // the sky's own brightness — and corrugated, because a flat slab the
    // length of the horizon is the fastest way to look like a demo. The tiling
    // is coarse: this wall is only ever seen from far away.
    material.roughness = 0.72;
    const steel = createSurface(this.scene, 'wall:steel', corrugation(128), {
      size: 128,
      uScale: 48,
      vScale: 1,
      strength: 7,
      withNormal: qualitySettings(this.#governor.tier).normalMaps,
    });
    material.bumpTexture = steel.normal;
    return material;
  }

  #createArena(config: SimConfig, obstacles: readonly Obstacle[]): void {
    // A circuit's ground runs well past the arena, out beyond where the fog
    // has finished. The arena walls still mark the play area; what changes is
    // that the WORLD no longer stops there. From any raised camera the old
    // ground read as a slab floating in space, with a cliff edge and sky
    // underneath it — which is the single fastest way to make a landscape look
    // like a diorama. Land that fades into haze reads as land that continues.
    const groundHalf = groundExtent(config);
    const width = groundHalf.x * 2;
    const depth = groundHalf.z * 2;

    // A deep slab, not a plane. A zero-thickness ground is invisible to the
    // side-on camera, which would leave a platformer's characters standing on
    // nothing; a *thin* one leaves a band of void under the level. Making it
    // deep means everything below the floor reads as solid earth. The top
    // face still sits exactly at y = 0, where the simulation puts the floor.
    const groundThickness = 8;
    const ground = CreateBox('ground', { width, height: groundThickness, depth }, this.scene);
    ground.position.y = -groundThickness / 2;
    // A circuit gets grass. The road is the one thing a driver has to be able
    // to find instantly, and grey-on-grey is a road you discover by leaving it.
    const racing = config.track.enabled && config.trackPath.length >= 2;
    if (racing) {
      // Real turf, physically lit, tiled every few metres. The checker below
      // is a placeholder for a plane with nothing on it; a circuit deserves
      // better, and the grass/tarmac contrast is a driver's fastest read of
      // where the road is.
      const material = new PBRMaterial('ground:mat', this.scene);
      const surface = createSurface(this.scene, 'ground', grass(GRASS_TEXTURE_SIZE), {
        size: GRASS_TEXTURE_SIZE,
        uScale: Math.max(1, Math.round(width / GRASS_TILE)),
        vScale: Math.max(1, Math.round(depth / GRASS_TILE)),
        strength: 7,
        withNormal: qualitySettings(this.#governor.tier).normalMaps,
      });
      material.albedoTexture = surface.albedo;
      if (surface.normal) material.bumpTexture = surface.normal;
      material.metallic = 0;
      // As diffuse as anything in the scene. Grass has no sheen at all, and
      // the flatness is what makes the tarmac beside it look wet by contrast.
      material.roughness = 0.96;
      ground.material = material;
      ground.receiveShadows = true;
    } else {
      const groundMaterial = new StandardMaterial('ground:mat', this.scene);
      const checker = createCheckerTexture(this.scene, { cells: Math.round(width / 3) });
      checker.wrapU = Texture.WRAP_ADDRESSMODE;
      checker.wrapV = Texture.WRAP_ADDRESSMODE;
      groundMaterial.diffuseTexture = checker;
      groundMaterial.specularColor = new Color3(0.05, 0.05, 0.06);
      ground.material = groundMaterial;
      ground.receiveShadows = true;
    }

    const wallMaterial = this.#wallMaterial(racing);

    const wallHeight = 2.5;
    const wallThickness = 0.6;
    const hidden = this.#hiddenWallsFor(this.#view);
    const wallWidth = config.arenaHalfExtentX * 2;
    const wallDepth = config.arenaHalfExtentZ * 2;
    const allWalls: Array<{ w: number; d: number; x: number; z: number; side: WallSide }> = [
      {
        w: wallWidth + wallThickness * 2,
        d: wallThickness,
        x: 0,
        z: config.arenaHalfExtentZ,
        side: 'northZ',
      },
      {
        w: wallWidth + wallThickness * 2,
        d: wallThickness,
        x: 0,
        z: -config.arenaHalfExtentZ,
        side: 'southZ',
      },
      { w: wallThickness, d: wallDepth, x: config.arenaHalfExtentX, z: 0, side: 'eastX' },
      { w: wallThickness, d: wallDepth, x: -config.arenaHalfExtentX, z: 0, side: 'westX' },
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
