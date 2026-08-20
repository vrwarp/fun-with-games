import { describe, expect, it } from 'vitest';
import { makeSimConfig } from '@/sim/config.js';
import {
  activeEffects,
  addEffect,
  clearEffect,
  effectRemaining,
  hasEffect,
  isImmobilized,
  isKnockedOut,
  isProtected,
  movementScale,
  pruneEffects,
} from '@/sim/systems/effects.js';
import { makePlayer } from '../../helpers/factories.js';

describe('effects: add / query / clear', () => {
  it('grants an effect until the given tick, exclusive', () => {
    const player = makePlayer();
    addEffect(player, 'speed', 100);

    expect(hasEffect(player, 'speed', 99)).toBe(true);
    expect(hasEffect(player, 'speed', 100)).toBe(false);
    expect(effectRemaining(player, 'speed', 40)).toBe(60);
  });

  it('extends but never shortens an existing effect', () => {
    const player = makePlayer();
    addEffect(player, 'shield', 100);
    addEffect(player, 'shield', 50);
    expect(player.effects['shield']).toBe(100);

    addEffect(player, 'shield', 200);
    expect(player.effects['shield']).toBe(200);
  });

  it('clears an effect', () => {
    const player = makePlayer({ effects: { stun: 50 } });
    clearEffect(player, 'stun');
    expect(hasEffect(player, 'stun', 0)).toBe(false);
  });

  it('lists active effects sorted, skipping expired ones', () => {
    const player = makePlayer({ effects: { speed: 100, shield: 10, frozen: 100 } });
    expect(activeEffects(player, 50)).toEqual(['frozen', 'speed']);
  });
});

describe('effects: prune', () => {
  it('drops expired effects but keeps ko for the combat system', () => {
    const player = makePlayer({ effects: { speed: 10, ko: 10, shield: 100 } });
    pruneEffects([player], 20);

    expect(player.effects).toEqual({ ko: 10, shield: 100 });
  });
});

describe('effects: movement queries', () => {
  const config = makeSimConfig();

  it('immobilizes frozen, stunned and knocked-out players', () => {
    expect(isImmobilized(makePlayer({ effects: { frozen: 10 } }), 5)).toBe(true);
    expect(isImmobilized(makePlayer({ effects: { stun: 10 } }), 5)).toBe(true);
    expect(isImmobilized(makePlayer({ effects: { ko: 10 } }), 5)).toBe(true);
    expect(isImmobilized(makePlayer(), 5)).toBe(false);
  });

  it('protects shielded, safe and knocked-out players', () => {
    expect(isProtected(makePlayer({ effects: { shield: 10 } }), 5)).toBe(true);
    expect(isProtected(makePlayer({ effects: { safe: 10 } }), 5)).toBe(true);
    expect(isProtected(makePlayer({ effects: { ko: 10 } }), 5)).toBe(true);
    expect(isProtected(makePlayer(), 5)).toBe(false);
  });

  it('reports knock-out state', () => {
    expect(isKnockedOut(makePlayer({ effects: { ko: 10 } }), 5)).toBe(true);
    expect(isKnockedOut(makePlayer({ effects: { ko: 10 } }), 10)).toBe(false);
  });

  it('scales movement for speed boosts, carrying and bots', () => {
    expect(movementScale(makePlayer(), 0, config)).toBe(1);
    expect(movementScale(makePlayer({ effects: { speed: 10 } }), 5, config)).toBeCloseTo(
      config.powerups.speedMultiplier,
    );
    expect(movementScale(makePlayer({ effects: { carry: 10 } }), 5, config)).toBeCloseTo(
      config.itemRules.carrySpeedMultiplier,
    );
    expect(movementScale(makePlayer({ isBot: true }), 0, config)).toBeCloseTo(
      config.bots.speedMultiplier,
    );
  });
});
