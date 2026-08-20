import { describe, expect, it } from 'vitest';
import { DEFAULT_MODE_ID, GAME_MODES, isGameModeId } from '@/shared/modes.js';
import { GAME_MODE_IDS, modeConfig } from '@/sim/presets.js';
import { World } from '@/sim/world.js';

const profile = { name: 'p', color: '#4cc9f0' };

describe('game mode registry', () => {
  it('metadata and presets list exactly the same modes', () => {
    const metadataIds = GAME_MODES.map((mode) => mode.id).sort();
    expect([...GAME_MODE_IDS].sort()).toEqual(metadataIds);
  });

  it('recognises ids and rejects junk', () => {
    expect(isGameModeId(DEFAULT_MODE_ID)).toBe(true);
    expect(isGameModeId('tag')).toBe(true);
    expect(isGameModeId('warcrimes')).toBe(false);
    expect(isGameModeId(null)).toBe(false);
  });

  it('gather is the untouched sandbox: no phases, no kit systems', () => {
    const config = modeConfig('gather');
    expect(config.phases.enabled).toBe(false);
    expect(config.combat.enabled).toBe(false);
    expect(config.tag.enabled).toBe(false);
    expect(config.ball.enabled).toBe(false);
    expect(config.zones).toHaveLength(0);
    expect(config.items).toHaveLength(0);
  });
});

describe('every preset', () => {
  // One sweep per mode: build a session-sized world, run it, snapshot it,
  // restore it, and prove the restored copy stays bit-identical. This is the
  // broad safety net for the demo: whatever mode gets picked, the full
  // simulate/snapshot/restore path has been exercised in CI.
  for (const id of GAME_MODE_IDS) {
    it(`${id}: runs deterministically and snapshots faithfully`, () => {
      const build = (): World => {
        const world = new World({ seed: 1234, config: modeConfig(id) });
        world.addPlayer('aa-alice', profile);
        world.addPlayer('ab-bob', { name: 'bob', color: '#f72585' });
        world.addBot();
        world.setInput('aa-alice', { seq: 1, moveX: 1, moveZ: 0.3, sprint: true, buttons: 1 });
        world.setInput('ab-bob', { seq: 1, moveX: -0.6, moveZ: -1, sprint: false, buttons: 0 });
        return world;
      };

      const a = build();
      const b = build();
      a.stepMany(300);
      b.stepMany(300);
      expect(a.checksum()).toBe(b.checksum());

      // Snapshot round-trip fidelity, mid-round.
      const snapshot = a.snapshot();
      const restored = new World({ seed: 1234, config: modeConfig(id) });
      restored.applySnapshot(snapshot);
      expect(restored.checksum()).toBe(a.checksum());
      expect(restored.snapshot()).toEqual(snapshot);

      // And the restored world keeps simulating identically.
      a.stepMany(120);
      restored.stepMany(120);
      expect(restored.checksum()).toBe(a.checksum());
    });
  }
});
