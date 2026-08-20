import { describe, expect, it } from 'vitest';
import { GAME_MODE_IDS, modeConfig } from '@/sim/presets.js';
import { World } from '@/sim/world.js';

/**
 * The "games are actually playable" safety net.
 *
 * For every mode: fill a world with bots, let it run for a few simulated
 * minutes, and assert the game went somewhere — points were scored, or a
 * round completed. This catches whole-mode configuration bugs that no
 * system-level unit test can see ("the goal zones are outside the arena",
 * "nothing in this mode can ever score", "bots ignore the objective") — the
 * exact bugs that would otherwise surface live, mid-demo.
 */
describe('every mode progresses with bots playing it', () => {
  for (const id of GAME_MODE_IDS) {
    it(`${id}: bots make the game happen`, () => {
      const world = new World({ seed: 42, config: modeConfig(id) });
      for (let i = 0; i < 4; i++) world.addBot();

      let roundEnded = false;
      world.events.on('phaseChanged', ({ phase }) => {
        if (phase === 'ended') roundEnded = true;
      });

      // 200 simulated seconds — enough for the slowest mode to either score
      // or reach the end of a timed round.
      world.stepMany(200 * world.config.tickRate);

      if (world.config.phases.enabled) {
        expect(world.phase.id).not.toBe('lobby');
      }

      const anyScore = world.players().some((player) => player.score > 0);
      const anyTeamScore = world.teamScores.some((score) => score > 0);
      const progressed = anyScore || anyTeamScore || roundEnded || world.phase.round > 1;
      expect(progressed).toBe(true);
    });
  }
});
