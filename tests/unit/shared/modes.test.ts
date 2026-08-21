import { describe, expect, it } from 'vitest';
import { GAME_MODES } from '@/shared/modes.js';

/**
 * The touch button is the only affordance a phone player gets for an action,
 * so what it says is part of whether the mode is playable, not decoration.
 * These guard the contract rather than the specific wording.
 */
describe('action button labels', () => {
  const actionModes = GAME_MODES.filter((mode) => mode.usesPrimaryAction);

  it('covers every mode that shows the primary button', () => {
    // Without this a new mode silently ships a button reading "A", which tells
    // a player it exists but not what it does.
    const unlabelled = actionModes.filter((mode) => mode.primaryLabel === undefined);
    expect(unlabelled.map((mode) => mode.id)).toEqual([]);
  });

  it('keeps labels short enough for a 4rem circle', () => {
    for (const mode of actionModes) {
      expect(mode.primaryLabel!.length, `${mode.id} label`).toBeLessThanOrEqual(5);
      expect(mode.primaryLabel!.trim(), `${mode.id} label`).toBe(mode.primaryLabel);
      expect(mode.primaryLabel, `${mode.id} label`).not.toContain(' ');
    }
  });

  it('does not label a button the mode never shows', () => {
    // A label on a hidden button is dead metadata that reads as a promise.
    for (const mode of GAME_MODES) {
      if (!mode.usesPrimaryAction) {
        expect(mode.primaryLabel, `${mode.id}`).toBeUndefined();
      }
      if (!(mode.usesSecondaryAction ?? false)) {
        expect(mode.secondaryLabel, `${mode.id}`).toBeUndefined();
      }
    }
  });

  it('names the platformer button for what it does', () => {
    const platformer = GAME_MODES.find((mode) => mode.id === 'platformer');
    expect(platformer?.primaryLabel).toBe('Jump');
  });
});
