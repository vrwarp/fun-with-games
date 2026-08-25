/**
 * A scenery inspection stage — a dev harness, not part of the game.
 *
 * Serve the repo with vite and open `/probe.html` to see the game's pine
 * assembly (cards + trunk, same texture generator, same materials) on a
 * plain ground against a bright horizon — the worst case for canopy
 * see-through — with all five species in a row. This exists because a
 * screenshot of the full game is a terrible microscope: every visual defect
 * chased this far (shadows, foliage transparency) was diagnosed faster on a
 * minimal stage where one thing varies at a time.
 *
 * Never imported by the app; `npm run build` does not bundle it.
 *
 *   ?alpha=0.4   alpha cutoff to test
 *   ?yaw=0.5     camera azimuth in radians
 *   ?beta=1.3    camera elevation (PI/2 is eye level)
 *   ?radius=26   camera distance
 */
import { Engine } from '@babylonjs/core/Engines/engine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera.js';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { createSkyDome, createSkyEnvironment, SUN_TRAVEL } from './render/environment.js';
import { createPineTexture } from './render/textures.js';
import { assemblePine } from './render/scenery.js';

const q = new URLSearchParams(location.search);
const canvas = document.querySelector('#c') as HTMLCanvasElement;
const engine = new Engine(canvas, true, { preserveDrawingBuffer: true });
const scene = new Scene(engine);
createSkyEnvironment(scene);
createSkyDome(scene);

const camera = new ArcRotateCamera(
  'cam',
  Number(q.get('yaw') ?? -1.35),
  Number(q.get('beta') ?? 1.32),
  Number(q.get('radius') ?? 26),
  new Vector3(0, 4, 0),
  scene,
);
camera.attachControl(canvas, false);
camera.minZ = 0.5;
camera.maxZ = 400;

const sun = new DirectionalLight(
  'sun',
  new Vector3(SUN_TRAVEL.x, SUN_TRAVEL.y, SUN_TRAVEL.z),
  scene,
);
sun.intensity = 4.6;
sun.diffuse = new Color3(1, 0.9, 0.72);
const ambient = new HemisphericLight('amb', new Vector3(0, 1, 0), scene);
ambient.intensity = 0.5;
ambient.diffuse = new Color3(0.78, 0.86, 1);
ambient.groundColor = new Color3(0.34, 0.36, 0.28);

const ground = CreateGround('ground', { width: 120, height: 60 }, scene);
const grass = new PBRMaterial('g', scene);
grass.albedoColor = new Color3(0.32, 0.42, 0.2).toLinearSpace();
grass.metallic = 0;
grass.roughness = 0.95;
ground.material = grass;

// The game's five species — mirror TREE_SPECIES in scenery.ts. Kept as a
// copy only because that constant is private; the ASSEMBLY comes from the
// real `assemblePine`, so geometry and arrangement can never drift.
const SPECIES = [
  { leaf: new Color3(0.12, 0.23, 0.11), height: 8.4, width: 4.4 },
  { leaf: new Color3(0.17, 0.26, 0.1), height: 6.2, width: 5.2 },
  { leaf: new Color3(0.14, 0.21, 0.13), height: 7.2, width: 4.8 },
  { leaf: new Color3(0.08, 0.16, 0.08), height: 9, width: 4.2 },
  { leaf: new Color3(0.2, 0.28, 0.12), height: 6.8, width: 5 },
];

const cutoff = Number(q.get('alpha') ?? 0.4);
const bark = new PBRMaterial('bark', scene);
bark.albedoColor = new Color3(0.14, 0.1, 0.07).toLinearSpace();
bark.metallic = 0;
bark.roughness = 0.95;

SPECIES.forEach((species, index) => {
  const texture = createPineTexture(scene, index * 17 + 3, {
    r: species.leaf.r,
    g: species.leaf.g,
    b: species.leaf.b,
  });
  const material = new PBRMaterial(`pine${index}`, scene);
  material.albedoTexture = texture;
  texture.hasAlpha = true;
  material.useAlphaFromAlbedoTexture = true;
  material.transparencyMode = PBRMaterial.MATERIAL_ALPHATEST;
  material.alphaCutOff = cutoff;
  material.metallic = 0;
  material.roughness = 1;
  material.backFaceCulling = false;
  material.twoSidedLighting = true;
  material.specularIntensity = 0.05;

  const merged = assemblePine(scene, index, species, material, bark);
  if (merged) merged.position.x = -24 + index * 12;
});

let frames = 0;
engine.runRenderLoop(() => {
  scene.render();
  frames += 1;
  (window as unknown as { __PROBE__: number }).__PROBE__ = frames;
});
