import { describe, expect, it, vi } from 'vitest';
import { makeSimConfig, type SimConfigOverrides } from '@/sim/config.js';
import { World } from '@/sim/world.js';

const profile = { name: 'p', color: '#4cc9f0' };

function soccerWorld(overrides: SimConfigOverrides = {}): World {
  return new World({
    seed: 4,
    config: makeSimConfig({
      obstacleCount: 0,
      pickupCount: 0,
      arenaHalfExtentX: 20,
      arenaHalfExtentZ: 20,
      teams: { count: 2 },
      ball: { enabled: true, kickImpulse: 10, friction: 0.4 },
      zones: [
        { kind: 'goal', x: -18, z: 0, radius: 2.5, team: 0, order: 0 },
        { kind: 'goal', x: 18, z: 0, radius: 2.5, team: 1, order: 0 },
      ],
      ...overrides,
    }),
  });
}

describe('ball', () => {
  it('exists only when enabled', () => {
    expect(soccerWorld().ball).not.toBeNull();
    const plain = new World({ seed: 1, config: makeSimConfig({ pickupCount: 0 }) });
    expect(plain.ball).toBeNull();
  });

  it('gets kicked away by a touching player and remembers the toucher', () => {
    const world = soccerWorld();
    const a = world.addPlayer('a', profile);
    Object.assign(a, { x: -1.2, z: 0, vx: 0, vz: 0 }); // ball starts at origin
    world.step();

    const ball = world.ball!;
    expect(ball.vx).toBeGreaterThan(0); // pushed away from the player
    expect(ball.lastTouchId).toBe('a');

    world.stepMany(10);
    expect(world.ball!.x).toBeGreaterThan(0.5);
  });

  it('bounces off walls with restitution', () => {
    const world = soccerWorld({ zones: [] });
    world.addPlayer('a', profile);
    const mutableBall = world.ball as { x: number; z: number; vx: number; vz: number };
    Object.assign(mutableBall, { x: 0, z: 18, vx: 0, vz: 30 });
    world.stepMany(8);

    expect(world.ball!.vz).toBeLessThan(0); // reflected
    expect(world.ball!.z).toBeLessThan(20);
  });

  it('scores for the attacking team and resets to centre', () => {
    const world = soccerWorld();
    const a = world.addPlayer('a', profile); // team 0
    expect(a.team).toBe(0);
    const goal = vi.fn();
    world.events.on('goalScored', goal);

    // Roll the ball into team 1's goal (x=+18): team 0 scores.
    const mutableBall = world.ball as {
      x: number;
      z: number;
      vx: number;
      vz: number;
      lastTouchId: string;
    };
    Object.assign(mutableBall, { x: 16, z: 0, vx: 20, vz: 0, lastTouchId: 'a' });
    world.stepMany(5);

    expect(world.teamScores[0]).toBe(1);
    expect(world.teamScores[1] ?? 0).toBe(0);
    expect(a.score).toBe(1); // personal credit for the scorer
    expect(goal).toHaveBeenCalledWith({ team: 0, byId: 'a' });
    expect(world.ball!.x).toBeCloseTo(0, 6);
    expect(world.ball!.vx).toBe(0);
  });

  it('gives no personal credit for an own goal', () => {
    const world = soccerWorld();
    const a = world.addPlayer('a', profile); // team 0
    world.addPlayer('b', profile); // team 1

    // Ball rolls into team 0's own goal (x=-18): team 1 scores, off a's touch.
    const mutableBall = world.ball as {
      x: number;
      z: number;
      vx: number;
      vz: number;
      lastTouchId: string;
    };
    Object.assign(mutableBall, { x: -16, z: 0, vx: -20, vz: 0, lastTouchId: 'a' });
    // Keep players away from the ball path.
    for (const player of world.players()) Object.assign(player, { x: 0, z: 15 });
    world.stepMany(5);

    expect(world.teamScores[1]).toBe(1);
    expect(a.score).toBe(0);
  });
});
