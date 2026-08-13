import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js';
import type { Scene } from '@babylonjs/core/scene.js';

/**
 * Textures drawn at runtime with the 2D canvas API.
 *
 * The starter ships zero binary art on purpose — `npm install && npm run dev`
 * gives you a game that looks intentional without downloading anything. When
 * real art arrives it replaces these; see `docs/ASSETS.md`.
 */

/**
 * Babylon's `ICanvasRenderingContext` models only the subset of the 2D API it
 * needs internally, and omits text alignment. The underlying object at runtime
 * is a real `CanvasRenderingContext2D`, so widening the type here is safe.
 */
function context2d(texture: DynamicTexture): CanvasRenderingContext2D {
  return texture.getContext() as unknown as CanvasRenderingContext2D;
}

export function createCheckerTexture(
  scene: Scene,
  options: {
    size?: number;
    cells?: number;
    colorA?: string;
    colorB?: string;
    lineColor?: string;
  } = {},
): DynamicTexture {
  const size = options.size ?? 1024;
  const cells = options.cells ?? 16;
  const colorA = options.colorA ?? '#20242e';
  const colorB = options.colorB ?? '#252a35';
  const lineColor = options.lineColor ?? '#39404f';

  const texture = new DynamicTexture('checker', { width: size, height: size }, scene, false);
  const ctx = context2d(texture);
  const cell = size / cells;

  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? colorA : colorB;
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }

  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2;
  for (let i = 0; i <= cells; i++) {
    const p = i * cell;
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, size);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, p);
    ctx.lineTo(size, p);
    ctx.stroke();
  }

  texture.update();
  return texture;
}

/** Renders a player name onto a transparent texture for a billboard label. */
export function createLabelTexture(scene: Scene, text: string, color: string): DynamicTexture {
  const width = 512;
  const height = 128;
  const texture = new DynamicTexture(`label:${text}`, { width, height }, scene, true);
  texture.hasAlpha = true;

  const ctx = context2d(texture);
  ctx.clearRect(0, 0, width, height);

  ctx.font = 'bold 64px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Outline first, so the name stays readable against any background.
  ctx.lineWidth = 10;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
  ctx.strokeText(text, width / 2, height / 2);

  ctx.fillStyle = color;
  ctx.fillText(text, width / 2, height / 2);

  texture.update();
  return texture;
}
