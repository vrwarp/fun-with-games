import { describe, expect, it } from 'vitest';
import { makeSimConfig, tickDeltaSeconds } from '@/sim/config.js';
import { integratePlayer, resolvePlayerCollisions } from '@/sim/systems/movement.js';
import type { Obstacle } from '@/sim/types.js';
import { makeInput as input, makePlayer } from '../../helpers/factories.js';

const config = makeSimConfig({ arenaHalfExtentX: 10, arenaHalfExtentZ: 10 });
const dt = tickDeltaSeconds(config);

/**
 * Speed and acceleration tests need room to run: in the small arena above, a
 * player reaches the wall long before top speed and the wall zeroes their
 * velocity, which would make those assertions vacuously pass.
 */
const openConfig = makeSimConfig({ arenaHalfExtentX: 5000, arenaHalfExtentZ: 5000 });

describe('integratePlayer', () => {
  it('accelerates in the input direction', () => {
    const player = makePlayer();
    integratePlayer(player, input({ moveX: 1 }), config, [], dt);

    expect(player.vx).toBeGreaterThan(0);
    expect(player.x).toBeGreaterThan(0);
    expect(player.vz).toBe(0);
  });

  it('normalizes diagonal input so it is not faster', () => {
    const straight = makePlayer();
    const diagonal = makePlayer();

    for (let i = 0; i < 60; i++) {
      integratePlayer(straight, input({ moveX: 1, seq: i }), openConfig, [], dt);
      integratePlayer(diagonal, input({ moveX: 1, moveZ: 1, seq: i }), openConfig, [], dt);
    }

    const straightSpeed = Math.hypot(straight.vx, straight.vz);
    const diagonalSpeed = Math.hypot(diagonal.vx, diagonal.vz);
    expect(diagonalSpeed).toBeCloseTo(straightSpeed, 5);
  });

  it('caps speed at the configured maximum', () => {
    const player = makePlayer();
    for (let i = 0; i < 300; i++) {
      integratePlayer(player, input({ moveX: 1, seq: i }), openConfig, [], dt);
    }
    const speed = Math.hypot(player.vx, player.vz);
    // Actually reached the cap, rather than being stopped by a wall.
    expect(speed).toBeCloseTo(openConfig.playerMaxSpeed, 6);
  });

  it('sprint raises the speed cap', () => {
    const walk = makePlayer();
    const run = makePlayer();
    for (let i = 0; i < 300; i++) {
      integratePlayer(walk, input({ moveX: 1, seq: i }), openConfig, [], dt);
      integratePlayer(run, input({ moveX: 1, sprint: true, seq: i }), openConfig, [], dt);
    }
    expect(Math.abs(run.vx)).toBeGreaterThan(Math.abs(walk.vx));
    expect(Math.abs(run.vx)).toBeCloseTo(
      openConfig.playerMaxSpeed * openConfig.playerSprintMultiplier,
      6,
    );
  });

  it('comes to a complete stop with no input', () => {
    const player = makePlayer({ vx: 5, vz: 5 });
    for (let i = 0; i < 300; i++) {
      integratePlayer(player, input({ seq: i }), config, [], dt);
    }
    // Exactly zero, not merely small: residual velocity would make a resting
    // player drift, and drift diverges between host and client.
    expect(player.vx).toBe(0);
    expect(player.vz).toBe(0);
  });

  it('keeps the player inside the arena', () => {
    const player = makePlayer();
    for (let i = 0; i < 600; i++) {
      integratePlayer(player, input({ moveX: 1, moveZ: 1, seq: i }), config, [], dt);
    }

    const limitX = config.arenaHalfExtentX - config.playerRadius;
    const limitZ = config.arenaHalfExtentZ - config.playerRadius;
    expect(player.x).toBeLessThanOrEqual(limitX + 1e-6);
    expect(player.z).toBeLessThanOrEqual(limitZ + 1e-6);
  });

  it('zeroes velocity into a wall so it does not accumulate', () => {
    const player = makePlayer({ x: 100 });
    integratePlayer(player, input({ moveX: 1 }), config, [], dt);
    expect(player.vx).toBe(0);
  });

  it('pushes out of an obstacle instead of passing through', () => {
    const obstacle: Obstacle = { id: 0, x: 2, z: 0, halfX: 1, halfZ: 1 };
    const player = makePlayer({ x: -0.5 });

    for (let i = 0; i < 200; i++) {
      integratePlayer(player, input({ moveX: 1, seq: i }), config, [obstacle], dt);
    }

    // Stopped at the near face, never inside it.
    expect(player.x).toBeLessThanOrEqual(obstacle.x - obstacle.halfX - config.playerRadius + 1e-6);
  });

  it('escapes when spawned exactly inside an obstacle', () => {
    // Degenerate case: the push-out normal is undefined at the centre, so the
    // solver has to fall back to the shallowest axis.
    const obstacle: Obstacle = { id: 0, x: 0, z: 0, halfX: 1, halfZ: 2 };
    const player = makePlayer({ x: 0, z: 0 });

    integratePlayer(player, input(), config, [obstacle], dt);

    const insideX = Math.abs(player.x) < obstacle.halfX + config.playerRadius - 1e-6;
    const insideZ = Math.abs(player.z) < obstacle.halfZ + config.playerRadius - 1e-6;
    expect(insideX && insideZ).toBe(false);
  });

  it('lets the player slide along a wall rather than sticking', () => {
    const obstacle: Obstacle = { id: 0, x: 0, z: 3, halfX: 5, halfZ: 1 };
    const player = makePlayer({ x: 0, z: 0 });

    for (let i = 0; i < 60; i++) {
      // Pushing diagonally into the face: the Z component is blocked, the X
      // component should survive.
      integratePlayer(player, input({ moveX: 1, moveZ: 1, seq: i }), config, [obstacle], dt);
    }

    expect(player.x).toBeGreaterThan(1);
  });

  it('tracks the highest input sequence and never regresses', () => {
    const player = makePlayer();
    integratePlayer(player, input({ seq: 10 }), config, [], dt);
    expect(player.lastInputSeq).toBe(10);

    // A late-arriving older input must not roll the acknowledgement back, or
    // the client would replay inputs the host already consumed.
    integratePlayer(player, input({ seq: 4 }), config, [], dt);
    expect(player.lastInputSeq).toBe(10);
  });

  it('clamps out-of-range input axes', () => {
    const honest = makePlayer();
    const cheater = makePlayer();

    for (let i = 0; i < 60; i++) {
      integratePlayer(honest, input({ moveX: 1, seq: i }), openConfig, [], dt);
      integratePlayer(cheater, input({ moveX: 1000, seq: i }), openConfig, [], dt);
    }

    // Open arena, so this compares actual travel rather than two players
    // parked against the same wall.
    expect(honest.x).toBeGreaterThan(1);
    expect(cheater.x).toBeCloseTo(honest.x, 10);
  });

  it('only updates heading while moving', () => {
    const player = makePlayer({ heading: 1.234 });
    integratePlayer(player, input(), config, [], dt);
    expect(player.heading).toBe(1.234);
  });
});

describe('resolvePlayerCollisions', () => {
  it('separates overlapping players', () => {
    const a = makePlayer({ id: 'a', x: 0 });
    const b = makePlayer({ id: 'b', x: 0.2 });

    resolvePlayerCollisions([a, b], config);

    expect(Math.abs(b.x - a.x)).toBeGreaterThanOrEqual(config.playerRadius * 2 - 1e-6);
  });

  it('leaves separated players untouched', () => {
    const a = makePlayer({ id: 'a', x: 0 });
    const b = makePlayer({ id: 'b', x: 5 });

    resolvePlayerCollisions([a, b], config);

    expect(a.x).toBe(0);
    expect(b.x).toBe(5);
  });

  it('separates perfectly coincident players deterministically', () => {
    const runOnce = (): [number, number] => {
      const a = makePlayer({ id: 'a', x: 0, z: 0 });
      const b = makePlayer({ id: 'b', x: 0, z: 0 });
      resolvePlayerCollisions([a, b], config);
      return [a.x, b.x];
    };

    expect(runOnce()).toEqual(runOnce());
    expect(runOnce()[0]).not.toBe(runOnce()[1]);
  });
});
