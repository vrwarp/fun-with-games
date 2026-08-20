import { describe, expect, it, vi } from 'vitest';
import { makeSimConfig, type SimConfigOverrides } from '@/sim/config.js';
import { World } from '@/sim/world.js';

const profile = { name: 'p', color: '#4cc9f0' };

function phasedWorld(overrides: SimConfigOverrides = {}): World {
  return new World({
    seed: 11,
    config: makeSimConfig({
      obstacleCount: 0,
      pickupCount: 0,
      ...overrides,
      phases: {
        enabled: true,
        minPlayers: 2,
        countdownTicks: 10,
        playTicks: 100,
        endTicks: 20,
        targetScore: 0,
        resetScoresOnRoundStart: true,
        ...overrides.phases,
      },
    }),
  });
}

describe('phase machine', () => {
  it('stays pinned to playing when disabled', () => {
    const world = new World({ seed: 1, config: makeSimConfig({ pickupCount: 0 }) });
    world.addPlayer('a', profile);
    world.stepMany(50);
    expect(world.phase.id).toBe('playing');
    expect(world.phase.endTick).toBe(0);
  });

  it('waits in the lobby until enough players join', () => {
    const world = phasedWorld();
    world.addPlayer('a', profile);
    world.stepMany(5);
    expect(world.phase.id).toBe('lobby');

    world.addPlayer('b', profile);
    world.step();
    expect(world.phase.id).toBe('countdown');
  });

  it('runs countdown → playing → ended → countdown with round counting', () => {
    const world = phasedWorld();
    world.addPlayer('a', profile);
    world.addPlayer('b', profile);

    world.step(); // lobby -> countdown
    expect(world.phase.id).toBe('countdown');
    expect(world.phase.round).toBe(1);

    world.stepMany(11);
    expect(world.phase.id).toBe('playing');

    world.stepMany(101); // play timer expires
    expect(world.phase.id).toBe('ended');

    world.stepMany(21); // intermission expires
    expect(world.phase.id).toBe('countdown');
    expect(world.phase.round).toBe(2);
  });

  it('locks movement during the countdown', () => {
    const world = phasedWorld();
    world.addPlayer('a', profile);
    world.addPlayer('b', profile);
    world.step(); // -> countdown

    const player = world.getPlayer('a');
    const startX = player?.x ?? 0;
    world.setInput('a', { seq: 1, moveX: 1, moveZ: 0, sprint: true, buttons: 0 });
    world.stepMany(5); // still inside the 10-tick countdown

    expect(world.phase.id).toBe('countdown');
    expect(player?.x).toBeCloseTo(startX, 6);

    world.stepMany(10); // countdown over — same held input now moves them
    expect(world.phase.id).toBe('playing');
    expect(player?.x ?? 0).toBeGreaterThan(startX);
  });

  it('resets scores and positions when a round starts', () => {
    const world = phasedWorld();
    const a = world.addPlayer('a', profile);
    world.addPlayer('b', profile);
    a.score = 99;
    a.x = 5;

    world.step(); // entering countdown resets the round

    expect(a.score).toBe(0);
    expect(a.x).not.toBe(5);
  });

  it('ends the round at the target score and names the winner', () => {
    const world = phasedWorld({ phases: { targetScore: 5, playTicks: 0 } });
    const a = world.addPlayer('a', profile);
    world.addPlayer('b', profile);
    world.stepMany(12); // through countdown into playing
    expect(world.phase.id).toBe('playing');

    a.score = 5;
    world.step();

    expect(world.phase.id).toBe('ended');
    expect(world.phase.winnerId).toBe('a');
  });

  it('picks the highest score when the timer runs out, or nobody on a tie', () => {
    const world = phasedWorld();
    const a = world.addPlayer('a', profile);
    world.addPlayer('b', profile);
    world.stepMany(12);
    a.score = 3;
    world.stepMany(101);

    expect(world.phase.id).toBe('ended');
    expect(world.phase.winnerId).toBe('a');

    // Next round: tie at the buzzer -> no winner.
    world.stepMany(21); // -> countdown (scores reset)
    world.stepMany(11); // -> playing
    world.stepMany(101);
    expect(world.phase.id).toBe('ended');
    expect(world.phase.winnerId).toBe('');
  });

  it('declares the last player standing in elimination modes', () => {
    const world = phasedWorld({
      phases: { playTicks: 0 },
      combat: { enabled: true, lives: 1, maxHp: 1 },
    });
    const a = world.addPlayer('a', profile);
    world.addPlayer('b', profile);
    world.stepMany(12);
    expect(world.phase.id).toBe('playing');

    a.lives = 0; // knocked out for good
    world.step();

    expect(world.phase.id).toBe('ended');
    expect(world.phase.winnerId).toBe('b');
  });

  it('emits phaseChanged on every transition', () => {
    const world = phasedWorld();
    const changed = vi.fn();
    world.events.on('phaseChanged', changed);

    world.addPlayer('a', profile);
    world.addPlayer('b', profile);
    world.stepMany(12);

    expect(changed).toHaveBeenCalledWith({ phase: 'countdown', round: 1 });
    expect(changed).toHaveBeenCalledWith({ phase: 'playing', round: 1 });
  });

  it('returns to the lobby when players drop below the minimum after a round', () => {
    const world = phasedWorld();
    world.addPlayer('a', profile);
    world.addPlayer('b', profile);
    world.stepMany(12); // playing
    world.stepMany(101); // ended
    world.removePlayer('b');
    world.stepMany(21);

    expect(world.phase.id).toBe('lobby');
  });
});
