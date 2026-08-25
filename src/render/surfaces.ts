import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import { Constants } from '@babylonjs/core/Engines/constants.js';
import type { Scene } from '@babylonjs/core/scene.js';

/**
 * Surface detail: what a material is made of, drawn rather than downloaded.
 *
 * ## Why normal maps and not more triangles
 *
 * A surface reads as a material because of how light moves across it at a
 * scale far below anything worth modelling. Asphalt is a field of stone chips;
 * carbon fibre is a woven basket; a tyre is grained rubber. None of that is
 * geometry you can afford — a square metre of aggregate is thousands of
 * facets — and all of it is a per-pixel lighting question, which is exactly
 * what a normal map answers.
 *
 * This is the half of "PBR" that actually does the work. Metallic and
 * roughness numbers decide how a surface responds to light; a normal map
 * decides that it has a surface at all. A flat roughness value over a flat
 * triangle is a flat plastic sheet no matter how carefully it is tuned, and a
 * grey road that stays perfectly smooth from 5 metres to 200 is the single
 * loudest "this is a render" signal in a driving game.
 *
 * ## Why the generators are pure
 *
 * `docs/ASSETS.md` forbids shipping binaries, so these are procedural. That
 * leaves a choice about HOW they are procedural, and drawing into a canvas —
 * which is what `textures.ts` does for labels and kerbs — would put them
 * somewhere no test can reach: unit tests run in Node with no DOM and no
 * canvas, and the browser suite has no way to assert on a texel.
 *
 * So the patterns below are plain arithmetic over typed arrays, with no
 * Babylon and no DOM in sight, and only `createSurface` at the bottom touches
 * a scene. A weave that has stopped weaving is then a millisecond to catch
 * rather than something that has to be noticed by eye.
 *
 * ## Everything tiles
 *
 * A road is kilometres long and a texture is 256 texels, so every pattern here
 * wraps: the noise lattice is taken modulo its own period, which is what makes
 * the right edge continue into the left. Getting this wrong shows up as a
 * visible grid over the whole circuit, once per tile, forever.
 */

/** A tileable surface, as the two things a material needs to know about it. */
export interface SurfacePattern {
  /** RGBA, `size * size * 4`. */
  readonly albedo: Uint8Array;
  /** Height in 0..1, `size * size`. Becomes a normal map via `normalMap`. */
  readonly height: Float32Array;
}

/**
 * Integer hash. Deterministic, no state, no `Math.random()`.
 *
 * This is `src/render` so the sim's ban on randomness does not formally apply,
 * but the reasoning does: a texture that differs between two peers is a
 * texture that cannot be compared in a screenshot, and one that differs
 * between two runs is one that cannot be tested at all.
 */
function hash2(x: number, y: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Smooth noise on a lattice that repeats every `periodX` by `periodY` cells.
 *
 * The wrap is the whole reason this is not a one-liner over `hash2`: sampling
 * the lattice modulo its period is what makes the pattern tile.
 *
 * The two axes are separate because a pattern can legitimately be stretched —
 * a scuff on a tyre is long and thin — and a stretched pattern is sampled over
 * a different span on each axis. Passing one period for both is how the tyre
 * grain ended up not tiling horizontally at all: it wrapped at 32 cells while
 * the texture only covered 8 of them, so the right edge met the left edge
 * mid-pattern and drew a seam down every wheel.
 */
export function valueNoise(x: number, y: number, periodX: number, periodY = periodX): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  // Smoothstep, so the lattice does not show as a diamond grid.
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const wrap = (v: number, period: number): number => ((v % period) + period) % period;
  const ax = wrap(x0, periodX);
  const ay = wrap(y0, periodY);
  const bx = wrap(x0 + 1, periodX);
  const by = wrap(y0 + 1, periodY);
  const a = hash2(ax, ay);
  const b = hash2(bx, ay);
  const c = hash2(ax, by);
  const d = hash2(bx, by);
  return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}

/** Several octaves of `valueNoise`, each finer and quieter than the last. */
export function fbm(
  x: number,
  y: number,
  periodX: number,
  octaves: number,
  periodY = periodX,
): number {
  let sum = 0;
  let amplitude = 1;
  let total = 0;
  let frequency = 1;
  for (let i = 0; i < octaves; i++) {
    sum +=
      valueNoise(x * frequency, y * frequency, periodX * frequency, periodY * frequency) *
      amplitude;
    total += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return sum / total;
}

/**
 * Turns a height field into a tangent-space normal map.
 *
 * Central differences rather than a Sobel kernel: the patterns here are
 * already smooth, so the extra taps buy nothing, and the two-tap version is
 * obviously correct — the slope across a texel IS the difference between its
 * neighbours. Wraps at the edges, for the same reason the noise does.
 *
 * `strength` scales the horizontal components, which is how deep the surface
 * looks. It is not a physical quantity; it is the dial you turn until the
 * asphalt stops looking like sandpaper and starts looking like a road.
 */
export function normalMap(height: Float32Array, size: number, strength: number): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const at = (x: number, y: number): number =>
    height[(((y % size) + size) % size) * size + (((x % size) + size) % size)] ?? 0;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      // The surface normal of a height field: (-dh/dx, -dh/dy, 1), normalised.
      const length = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      out[i] = Math.round(((-dx / length) * 0.5 + 0.5) * 255);
      out[i + 1] = Math.round(((-dy / length) * 0.5 + 0.5) * 255);
      out[i + 2] = Math.round((1 / length) * 0.5 * 255 + 127.5);
      out[i + 3] = 255;
    }
  }
  return out;
}

/** Writes one texel, clamping so a pattern cannot produce garbage bytes. */
function put(albedo: Uint8Array, i: number, r: number, g: number, b: number): void {
  albedo[i] = Math.max(0, Math.min(255, Math.round(r * 255)));
  albedo[i + 1] = Math.max(0, Math.min(255, Math.round(g * 255)));
  albedo[i + 2] = Math.max(0, Math.min(255, Math.round(b * 255)));
  albedo[i + 3] = 255;
}

/**
 * Asphalt: a bed of stone chips in bitumen.
 *
 * The largest surface in the game by far, and the one the camera spends the
 * whole race pointed at. Two scales matter and both are here: the coarse
 * unevenness that catches the sun as the road rises and falls, and the chips
 * themselves, which is what a road looks like from a cockpit two feet off it.
 *
 * The chips are made by thresholding fine noise rather than by drawing
 * shapes — everything above the cut is a stone standing proud of the binder,
 * so their sizes and spacing come out irregular for free, and irregular is the
 * entire difference between aggregate and a pattern.
 */
export function asphalt(size: number): SurfacePattern {
  const albedo = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);
  // Lattice cells per tile. Sized so that one tile over a car's length puts
  // chips at roughly a hand's width, with enough texels each that a stone is a
  // stone rather than a sparkle.
  const chipPeriod = 56;
  const swellPeriod = 6;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * chipPeriod;
      const v = (y / size) * chipPeriod;
      const chip = fbm(u, v, chipPeriod, 2);
      const swell = valueNoise((x / size) * swellPeriod, (y / size) * swellPeriod, swellPeriod);

      // Above the cut is a stone; below is the bitumen between them.
      const stone = Math.max(0, chip - 0.52) / 0.48;
      // The HEIGHT field can be as dramatic as it likes — it only tilts
      // normals, and a road you can feel is the whole point of it.
      height[y * size + x] = swell * 0.25 + stone * 0.75;

      // The COLOUR cannot. This is where the first attempt went wrong: chips
      // painted as bright as they are proud turned the tarmac into scattered
      // gravel, and worse, a field of near-white specks a few texels across
      // sparkles under minification however good the mip chain is.
      //
      // Real asphalt is nearly uniform and very dark — most of what your eye
      // reads as "rough" is shading, not albedo. So the range here is narrow
      // and low, and the relief does the work.
      const shade = 0.1 + stone * 0.085 + swell * 0.03;
      // A few paler stones, and only a few. Enough that the surface is not
      // mathematically even; not enough to read as anything but tarmac.
      const pale = hash2(Math.floor(u), Math.floor(v)) > 0.9 ? 0.03 : 0;
      const value = shade + pale;
      put(albedo, (y * size + x) * 4, value, value * 0.99, value * 1.03);
    }
  }

  return { albedo, height };
}

/**
 * Carbon fibre, as a 2×2 twill — the weave everything on a racing car is made
 * of, and the one that reads as carbon at a glance because of its diagonal.
 *
 * A tow passes over two and under two, offset by one each row, which is what
 * puts the diagonal rib there. Where the warp is on top the visible surface is
 * a strand running one way; where the weft is, it runs the other. That
 * alternation is the entire pattern, and getting the modulo wrong turns it
 * into a chequerboard — a plain weave, which looks like canvas.
 */
export function carbonWeave(size: number): SurfacePattern {
  const albedo = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);
  /** Tows across one tile. */
  const tows = 16;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * tows;
      const v = (y / size) * tows;
      const cu = Math.floor(u);
      const cv = Math.floor(v);
      const fu = u - cu;
      const fv = v - cv;

      // The twill offset. `- cv` rather than `+ cv` is what makes the rib run
      // one way rather than the other; both look like carbon, only one looks
      // like the same carbon as the last time this ran.
      const warpOnTop = (((cu - cv) % 4) + 4) % 4 < 2;
      // A tow is a bundle of fibres, so its cross-section is a round-topped
      // ridge. The one on top is proud; the one beneath it is a dip.
      const ridge = warpOnTop ? Math.sin(Math.PI * fu) : Math.sin(Math.PI * fv);
      const base = warpOnTop ? 0.55 : 0.05;
      // Fibres along the strand. Very fine, very shallow — this is the sheen
      // that makes carbon glitter as it turns, not a texture you should be
      // able to see as lines.
      const along = warpOnTop ? fv : fu;
      const fibre = Math.sin(along * Math.PI * 2 * 6) * 0.02;
      const h = base + ridge * 0.4 + fibre;
      height[y * size + x] = h;

      // Nearly black, because carbon is: what you actually see on a real wing
      // is the lacquer over it. The weave shows through as a difference of a
      // few percent, and the rest is the environment reflection the material
      // does at render time.
      const value = 0.035 + h * 0.05;
      put(albedo, (y * size + x) * 4, value, value, value * 1.12);
    }
  }

  return { albedo, height };
}

/**
 * Tyre rubber: grained, circumferentially scuffed, dead matte.
 *
 * A modern racing slick has no tread pattern at all, so there is nothing to
 * carve — but a tyre that is genuinely smooth renders as a black cylinder, and
 * a black cylinder is what the old car had four of. What a slick does have is
 * grain: fine scoring around the circumference from being dragged across
 * tarmac, which is what catches a highlight and tells the eye the wheel is
 * round.
 *
 * The lines run along U, which on a Babylon cylinder is the way round the
 * barrel — so they wrap the way scuffing does, rather than running across the
 * tread like a road tyre.
 */
export function tyreRubber(size: number): SurfacePattern {
  const albedo = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);
  // Stretched hard: a scuff is long and thin, so the pattern is sampled over
  // few cells around the barrel and many across it. Both spans are handed to
  // the noise as its periods, which is what makes each axis wrap at the edge
  // of the texture rather than somewhere in the middle of it.
  const aroundCells = 8;
  const acrossCells = 128;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const grain = fbm(
        (x / size) * aroundCells,
        (y / size) * acrossCells,
        aroundCells,
        2,
        acrossCells,
      );
      const h = grain;
      height[y * size + x] = h;

      const value = 0.045 + h * 0.05;
      put(albedo, (y * size + x) * 4, value, value, value * 1.05);
    }
  }

  return { albedo, height };
}

/**
 * Grass, as clumps rather than a colour.
 *
 * The thing that gives away a flat green plane is not the green — it is the
 * evenness. Real turf is a patchwork at two scales: broad lighter and darker
 * areas where it grows thicker or thinner, and the tufts themselves. Both are
 * here, and the tufts go into the height field so the low sun rakes across
 * them instead of lighting a sheet.
 *
 * It is the second largest surface in the game and it borders the first, so
 * the contrast between this and the tarmac is what tells a driver at a glance
 * where the road is — which is a gameplay question, not only a pretty one.
 */
export function grass(size: number): SurfacePattern {
  const albedo = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);
  const tuftPeriod = 96;
  const patchPeriod = 5;
  /** Mowing bands per tile, running diagonally so the joins never line up. */
  const stripes = 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tuft = fbm((x / size) * tuftPeriod, (y / size) * tuftPeriod, tuftPeriod, 2);
      const patch = fbm((x / size) * patchPeriod, (y / size) * patchPeriod, patchPeriod, 2);
      height[y * size + x] = tuft;

      // Mowing stripes: the alternating light/dark bands a cut lawn has,
      // because the blades lie away from you in one pass and toward you in
      // the next. Nothing says "maintained circuit" — as opposed to "green
      // felt" — more cheaply. Diagonal, so the bands tile with the texture,
      // and softened by smoothstep so the boundary is a blend, not a rule.
      const band = (((x + y) / size) * stripes) % 1;
      const wave = 0.5 + 0.5 * Math.sin(band * Math.PI * 2);
      const stripe = 0.88 + wave * 0.24;

      // Dried patches: real turf is never one green. Where the coarse noise
      // runs high the grass yellows and thins, which breaks the carpet up at
      // exactly the scale a camera at altitude sees.
      const dry = Math.max(0, patch - 0.62) * 2.2;

      const lit = (0.56 + tuft * 0.5 + patch * 0.25) * stripe;
      // Olive, not billiard-table. Saturated pure green under a bright sun is
      // the toy-town signal; the red channel comes UP toward the green as the
      // patch dries. Bright enough overall that the tarmac stays the darker
      // surface — the test on that contrast is a gameplay guarantee.
      const r = (0.14 + dry * 0.06) * lit;
      const g = (0.26 - dry * 0.03) * lit;
      const b = (0.088 - dry * 0.016) * lit;
      put(albedo, (y * size + x) * 4, r, g, b);
    }
  }

  return { albedo, height };
}

/**
 * Corrugated barrier steel: the horizontal wave profile of a guardrail.
 *
 * Entirely a height field — the albedo is flat, because what makes corrugation
 * read is the lighting rolling across the waves, and that is the normal map's
 * job. The wave runs down V (a rail's ridges are horizontal, along its
 * length), with a whisper of noise so the pressing is not mathematically
 * perfect.
 */
export function corrugation(size: number): SurfacePattern {
  const albedo = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);
  const waves = 3;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const wave = 0.5 + 0.5 * Math.sin((y / size) * Math.PI * 2 * waves);
      // Coarse and quiet: at the tiling a barrier uses, a fine dent pattern
      // strobes into vertical streaks.
      const dent = valueNoise((x / size) * 5, (y / size) * 3, 5) * 0.05;
      height[y * size + x] = wave * 0.94 + dent;

      const value = 0.42 + wave * 0.05;
      put(albedo, (y * size + x) * 4, value, value * 1.01, value * 1.05);
    }
  }

  return { albedo, height };
}

/**
 * Kerb ribs: the sawtooth a car feels, as a height field for the normal map.
 *
 * The painted stripes stay in the canvas texture that already draws them;
 * this adds only the RELIEF — ridges across the kerb's width, so the sun
 * catches each rib's leading face. A kerb with stripes but no ribs is paint
 * on flat tarmac, and reads exactly that flat.
 */
export function kerbRibs(size: number): SurfacePattern {
  const albedo = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);
  const ribs = 4;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // A triangle wave along U — the axis that runs down the road — with a
      // flattened crest, which is the profile of a real rumble strip.
      const phase = ((x / size) * ribs) % 1;
      const tri = 1 - Math.abs(phase * 2 - 1);
      height[y * size + x] = Math.min(1, tri * 1.4);

      const value = 0.5;
      put(albedo, (y * size + x) * 4, value, value, value);
    }
  }

  return { albedo, height };
}

/** A pattern uploaded to the GPU, as the two textures a PBR material wants. */
export interface Surface {
  readonly albedo: RawTexture;
  /** Null when the quality tier cannot afford the extra fragment work. */
  readonly normal: RawTexture | null;
  dispose(): void;
}

/**
 * Uploads a pattern.
 *
 * `scale` tiles it: a road wants its texture repeated hundreds of times along
 * its length, a wing wants it a handful. `strength` is the normal map's depth.
 * Pass `withNormal: false` on a tier that cannot pay for the second lookup —
 * the albedo alone still carries the pattern, just flatly lit.
 */
export function createSurface(
  scene: Scene,
  name: string,
  pattern: SurfacePattern,
  options: {
    size: number;
    uScale?: number;
    vScale?: number;
    strength?: number;
    withNormal?: boolean;
  },
): Surface {
  const { size } = options;
  const uScale = options.uScale ?? 1;
  const vScale = options.vScale ?? uScale;

  const albedo = new RawTexture(
    pattern.albedo,
    size,
    size,
    Constants.TEXTUREFORMAT_RGBA,
    scene,
    true,
    false,
    Texture.TRILINEAR_SAMPLINGMODE,
  );
  albedo.name = `${name}:albedo`;
  albedo.wrapU = Texture.WRAP_ADDRESSMODE;
  albedo.wrapV = Texture.WRAP_ADDRESSMODE;
  albedo.uScale = uScale;
  albedo.vScale = vScale;

  let normal: RawTexture | null = null;
  if (options.withNormal !== false) {
    normal = new RawTexture(
      normalMap(pattern.height, size, options.strength ?? 8),
      size,
      size,
      Constants.TEXTUREFORMAT_RGBA,
      scene,
      true,
      false,
      Texture.TRILINEAR_SAMPLINGMODE,
    );
    normal.name = `${name}:normal`;
    // A normal map is a vector, not a colour. Left in gamma space it would be
    // de-gammad on read and every normal would tilt the same wrong way — which
    // looks like lighting that is subtly, inexplicably off rather than like a
    // broken texture, so it is worth one line to be sure of.
    normal.gammaSpace = false;
    normal.wrapU = Texture.WRAP_ADDRESSMODE;
    normal.wrapV = Texture.WRAP_ADDRESSMODE;
    normal.uScale = uScale;
    normal.vScale = vScale;
  }

  return {
    albedo,
    normal,
    dispose(): void {
      albedo.dispose();
      normal?.dispose();
    },
  };
}
