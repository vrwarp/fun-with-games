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

/**
 * Draws a chunky character sprite for the 2D/2.5D views.
 *
 * Procedural for the same reason everything else here is: the repo ships no
 * binaries, so `npm run dev` gives a game that looks deliberate with nothing
 * downloaded. The art is a blocky little figure on a transparent background —
 * head, body, arms, legs, a dark outline — tinted by the player's colour, so
 * every player reads as the same character in their own hue.
 *
 * Pixels are drawn on a small grid and scaled up with filtering disabled,
 * which is what makes the edges crisp instead of soft.
 */
export function createSpriteTexture(scene: Scene, color: string): DynamicTexture {
  // 16x16 cells at 8px each: small enough to read as pixel art, big enough
  // not to shimmer when the camera moves.
  const cells = 16;
  const cell = 8;
  const size = cells * cell;

  const texture = new DynamicTexture(`sprite:${color}`, { width: size, height: size }, scene, true);
  texture.hasAlpha = true;
  // Nearest-neighbour: the whole point of pixel art is hard edges.
  texture.updateSamplingMode(1);

  const ctx = context2d(texture);
  ctx.clearRect(0, 0, size, size);

  const shade = shiftColor(color, -0.35);
  const light = shiftColor(color, 0.3);
  const px = (gx: number, gy: number, w: number, h: number, fill: string): void => {
    ctx.fillStyle = fill;
    ctx.fillRect(gx * cell, gy * cell, w * cell, h * cell);
  };

  // Outline, drawn first as a silhouette one cell larger on each side.
  const outline = 'rgba(0, 0, 0, 0.85)';
  px(5, 1, 6, 5, outline); // head
  px(4, 6, 8, 6, outline); // torso + arms
  px(5, 12, 6, 4, outline); // legs

  px(6, 2, 4, 3, light); // face
  px(6, 4, 4, 1, shade); // chin shadow
  px(5, 7, 6, 4, color); // torso
  px(4, 7, 1, 3, color); // left arm
  px(11, 7, 1, 3, color); // right arm
  px(6, 11, 2, 4, shade); // left leg
  px(9, 11, 2, 4, shade); // right leg

  // Eyes last so they sit on top of the face block.
  px(7, 3, 1, 1, '#101319');
  px(9, 3, 1, 1, '#101319');

  texture.update();
  return texture;
}

/** Lightens (positive) or darkens (negative) a `#rgb`/`#rrggbb` colour. */
function shiftColor(hex: string, amount: number): string {
  const normalized =
    hex.length === 4
      ? `#${hex[1] ?? '0'}${hex[1] ?? '0'}${hex[2] ?? '0'}${hex[2] ?? '0'}${hex[3] ?? '0'}${hex[3] ?? '0'}`
      : hex;
  const value = Number.parseInt(normalized.slice(1), 16);
  if (!Number.isFinite(value)) return hex;

  const channel = (shift: number): number => {
    const base = (value >> shift) & 0xff;
    const moved = amount >= 0 ? base + (255 - base) * amount : base * (1 + amount);
    return Math.max(0, Math.min(255, Math.round(moved)));
  };

  const to2 = (n: number): string => n.toString(16).padStart(2, '0');
  return `#${to2(channel(16))}${to2(channel(8))}${to2(channel(0))}`;
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

/**
 * Red-and-white kerbing, as a strip that tiles along a kerb ribbon.
 *
 * Drawn rather than shipped: the whole renderer has to work on a fresh clone
 * with no binary assets, and a kerb is four rectangles.
 */
export function createKerbTexture(scene: Scene): DynamicTexture {
  const width = 64;
  const height = 16;
  const texture = new DynamicTexture('kerb', { width, height }, scene, false);
  const ctx = context2d(texture);

  // Split along the texture's WIDTH, because a kerb ribbon runs its `u` axis
  // down the road: stripes have to alternate as you drive past them, not
  // across the 0.9 metres of paint.
  ctx.fillStyle = '#f1f1f1';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#e63946';
  ctx.fillRect(0, 0, width / 2, height);

  texture.update();
  return texture;
}

/** The chequered board painted across the road at the start/finish line. */
export function createStartLineTexture(scene: Scene): DynamicTexture {
  // Two rows deep, like the real thing. `u` spans the board's short depth and
  // `v` runs across the road, so the cell counts are asymmetric on purpose.
  const cell = 32;
  const texture = new DynamicTexture(
    'startline',
    { width: cell * 2, height: cell * 2 },
    scene,
    false,
  );
  const ctx = context2d(texture);

  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 2; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? '#f8f9fa' : '#15171d';
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }

  texture.update();
  return texture;
}
