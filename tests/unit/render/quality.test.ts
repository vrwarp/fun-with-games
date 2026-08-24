import { describe, expect, it } from 'vitest';
import {
  PATIENCE_SECONDS,
  QUALITY_TIERS,
  QualityGovernor,
  TARGET_FPS,
  isQualityTier,
  lowerTier,
  qualitySettings,
  startingTier,
  type DeviceHints,
} from '@/render/quality.js';

/**
 * Which look a device gets, and when it gives one up.
 *
 * The decisions here are both the most consequential in the renderer and the
 * ones least checkable where they matter: CI renders in software at single
 * digit frame rates whatever the tier, so a browser test cannot tell an
 * expensive look from a cheap one. Keeping the POLICY pure is what makes it
 * testable at all, and this file is the reason it was written that way.
 */
function hints(overrides: Partial<DeviceHints> = {}): DeviceHints {
  return { coarsePointer: false, cores: 8, pixelRatio: 1, reducedMotion: false, ...overrides };
}

describe('picking a starting tier', () => {
  it('gives a desktop everything', () => {
    expect(startingTier(hints())).toBe('high');
  });

  it('never opens a phone on the most expensive tier', () => {
    // Pessimism is the policy. A player who starts too low has a game that
    // runs beautifully and switches they can turn up; a player who starts too
    // high has a stuttering mess and concludes the game is broken.
    for (const cores of [2, 4, 6, 8, 12]) {
      for (const pixelRatio of [1, 2, 3, 4]) {
        const tier = startingTier(hints({ coarsePointer: true, cores, pixelRatio }));
        expect(tier).not.toBe('high');
      }
    }
  });

  it('drops a cheap phone to the cheapest tier', () => {
    expect(startingTier(hints({ coarsePointer: true, cores: 4 }))).toBe('low');
    // A high pixel ratio is the same problem by another route: three times the
    // ratio is nine times the fragments for the same physical screen.
    expect(startingTier(hints({ coarsePointer: true, cores: 8, pixelRatio: 3 }))).toBe('low');
  });

  it('lets a good phone have the middle tier', () => {
    expect(startingTier(hints({ coarsePointer: true, cores: 8, pixelRatio: 2 }))).toBe('medium');
  });

  it('copes with a browser that will not say how many cores it has', () => {
    // `hardwareConcurrency` is absent or zeroed by privacy settings, and a
    // zero must not read as "a very cheap device" through a `<= 4` test.
    expect(startingTier(hints({ coarsePointer: true, cores: 0, pixelRatio: 2 }))).toBe('medium');
  });
});

describe('what a tier switches on', () => {
  it('gets more expensive in one direction only', () => {
    // The tiers have to be ORDERED, or stepping down is not a step down.
    const settings = QUALITY_TIERS.map(qualitySettings);
    for (let i = 1; i < settings.length; i++) {
      const lower = settings[i - 1]!;
      const higher = settings[i]!;
      expect(higher.shadowMapSize).toBeGreaterThanOrEqual(lower.shadowMapSize);
      expect(higher.maxPixelRatio).toBeGreaterThanOrEqual(lower.maxPixelRatio);
      expect(Number(higher.antialias)).toBeGreaterThanOrEqual(Number(lower.antialias));
      expect(Number(higher.bloom)).toBeGreaterThanOrEqual(Number(lower.bloom));
    }
  });

  it('keeps the cheapest tier free of screen passes', () => {
    // The whole point of `low`. A post-processing chain at a phone's pixel
    // ratio is where the frame budget dies, and an "empty" pipeline still
    // costs a full-screen copy.
    const low = qualitySettings('low');
    expect(low.antialias).toBe(false);
    expect(low.bloom).toBe(false);
    expect(low.ambientOcclusion).toBe(false);
  });

  it('gives up per-fragment detail before it gives up resolution', () => {
    // Normal maps and clear coat are per-fragment work, so they are what a
    // cheap phone can least afford; the pixel ratio cap is already as low as
    // it goes without the whole image going soft.
    const low = qualitySettings('low');
    expect(low.normalMaps).toBe(false);
    expect(low.clearCoat).toBe(false);
    for (const tier of ['medium', 'high'] as const) {
      expect(qualitySettings(tier).normalMaps).toBe(true);
      expect(qualitySettings(tier).clearCoat).toBe(true);
    }
  });

  it('renders a phone below its full pixel ratio even at the top', () => {
    for (const tier of QUALITY_TIERS) expect(qualitySettings(tier).maxPixelRatio).toBeLessThan(3);
  });
});

describe('lowerTier', () => {
  it('walks down and stops at the bottom', () => {
    expect(lowerTier('high')).toBe('medium');
    expect(lowerTier('medium')).toBe('low');
    expect(lowerTier('low')).toBeNull();
  });
});

describe('isQualityTier', () => {
  it('accepts the tiers and nothing else', () => {
    for (const tier of QUALITY_TIERS) expect(isQualityTier(tier)).toBe(true);
    for (const junk of ['ultra', '', 'HIGH', 0, null, undefined, {}]) {
      expect(isQualityTier(junk)).toBe(false);
    }
  });
});

describe('giving up a tier', () => {
  /** Feeds `fps` for `seconds`, and reports every drop it asked for. */
  function run(governor: QualityGovernor, fps: number, seconds: number): (string | null)[] {
    const drops: (string | null)[] = [];
    for (let t = 0; t < seconds; t += 0.5) {
      const next = governor.update(fps, 0.5);
      if (next) drops.push(next);
    }
    return drops;
  }

  it('leaves a device that is keeping up alone', () => {
    const governor = new QualityGovernor('high');
    expect(run(governor, 60, 30)).toEqual([]);
    expect(governor.tier).toBe('high');
  });

  it('ignores a dip that does not last', () => {
    // Frame rate on a browser dips for reasons that have nothing to do with
    // the scene: a texture upload, a collection, another tab waking, the very
    // first frames while shaders compile. Dropping the quality of a game that
    // was running perfectly — while the player watches — is worse than the dip.
    const governor = new QualityGovernor('high');
    run(governor, 20, PATIENCE_SECONDS - 1);
    run(governor, 60, 2);
    expect(governor.tier).toBe('high');
  });

  it('gives up a tier once the shortfall is sustained', () => {
    const governor = new QualityGovernor('high');
    expect(run(governor, 20, PATIENCE_SECONDS + 1)).toEqual(['medium']);
    expect(governor.tier).toBe('medium');
  });

  it('keeps stepping down while it still cannot cope, then stops', () => {
    const governor = new QualityGovernor('high');
    const drops = run(governor, 12, PATIENCE_SECONDS * 4);
    expect(drops).toEqual(['medium', 'low']);
    expect(governor.tier).toBe('low');
  });

  it('never climbs back up on its own', () => {
    // A quality increase mid-race is a stutter arriving from nowhere, and the
    // player did not ask for it. Going up is a decision, not a measurement.
    const governor = new QualityGovernor('high');
    run(governor, 10, PATIENCE_SECONDS * 4);
    expect(run(governor, 144, 60)).toEqual([]);
    expect(governor.tier).toBe('low');
  });

  it('treats a zero reading as no reading at all', () => {
    // The engine reports 0 before it has measured anything. Read as a frame
    // rate that would be a drop on the very first frame, every time.
    const governor = new QualityGovernor('high');
    expect(run(governor, 0, PATIENCE_SECONDS * 3)).toEqual([]);
  });

  it('forgives the shortfall when a tier is set from outside', () => {
    const governor = new QualityGovernor('high');
    run(governor, 20, PATIENCE_SECONDS - 1);
    governor.setTier('high');
    run(governor, 60, 1);
    expect(governor.tier).toBe('high');
  });

  it('acts just under the target and not just over it', () => {
    const under = new QualityGovernor('high');
    run(under, TARGET_FPS - 1, PATIENCE_SECONDS + 1);
    expect(under.tier).toBe('medium');

    const over = new QualityGovernor('high');
    run(over, TARGET_FPS, PATIENCE_SECONDS + 1);
    expect(over.tier).toBe('high');
  });
});
