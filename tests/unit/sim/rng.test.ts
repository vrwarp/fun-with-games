import { describe, expect, it } from 'vitest';
import { Rng, hashStringToSeed } from '@/sim/rng.js';

describe('Rng', () => {
  it('produces the same stream for the same seed', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    const drawsA = Array.from({ length: 20 }, () => a.next());
    const drawsB = Array.from({ length: 20 }, () => b.next());
    expect(drawsA).toEqual(drawsB);
  });

  it('produces different streams for different seeds', () => {
    const a = new Rng(1);
    const b = new Rng(2);
    expect(a.next()).not.toBe(b.next());
  });

  it('stays within [0, 1)', () => {
    const rng = new Rng(7);
    for (let i = 0; i < 1000; i++) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('restores an exact stream position from saved state', () => {
    // This is the property that makes a snapshot able to carry RNG state, and
    // therefore makes a desync reproducible from a recording.
    const rng = new Rng(99);
    rng.next();
    rng.next();

    const saved = rng.state;
    const expected = [rng.next(), rng.next(), rng.next()];

    const restored = new Rng(0);
    restored.state = saved;
    expect([restored.next(), restored.next(), restored.next()]).toEqual(expected);
  });

  it('clones without coupling the streams', () => {
    const original = new Rng(5);
    const clone = original.clone();

    const first = original.next();
    expect(clone.next()).toBe(first);
    original.next();
    // The clone is unaffected by the original's extra draw.
    expect(clone.state).not.toBe(original.state);
  });

  it('range() stays inside its bounds', () => {
    const rng = new Rng(3);
    for (let i = 0; i < 200; i++) {
      const value = rng.range(-5, 5);
      expect(value).toBeGreaterThanOrEqual(-5);
      expect(value).toBeLessThan(5);
    }
  });

  it('int() covers the half-open range', () => {
    const rng = new Rng(11);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) seen.add(rng.int(0, 4));
    expect([...seen].sort()).toEqual([0, 1, 2, 3]);
  });

  it('pick() selects from the array', () => {
    const rng = new Rng(13);
    const items = ['a', 'b', 'c'] as const;
    for (let i = 0; i < 50; i++) {
      expect(items).toContain(rng.pick(items));
    }
  });

  it('pick() rejects an empty array instead of returning undefined', () => {
    expect(() => new Rng(1).pick([])).toThrow(/empty/i);
  });

  it('normalizes seeds to uint32', () => {
    expect(new Rng(-1).state).toBe(0xffffffff);
  });
});

describe('hashStringToSeed', () => {
  it('is stable for the same string', () => {
    expect(hashStringToSeed('amber-1234')).toBe(hashStringToSeed('amber-1234'));
  });

  it('separates similar strings', () => {
    expect(hashStringToSeed('room-a')).not.toBe(hashStringToSeed('room-b'));
  });

  it('always returns a uint32', () => {
    for (const input of ['', 'a', 'a much longer room identifier', '~!@#$%^&*()']) {
      const seed = hashStringToSeed(input);
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThanOrEqual(0xffffffff);
    }
  });
});
