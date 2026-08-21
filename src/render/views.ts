import { Camera } from '@babylonjs/core/Cameras/camera.js';
import type { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera.js';

/**
 * How the world is framed. This is the whole difference between a 3D game, a
 * 2.5D game and a 2D game in this kit — the simulation is identical for all
 * of them, because it has always been a plane.
 *
 * | id       | look                                    | camera            |
 * | -------- | --------------------------------------- | ----------------- |
 * | `follow` | third-person 3D, swings behind you      | perspective       |
 * | `iso`    | 2.5D isometric, fixed diagonal          | orthographic      |
 * | `topdown`| flat 2D from directly overhead          | orthographic      |
 * | `side`   | 2D side-scroller, one lane deep         | orthographic      |
 *
 * View is **presentation only**: it never reaches the simulation, is not part
 * of the room's config, and two players in the same room may legitimately be
 * looking at the same match in different projections.
 */
export type ViewMode = 'follow' | 'iso' | 'topdown' | 'side';

export const VIEW_MODES: readonly ViewMode[] = ['follow', 'iso', 'topdown', 'side'];

export function isViewMode(value: string | null | undefined): value is ViewMode {
  return VIEW_MODES.includes(value as ViewMode);
}

/** Arena wall sides, named by the axis they sit on. */
export type WallSide = 'northZ' | 'southZ' | 'eastX' | 'westX';

export interface ViewSpec {
  /** Orbit angle around Y. Fixed for every view except `follow`. */
  readonly alpha: number;
  /** Polar angle from straight up. Small = more overhead. */
  readonly beta: number;
  /** Perspective distance, and the ortho framing distance. */
  readonly radius: number;
  /** Orthographic half-height in world units; undefined = perspective. */
  readonly orthoHalfHeight?: number;
  /** Whether the camera swings to follow the direction of travel. */
  readonly autoFollow: boolean;
  /** Whether dragging/wheel may take the camera over. */
  readonly manualControl: boolean;
  /** Height above the player's feet that the camera aims at. */
  readonly targetHeight: number;
  /**
   * Walls to leave out because they stand between this camera and the game.
   *
   * A fixed camera cannot orbit around an obstruction the way the follow
   * camera can, so a side-on view would otherwise spend the match looking at
   * the back of a wall. Omitting the near walls is the standard fix, and it
   * costs nothing: the simulation still bounds the arena, the boundary just
   * stops being drawn from the one angle where it would hide everything.
   */
  readonly hiddenWalls: readonly WallSide[];
}

/**
 * `ArcRotateCamera` sits at `target + r * (cos a sin b, cos b, sin a sin b)`.
 * These alphas are chosen so "up the screen" is -Z for the overhead views and
 * so the side view looks down -X, which keeps `cameraYaw` (and therefore
 * input) sane in every projection.
 */
const SPECS: Record<ViewMode, ViewSpec> = {
  follow: {
    alpha: -Math.PI / 2,
    beta: Math.PI / 3.2,
    radius: 22,
    autoFollow: true,
    manualControl: true,
    targetHeight: 1,
    // The follow camera orbits, so no wall is reliably "the near one".
    hiddenWalls: [],
  },
  iso: {
    // A true isometric-ish diagonal: 45° around, ~35° down.
    alpha: -Math.PI / 4,
    beta: Math.PI / 3.4,
    radius: 34,
    orthoHalfHeight: 15,
    autoFollow: false,
    // An isometric view you can drag off its axis stops being isometric, and
    // a top-down or side view is defined by its angle too. Only the free 3D
    // camera hands control to the player.
    manualControl: false,
    targetHeight: 1,
    // Camera sits over +X / -Z, so those two walls are between it and play.
    hiddenWalls: ['southZ', 'eastX'],
  },
  topdown: {
    alpha: -Math.PI / 2,
    // Not exactly 0: a hair of tilt keeps player capsules readable as bodies
    // rather than as discs, which is the difference between a game you can
    // parse at a glance and a radar screen.
    beta: 0.12,
    radius: 40,
    orthoHalfHeight: 16,
    autoFollow: false,
    manualControl: false,
    targetHeight: 0,
    // Looking almost straight down: every wall is below the camera.
    hiddenWalls: [],
  },
  side: {
    // Camera parked on -Z looking back along +Z at the z = 0 lane, a touch
    // above eye level. That alpha is what puts +X to the right of the screen,
    // so a level authored left-to-right reads left-to-right.
    alpha: -Math.PI / 2,
    beta: Math.PI / 2.05,
    radius: 30,
    orthoHalfHeight: 7,
    autoFollow: false,
    manualControl: false,
    targetHeight: 1.6,
    // The camera is parked outside the -Z wall; drawing it would mean
    // watching a side-scroller through a fence.
    hiddenWalls: ['southZ'],
  },
};

export function viewSpec(view: ViewMode): ViewSpec {
  return SPECS[view];
}

/**
 * Applies a view's projection to the camera, sizing the orthographic frustum
 * for the current aspect ratio.
 *
 * Babylon's ortho box is absolute, not aspect-derived, so it has to be
 * recomputed on every resize — otherwise a phone rotating to landscape
 * squashes the whole world.
 */
export function applyView(
  camera: ArcRotateCamera,
  view: ViewMode,
  widthPx: number,
  heightPx: number,
  portrait: boolean,
): void {
  const spec = SPECS[view];

  camera.alpha = spec.alpha;
  camera.beta = spec.beta;
  camera.radius = spec.radius;

  if (spec.orthoHalfHeight === undefined) {
    camera.mode = Camera.PERSPECTIVE_CAMERA;
    // Portrait is narrow: pull back and tilt down or a third of the screen is
    // sky and you walk into things you never saw.
    camera.radius = portrait ? spec.radius + 3 : spec.radius;
    camera.beta = portrait ? Math.PI / 4 : spec.beta;
    return;
  }

  camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
  // Portrait phones get a little more of the world vertically, since that is
  // the axis they actually have to spare.
  const halfHeight = spec.orthoHalfHeight * (portrait ? 1.25 : 1);
  const aspect = widthPx > 0 && heightPx > 0 ? widthPx / heightPx : 1;
  const halfWidth = halfHeight * aspect;

  camera.orthoTop = halfHeight;
  camera.orthoBottom = -halfHeight;
  camera.orthoLeft = -halfWidth;
  camera.orthoRight = halfWidth;
}
