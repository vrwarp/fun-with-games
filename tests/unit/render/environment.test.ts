import { describe, expect, it } from 'vitest';
import {
  DAYLIGHT,
  SUN_TRAVEL,
  cloudAt,
  directionAt,
  skyColourAt,
  skyRadianceAt,
} from '@/render/environment.js';

/**
 * The generated sky, as a gradient.
 *
 * Physically-based materials need something to be based on: metal is not a
 * colour, it is a mirror with a tint, and a mirror with nothing to reflect
 * renders as a flat black shape. This kit forbids shipping a captured HDR
 * panorama, so the environment is drawn in code — and being code, the shape of
 * it can be checked here rather than squinted at in a screenshot.
 */
const luminance = (y: number): number => {
  const c = skyColourAt(y);
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
};

describe('the sky gradient', () => {
  it('is brightest at the horizon, not overhead', () => {
    // The thing that makes a reflection look like it has a horizon in it. A
    // sky that simply got brighter upward would slide a bright band off the
    // top of every panel instead of wrapping round it as the car turns.
    expect(luminance(0)).toBeGreaterThan(luminance(1));
    expect(luminance(0)).toBeGreaterThan(luminance(-1));
  });

  it('darkens toward the ground faster than toward the zenith', () => {
    // The ground is close and the sky is not, so the falloff is asymmetric —
    // which is what stops a car's underside reflecting daylight.
    const down = luminance(0) - luminance(-0.3);
    const up = luminance(0) - luminance(0.3);
    expect(down).toBeGreaterThan(up);
  });

  it('is monotonic on each side of the horizon', () => {
    // A gradient with a kink in it shows up as a band sliding across
    // bodywork, which reads as a rendering artefact rather than a reflection.
    for (let y = 0.05; y <= 1; y += 0.05) {
      expect(luminance(y)).toBeLessThanOrEqual(luminance(y - 0.05) + 1e-9);
    }
    for (let y = -0.05; y >= -1; y -= 0.05) {
      expect(luminance(y)).toBeLessThanOrEqual(luminance(y + 0.05) + 1e-9);
    }
  });

  it('meets the named colours at the three anchors', () => {
    expect(skyColourAt(0).r).toBeCloseTo(DAYLIGHT.horizon.r, 5);
    expect(skyColourAt(1).b).toBeCloseTo(DAYLIGHT.zenith.b, 5);
    expect(skyColourAt(-1).g).toBeCloseTo(DAYLIGHT.ground.g, 5);
  });

  it('stays in range for anything a unit vector can hand it', () => {
    for (let y = -1; y <= 1; y += 0.02) {
      const colour = skyColourAt(y);
      for (const channel of [colour.r, colour.g, colour.b]) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    }
  });
});

/** Unit direction from a yaw and a pitch, for aiming at bits of sky. */
function look(yaw: number, pitch: number): [number, number, number] {
  const c = Math.cos(pitch);
  return [Math.sin(yaw) * c, Math.sin(pitch), Math.cos(yaw) * c];
}

const bright = (r: readonly [number, number, number]): number => {
  const c = skyRadianceAt(r[0], r[1], r[2]);
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
};

describe('cube face directions', () => {
  it('sends each face along its own axis', () => {
    // The six-face layout is load-bearing and completely invisible: get one
    // face flipped and the sky simply has a seam somewhere behind the player.
    // Face centres are the cheapest possible pin on it.
    const axes: Array<[number, number, number]> = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    axes.forEach((axis, face) => {
      const [x, y, z] = directionAt(face, 0, 0);
      expect(x).toBeCloseTo(axis[0], 6);
      expect(y).toBeCloseTo(axis[1], 6);
      expect(z).toBeCloseTo(axis[2], 6);
    });
  });

  it('always returns a unit vector', () => {
    for (let face = 0; face < 6; face++) {
      for (const u of [-1, -0.4, 0, 0.7, 1]) {
        for (const v of [-1, 0.2, 1]) {
          const [x, y, z] = directionAt(face, u, v);
          expect(Math.hypot(x, y, z)).toBeCloseTo(1, 6);
        }
      }
    }
  });

  it('agrees with the side faces about which way is up', () => {
    // Every side face has world -Y along its vertical texel axis. If one of
    // them disagrees, that face alone shows ground colours in the sky.
    for (const face of [0, 1, 4, 5]) {
      expect(directionAt(face, 0, -1)[1]).toBeGreaterThan(0);
      expect(directionAt(face, 0, 1)[1]).toBeLessThan(0);
    }
  });
});

describe('the sun', () => {
  it('is the same fact as the light that casts the shadows', () => {
    // Two constants would drift, and a sky whose sun sits somewhere other than
    // the key light is wrongness everyone feels and nobody can name.
    expect(SUN_TRAVEL.x).toBeCloseTo(-DAYLIGHT.sunX, 6);
    expect(SUN_TRAVEL.y).toBeCloseTo(-DAYLIGHT.sunY, 6);
    expect(SUN_TRAVEL.z).toBeCloseTo(-DAYLIGHT.sunZ, 6);
  });

  it('is far brighter looking at it than a few degrees off it', () => {
    const at = bright([DAYLIGHT.sunX, DAYLIGHT.sunY, DAYLIGHT.sunZ]);
    const off = bright(look(Math.PI / 2, 0.4));
    expect(at).toBeGreaterThan(off * 1.6);
  });

  it('has a disc inside a much wider glare', () => {
    // Two lobes rather than one, because a single falloff cannot be both a
    // disc and the haze around it. The near field must fall off fast and the
    // far field slowly.
    const sun: [number, number, number] = [DAYLIGHT.sunX, DAYLIGHT.sunY, DAYLIGHT.sunZ];
    const tilt = (radians: number): [number, number, number] => {
      // Rotate the sun direction about Y by a small angle: close enough to an
      // angular offset for this, and it keeps the vector on the unit sphere.
      const c = Math.cos(radians);
      const s = Math.sin(radians);
      return [sun[0] * c + sun[2] * s, sun[1], -sun[0] * s + sun[2] * c];
    };
    const core = bright(sun);
    const near = bright(tilt(0.08));
    const far = bright(tilt(0.6));
    expect(core).toBeGreaterThan(near * 1.3);
    expect(near).toBeGreaterThan(far);
  });
});

describe('the cloud deck', () => {
  it('is only above the horizon', () => {
    for (let y = -1; y < 0; y += 0.05) {
      expect(cloudAt(0.3, y, 0.4)).toBe(0);
    }
  });

  it('clears completely when the cover is zero', () => {
    const clear = { ...DAYLIGHT, cloudCover: 0 };
    for (let i = 0; i < 50; i++) {
      const [x, y, z] = look(i * 0.7, 0.2 + (i % 7) * 0.1);
      expect(cloudAt(x, y, z, clear)).toBe(0);
    }
  });

  it('is bimodal — separate clouds in clear sky, not a grey veil', () => {
    // The sharpest statement of what "scattered" has to mean. Moving a
    // THRESHOLD through a noise field gives most of the sky either open or
    // solidly covered, with only the cloud edges in between. Scaling a density
    // instead would pile everything into the middle: a uniform wash that reads
    // as fog rather than as weather, and the two are easy to confuse in code
    // and impossible to confuse on screen.
    let clear = 0;
    let solid = 0;
    let edge = 0;
    let total = 0;
    // A grid over the upper hemisphere rather than a walk across it: a walk
    // samples whatever it happens to sweep past, which makes the counts an
    // accident of the step size rather than a fact about the sky.
    for (let yaw = 0; yaw < Math.PI * 2; yaw += 0.12) {
      for (let pitch = 0.25; pitch < 1.4; pitch += 0.08) {
        const [x, y, z] = look(yaw, pitch);
        const cloud = cloudAt(x, y, z);
        total++;
        if (cloud < 0.1) clear++;
        else if (cloud > 0.9) solid++;
        else edge++;
      }
    }
    expect(clear / total).toBeGreaterThan(0.5);
    expect(solid / total).toBeGreaterThan(0.02);
    expect(edge / total).toBeLessThan(0.25);
  });

  it('stays in 0..1', () => {
    for (let i = 0; i < 300; i++) {
      const [x, y, z] = look(i * 0.13, (i % 20) * 0.05);
      const cloud = cloudAt(x, y, z);
      expect(cloud).toBeGreaterThanOrEqual(0);
      expect(cloud).toBeLessThanOrEqual(1);
    }
  });

  it('sits in FRONT of the sun', () => {
    // The compositing order. A disc added after the cloud would shine straight
    // through an overcast, which is the most obvious way to get this wrong.
    const overcast = { ...DAYLIGHT, cloudCover: 1 };
    const sun: [number, number, number] = [DAYLIGHT.sunX, DAYLIGHT.sunY, DAYLIGHT.sunZ];
    const open = skyRadianceAt(sun[0], sun[1], sun[2]);
    const hidden = skyRadianceAt(sun[0], sun[1], sun[2], overcast);
    expect(hidden.r).toBeLessThan(open.r);
  });
});
