/**
 * A car inspection stage — a dev harness, not part of the game.
 *
 * Serve the repo with vite and open `/studio.html` to see the game's car
 * (same `buildCarMesh`, same `CarFinishes`, top-tier finishes) parked on a
 * plain studio floor under the game's own sun. This exists for the same
 * reason the tree stage does: a screenshot of a race is a terrible
 * microscope. Judging the car's SHAPE needs the customary modelling views —
 * orthographic front/rear/side/top elevations and perspective
 * three-quarters — with nothing else in frame.
 *
 * `scripts/car-studio.mjs` drives this page headlessly and writes the whole
 * turnaround sheet as PNGs, ready to put in front of a critic.
 *
 * Never imported by the app; `npm run build` does not bundle it.
 *
 *   ?yaw=1.57     camera azimuth in radians (pi/2 faces the nose)
 *   ?beta=1.35    camera elevation (pi/2 is eye level, ~0 is overhead)
 *   ?radius=9     camera distance
 *   ?ortho=1      orthographic projection (the modelling-sheet convention)
 *   ?span=2.6     ortho half-width of frame, world units
 *   ?paint=cc2233 livery colour
 *   ?steer=0.3    front-wheel steering angle, to check the uprights
 *   ?drs=1        lay the rear-wing flap flat
 */
import { Engine } from '@babylonjs/core/Engines/engine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera.js';
import { Camera } from '@babylonjs/core/Cameras/camera.js';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator.js';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent.js';
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { createSkyDome, createSkyEnvironment, SUN_TRAVEL } from './render/environment.js';
import { CarFinishes } from './render/carmaterials.js';
import { buildCarMesh } from './render/carmesh.js';

const q = new URLSearchParams(location.search);
const canvas = document.querySelector('#c') as HTMLCanvasElement;
const engine = new Engine(canvas, true, { preserveDrawingBuffer: true });
const scene = new Scene(engine);
createSkyEnvironment(scene);
createSkyDome(scene);

/** Grandprix's `playerRadius` — the scale every car in the game is drawn at. */
const RADIUS = 0.7;

const camera = new ArcRotateCamera(
  'cam',
  Number(q.get('yaw') ?? Math.PI / 2 - 0.7),
  Number(q.get('beta') ?? 1.2),
  Number(q.get('radius') ?? 9),
  new Vector3(0, RADIUS * 0.8, 0),
  scene,
);
camera.attachControl(canvas, false);
camera.minZ = 0.1;
camera.maxZ = 300;
if (q.get('ortho') === '1') {
  // The modelling-sheet convention: elevations carry measurements, and only
  // a projection with no foreshortening lets a viewer compare lengths.
  const span = Number(q.get('span') ?? 2.6);
  const aspect = engine.getRenderWidth() / Math.max(1, engine.getRenderHeight());
  camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
  camera.orthoLeft = -span;
  camera.orthoRight = span;
  camera.orthoTop = span / aspect;
  camera.orthoBottom = -span / aspect;
}

const sun = new DirectionalLight(
  'sun',
  new Vector3(SUN_TRAVEL.x, SUN_TRAVEL.y, SUN_TRAVEL.z),
  scene,
);
sun.intensity = 4.6;
sun.diffuse = new Color3(1, 0.9, 0.72);
sun.position = new Vector3(-SUN_TRAVEL.x * 20, -SUN_TRAVEL.y * 20, -SUN_TRAVEL.z * 20);
const ambient = new HemisphericLight('amb', new Vector3(0, 1, 0), scene);
ambient.intensity = 0.5;
ambient.diffuse = new Color3(0.78, 0.86, 1);
ambient.groundColor = new Color3(0.36, 0.36, 0.38);

// A studio floor, not grass: neutral, slightly warm grey so the paint and
// the carbon read as their own colours, with shadows to ground the car.
const ground = CreateGround('ground', { width: 60, height: 60 }, scene);
const floor = new PBRMaterial('floor', scene);
floor.albedoColor = new Color3(0.3, 0.3, 0.31).toLinearSpace();
floor.metallic = 0;
floor.roughness = 0.85;
ground.material = floor;
ground.receiveShadows = true;

// The real car, top-tier finishes: shape judgements should not be muddied
// by a tier that turned the weave or the lacquer off.
const finishes = new CarFinishes(scene, { normalMaps: true, clearCoat: true });
const paint = finishes.createPaint(
  'studio:paint',
  Color3.FromHexString(`#${q.get('paint') ?? 'c8102e'}`),
);
const wheelMetal = finishes.createWheelMetal('studio:rims');

const root = new TransformNode('studio:root', scene);
// `buildCarMesh` hangs the car `1.7 * radius` below its root (the game's
// root is a capsule centre); lift the root so the tyres sit on the floor.
root.position.y = RADIUS * 1.7;

const car = buildCarMesh(
  scene,
  'studio',
  root,
  {
    paint,
    carbon: finishes.carbon,
    rubber: finishes.rubber,
    metal: finishes.metal,
    wheelMetal,
  },
  RADIUS,
);

const steer = Number(q.get('steer') ?? 0);
for (const wheel of car.wheels) {
  if (wheel.front) wheel.pivot.rotation.y = steer;
}
if (q.get('drs') === '1') car.wing.rotation.x = -1.35;

const shadows = new ShadowGenerator(2048, sun);
shadows.usePercentageCloserFiltering = true;
for (const part of [car.chassis, ...car.parts]) shadows.addShadowCaster(part);

let frames = 0;
engine.runRenderLoop(() => {
  scene.render();
  frames += 1;
  (window as unknown as { __STUDIO__: number }).__STUDIO__ = frames;
});
window.addEventListener('resize', () => engine.resize());
