import { describe, expect, it } from 'vitest';
import { applyDamage, updateCombat } from '@/sim/systems/combat.js';
import { hasEffect } from '@/sim/systems/effects.js';
import { NEVER_TICK } from '@/sim/types.js';
import { eventsOfType, makePlayer, makeStepContext } from '../../helpers/factories.js';

const combatOn = { combat: { enabled: true, maxHp: 3, respawnTicks: 30, lives: 0 } };

describe('applyDamage', () => {
  it('reduces hp and reports a landed hit', () => {
    const target = makePlayer({ id: 'victim', hp: 3 });
    const ctx = makeStepContext({ config: combatOn, players: [target] });

    expect(applyDamage(ctx, target, 1, 'attacker')).toBe(true);
    expect(target.hp).toBe(2);
  });

  it('does nothing when combat is disabled', () => {
    const target = makePlayer({ hp: 3 });
    const ctx = makeStepContext({ players: [target] });

    expect(applyDamage(ctx, target, 1, 'x')).toBe(false);
    expect(target.hp).toBe(3);
  });

  it('is blocked by shield, spawn protection and existing KO', () => {
    for (const effects of [{ shield: 100 }, { safe: 100 }, { ko: 100 }]) {
      const target = makePlayer({ hp: 3, effects: { ...effects } });
      const ctx = makeStepContext({ config: combatOn, players: [target], tick: 5 });
      expect(applyDamage(ctx, target, 1, 'x')).toBe(false);
      expect(target.hp).toBe(3);
    }
  });

  it('knocks out at zero hp, credits the attacker, emits the event', () => {
    const attacker = makePlayer({ id: 'attacker' });
    const target = makePlayer({ id: 'victim', hp: 1 });
    const ctx = makeStepContext({
      config: { combat: { ...combatOn.combat, koScore: 2 } },
      players: [attacker, target],
      tick: 10,
    });

    applyDamage(ctx, target, 1, 'attacker');

    expect(target.hp).toBe(0);
    expect(target.effects['ko']).toBe(10 + 30);
    expect(attacker.score).toBe(2);
    expect(eventsOfType(ctx.out, 'playerKnockedOut')).toEqual([
      { type: 'playerKnockedOut', playerId: 'victim', byId: 'attacker' },
    ]);
  });

  it('counts KOs for the attacker team', () => {
    const attacker = makePlayer({ id: 'attacker', team: 1 });
    const target = makePlayer({ id: 'victim', hp: 1, team: 0 });
    const ctx = makeStepContext({
      config: { ...combatOn, teams: { count: 2 } },
      players: [attacker, target],
    });

    applyDamage(ctx, target, 1, 'attacker');
    expect(ctx.teamScores).toEqual([0, 1]);
  });

  it('spends a life per KO and keeps the last KO forever', () => {
    const target = makePlayer({ id: 'victim', hp: 1, lives: 2 });
    const ctx = makeStepContext({
      config: { combat: { ...combatOn.combat, lives: 2 } },
      players: [target],
      tick: 0,
    });

    applyDamage(ctx, target, 1, 'x');
    expect(target.lives).toBe(1);
    expect(target.effects['ko']).toBe(30);

    // Second KO after a respawn: last life gone, never respawns.
    target.hp = 1;
    delete target.effects['ko'];
    delete target.effects['safe'];
    applyDamage(ctx, target, 1, 'x');
    expect(target.lives).toBe(0);
    expect(target.effects['ko']).toBe(NEVER_TICK);
  });
});

describe('updateCombat: respawn', () => {
  it('respawns a player when the KO expires, with protection', () => {
    const player = makePlayer({ id: 'p', hp: 0, x: 9, z: 9, effects: { ko: 10 } });
    const ctx = makeStepContext({ config: combatOn, players: [player], tick: 10 });

    updateCombat(ctx);

    expect(hasEffect(player, 'ko', 10)).toBe(false);
    expect(player.hp).toBe(3);
    expect(player.x).not.toBe(9);
    expect(hasEffect(player, 'safe', 10)).toBe(true);
    expect(eventsOfType(ctx.out, 'playerRespawned')).toHaveLength(1);
  });

  it('leaves a still-down player alone', () => {
    const player = makePlayer({ id: 'p', hp: 0, effects: { ko: 50 } });
    const ctx = makeStepContext({ config: combatOn, players: [player], tick: 10 });

    updateCombat(ctx);

    expect(player.effects['ko']).toBe(50);
    expect(player.hp).toBe(0);
  });
});
