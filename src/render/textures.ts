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
  const width = 256;
  const height = 64;
  const texture = new DynamicTexture('kerb', { width, height }, scene, false);
  const ctx = context2d(texture);

  // Split along the texture's WIDTH, because a kerb ribbon runs its `u` axis
  // down the road: stripes have to alternate as you drive past them, not
  // across the 0.9 metres of paint.
  //
  // Weathered, not poster-fresh. The old two-colour chip (#e63946 on
  // #f1f1f1) was the highest-chroma object in every frame — brighter than
  // the cars — and paint that has been rained on and driven over for a
  // season is nearer brick than pillar-box. The valleys between the ribs
  // collect grime (phase-matched to `kerbRibs`, which puts four ribs along
  // u), the outer edge darkens as a painted chamfer, and a few rubber
  // scuffs cross where tyres actually touch.
  ctx.fillStyle = '#d8d3c8';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#b0363c';
  ctx.fillRect(0, 0, width / 2, height);

  // Grime in the rib valleys. kerbRibs' triangle wave rises and falls once
  // per quarter of the tile, with its valleys at u = 0, 1/4, 1/2, 3/4.
  const ribs = 4;
  for (let rib = 0; rib <= ribs; rib++) {
    const at = (width * rib) / ribs;
    const grime = ctx.createLinearGradient(at - 10, 0, at + 10, 0);
    grime.addColorStop(0, 'rgba(30, 26, 22, 0)');
    grime.addColorStop(0.5, 'rgba(30, 26, 22, 0.35)');
    grime.addColorStop(1, 'rgba(30, 26, 22, 0)');
    ctx.fillStyle = grime;
    ctx.fillRect(at - 10, 0, 20, height);
  }

  // The chamfer: the outer 20% of the kerb's width falls away from the sun,
  // painted as a darkening ramp because the band geometry is flat.
  const chamfer = ctx.createLinearGradient(0, height * 0.78, 0, height);
  chamfer.addColorStop(0, 'rgba(20, 18, 16, 0)');
  chamfer.addColorStop(1, 'rgba(20, 18, 16, 0.45)');
  ctx.fillStyle = chamfer;
  ctx.fillRect(0, Math.floor(height * 0.78), width, height);

  // Rubber scuffs where the inside wheels clip: sparse, dark, streaked
  // along u. Hashed positions so every kerb segment weathers identically —
  // the texture tiles, so variety must come cheap or not at all.
  ctx.fillStyle = 'rgba(24, 24, 26, 0.3)';
  for (let i = 0; i < 5; i++) {
    const at = jitter(i * 13 + 5, 3) * width;
    const y = jitter(i * 7 + 1, 11) * height * 0.5;
    ctx.fillRect(at, y, 14 + jitter(i, 29) * 22, 2 + jitter(i, 31) * 3);
  }

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

/** Deterministic value in [0,1) — art must not differ between two runs. */
function jitter(a: number, b: number): number {
  let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * A conifer, drawn — the side view for the crossed cards a tree is made of.
 *
 * The cones this replaces were the single loudest "1997" in the frame, and no
 * material could save them, because what fails on a cone is the SILHOUETTE:
 * real conifers are ragged. Drawing one buys exactly that — dozens of drooping
 * frond strokes with jittered lengths, gaps where branches are missing,
 * darker in the interior where a canopy shades itself, warmer at the sunlit
 * tips. All of it alpha-cut, so the sky shows through the edges.
 *
 * `seed` varies the raggedness so the three species do not share one outline.
 */
export function createPineTexture(
  scene: Scene,
  seed: number,
  base: { r: number; g: number; b: number },
): DynamicTexture {
  const width = 192;
  const height = 384;
  const texture = new DynamicTexture(
    `pine:${seed}`,
    { width, height },
    scene,
    // Mipmaps on: these cards live at every distance from kerbside to fog.
    true,
  );
  texture.hasAlpha = true;
  const ctx = context2d(texture);
  ctx.clearRect(0, 0, width, height);

  const centre = width / 2;
  const crownY = 14;
  const skirtY = height - 44;

  // Trunk first, so fronds overlap it.
  ctx.fillStyle = 'rgb(52, 38, 26)';
  ctx.fillRect(centre - 5, height - 90, 10, 90);

  // Fronds, in rows from the skirt up to the crown. Painter's order matters:
  // lower (wider, darker) rows first, so upper rows overlap them the way real
  // branches sit in front of the ones below.
  const rows = 24;
  for (let row = 0; row < rows; row++) {
    const t = row / (rows - 1); // 0 at skirt, 1 at crown
    const y = skirtY - t * (skirtY - crownY);
    const reach = (1 - t * 0.92) * (width * 0.46);
    const strokes = Math.max(3, Math.round((1 - t) * 9) + 3);

    for (let i = 0; i < strokes; i++) {
      const u = strokes === 1 ? 0 : (i / (strokes - 1)) * 2 - 1;
      // Gaps: a few percent of branches simply are not there.
      if (jitter(seed * 91 + row, i * 7) < 0.06) continue;

      const droop = 10 + jitter(seed + row, i) * 14;
      const length = reach * (0.55 + jitter(seed * 3 + row, i * 5) * 0.6);
      const x = centre + u * reach * 0.55;
      const tipX = x + Math.sign(u || jitter(row, i) - 0.5) * length * 0.55;

      // Interior fronds darker, outer tips lighter and warmer — the two-tone
      // that makes a canopy read as lit volume rather than flat card.
      const out = Math.min(1, Math.abs(u) * 0.8 + jitter(seed + i, row * 3) * 0.35);
      // Capped low: brighter tips sparkle into white flecks once the texture
      // is minified across a whole forest, and a forest full of glitter reads
      // as aliasing, not light.
      const lum = 0.55 + out * 0.5;
      const r = Math.round(base.r * lum * 255);
      const g = Math.round(base.g * lum * 255);
      const b = Math.round(base.b * lum * 255);
      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;

      ctx.beginPath();
      ctx.moveTo(x, y - 6 - jitter(row, seed + i) * 6);
      ctx.lineTo(tipX, y + droop);
      ctx.lineTo(x + (tipX - x) * 0.35, y + droop * 0.35);
      ctx.closePath();
      ctx.fill();
    }
  }

  // The leader — the single vertical tip every conifer has.
  ctx.fillStyle = `rgb(${Math.round(base.r * 150)}, ${Math.round(base.g * 165)}, ${Math.round(
    base.b * 140,
  )})`;
  ctx.beginPath();
  ctx.moveTo(centre, 2);
  ctx.lineTo(centre + 7, crownY + 26);
  ctx.lineTo(centre - 7, crownY + 26);
  ctx.closePath();
  ctx.fill();

  texture.update();
  return texture;
}

/**
 * A trackside advertising board: a bold made-up name on a bright panel.
 *
 * Real circuits are LINED with these, and their absence is much of why a
 * home-made track reads as an empty field. The names are invented — a real
 * brand would be a licence problem and a lie.
 */
export function createBoardTexture(
  scene: Scene,
  text: string,
  background: string,
  foreground: string,
): DynamicTexture {
  const width = 512;
  const height = 96;
  const texture = new DynamicTexture(`board:${text}`, { width, height }, scene, true);
  const ctx = context2d(texture);

  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);
  // A thin frame, so the board reads as an object rather than paint.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
  ctx.fillRect(0, 0, width, 6);
  ctx.fillRect(0, height - 6, width, 6);

  ctx.fillStyle = foreground;
  ctx.font = `700 ${Math.round(height * 0.56)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, width / 2, height / 2 + 2);

  texture.update();
  return texture;
}
