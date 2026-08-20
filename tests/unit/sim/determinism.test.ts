import { describe, expect, it } from 'vitest';
import { makeSimConfig } from '@/sim/config.js';
import { Rng } from '@/sim/rng.js';
import { World } from '@/sim/world.js';
import type { PlayerInput } from '@/sim/types.js';

const config = makeSimConfig({
  arenaHalfExtentX: 16,
  arenaHalfExtentZ: 16,
  obstacleCount: 6,
  pickupCount: 8,
  pickupRespawnTicks: 20,
});

const profile = { name: 'p', color: '#4cc9f0' };

/**
 * Builds a reproducible, varied input stream. Uses `Rng` rather than
 * `Math.random` so a failure can be replayed exactly.
 */
function inputScript(seed: number, ticks: number, playerCount: number): PlayerInput[][] {
  const rng = new Rng(seed);
  const script: PlayerInput[][] = [];
  for (let tick = 0; tick < ticks; tick++) {
    const perPlayer: PlayerInput[] = [];
    for (let p = 0; p < playerCount; p++) {
      perPlayer.push({
        seq: tick + 1,
        moveX: rng.range(-1, 1),
        moveZ: rng.range(-1, 1),
        sprint: rng.next() > 0.7,
        buttons: rng.next() > 0.8 ? 1 : 0,
      });
    }
    script.push(perPlayer);
  }
  return script;
}

function runScript(worldSeed: number, script: PlayerInput[][], playerIds: string[]): World {
  const world = new World({ seed: worldSeed, config });
  for (const id of playerIds) world.addPlayer(id, profile);

  for (const tickInputs of script) {
    playerIds.forEach((id, index) => {
      const input = tickInputs[index];
      if (input) world.setInput(id, input);
    });
    world.step();
  }
  return world;
}

describe('simulation determinism', () => {
  it('two worlds fed identical inputs stay bit-identical', () => {
    // This is the contract the whole architecture rests on. If it breaks,
    // reconciliation drifts and replays stop reproducing bugs.
    const ids = ['alice', 'bob', 'carol'];
    const script = inputScript(2024, 300, ids.length);

    const a = runScript(555, script, ids);
    const b = runScript(555, script, ids);

    expect(a.checksum()).toBe(b.checksum());
    expect(a.snapshot()).toEqual(b.snapshot());
  });

  it('stays identical when players are added in a different order', () => {
    // Peers learn about each other in whatever order the network delivers.
    // The simulation sorts by id precisely so that order cannot matter.
    const script = inputScript(99, 200, 3);

    const forward = runScript(4242, script, ['alice', 'bob', 'carol']);

    const reverse = new World({ seed: 4242, config });
    for (const id of ['carol', 'bob', 'alice']) reverse.addPlayer(id, profile);
    // Re-align spawn positions, which are assigned in join order by design.
    const forwardSpawns = new Map(
      runScript(4242, [], ['alice', 'bob', 'carol'])
        .players()
        .map((p) => [p.id, { x: p.x, z: p.z }]),
    );
    for (const player of reverse.players()) {
      const spawn = forwardSpawns.get(player.id);
      if (spawn) Object.assign(player, spawn);
    }

    const ids = ['alice', 'bob', 'carol'];
    for (const tickInputs of script) {
      ids.forEach((id, index) => {
        const input = tickInputs[index];
        if (input) reverse.setInput(id, input);
      });
      reverse.step();
    }

    expect(reverse.checksum()).toBe(forward.checksum());
  });

  it('diverges when a single input differs', () => {
    // A determinism test that cannot fail is worthless; prove it is sensitive.
    const ids = ['alice', 'bob'];
    const script = inputScript(7, 120, ids.length);
    const tweaked = script.map((tick, index) =>
      index === 60
        ? tick.map((input, p) => (p === 0 ? { ...input, moveX: input.moveX + 0.05 } : input))
        : tick,
    );

    const a = runScript(11, script, ids);
    const b = runScript(11, tweaked, ids);

    expect(a.checksum()).not.toBe(b.checksum());
  });

  it('produces the same result when a run is split and resumed', () => {
    const ids = ['alice', 'bob'];
    const script = inputScript(3, 160, ids.length);

    const straight = runScript(88, script, ids);

    const first = runScript(88, script.slice(0, 80), ids);
    const resumed = new World({ seed: 88, config });
    resumed.applySnapshot(first.snapshot());
    for (const tickInputs of script.slice(80)) {
      ids.forEach((id, index) => {
        const input = tickInputs[index];
        if (input) resumed.setInput(id, input);
      });
      resumed.step();
    }

    expect(resumed.checksum()).toBe(straight.checksum());
  });
});
