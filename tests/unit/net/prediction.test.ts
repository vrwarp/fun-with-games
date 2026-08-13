import { describe, expect, it } from 'vitest';
import { ClientView } from '@/net/prediction.js';
import { makeSimConfig, tickDeltaSeconds } from '@/sim/config.js';
import { integratePlayer } from '@/sim/systems/movement.js';
import type { PlayerInput, PlayerState, WorldSnapshot } from '@/sim/types.js';

const config = makeSimConfig({ obstacleCount: 0, arenaHalfExtentX: 50, arenaHalfExtentZ: 50 });
const dt = tickDeltaSeconds(config);

function player(id: string, overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    id,
    name: id,
    color: '#4cc9f0',
    x: 0,
    z: 0,
    vx: 0,
    vz: 0,
    heading: 0,
    score: 0,
    lastInputSeq: 0,
    input: { seq: 0, moveX: 0, moveZ: 0, sprint: false },
    ...overrides,
  };
}

function snapshot(tick: number, players: PlayerState[]): WorldSnapshot {
  return { tick, rngState: 1, players, pickups: [] };
}

function makeView(selfId = 'me'): ClientView {
  return new ClientView({
    selfId,
    config,
    obstacles: [],
    interpolationDelayMs: 100,
    errorSmoothingMs: 100,
  });
}

const input = (seq: number, moveX = 1, moveZ = 0): PlayerInput => ({
  seq,
  moveX,
  moveZ,
  sprint: false,
});

describe('ClientView: prediction', () => {
  it('has nothing predicted before the first snapshot', () => {
    const view = makeView();
    view.recordInput(input(1));
    expect(view.predicted).toBeNull();
  });

  it('moves the local player immediately, without waiting for the host', () => {
    const view = makeView();
    view.pushSnapshot(snapshot(0, [player('me')]), 0);

    view.recordInput(input(1));

    expect(view.predicted?.x).toBeGreaterThan(0);
  });

  it('matches a locally-run simulation exactly', () => {
    // Prediction must use the same integrator as the host, or every snapshot
    // produces a visible correction.
    const view = makeView();
    view.pushSnapshot(snapshot(0, [player('me')]), 0);

    const reference = player('me');
    for (let seq = 1; seq <= 10; seq++) {
      const step = input(seq, 1, 0.5);
      view.recordInput(step);
      integratePlayer(reference, step, config, [], dt);
    }

    expect(view.predicted?.x).toBeCloseTo(reference.x, 10);
    expect(view.predicted?.z).toBeCloseTo(reference.z, 10);
  });

  it('tracks unacknowledged inputs', () => {
    const view = makeView();
    view.pushSnapshot(snapshot(0, [player('me')]), 0);

    view.recordInput(input(1));
    view.recordInput(input(2));
    view.recordInput(input(3));
    expect(view.pendingInputCount).toBe(3);

    view.pushSnapshot(snapshot(1, [player('me', { lastInputSeq: 2 })]), 100);
    expect(view.pendingInputCount).toBe(1);
  });
});

describe('ClientView: reconciliation', () => {
  it('replays unacknowledged inputs on top of authoritative state', () => {
    const view = makeView();
    view.pushSnapshot(snapshot(0, [player('me')]), 0);

    for (let seq = 1; seq <= 5; seq++) view.recordInput(input(seq));

    // Host has consumed 3 of the 5 and reports where that left us.
    const authoritative = player('me');
    for (let seq = 1; seq <= 3; seq++) {
      integratePlayer(authoritative, input(seq), config, [], dt);
    }
    view.pushSnapshot(snapshot(1, [{ ...authoritative }]), 100);

    // Predicted state should equal authoritative + inputs 4 and 5.
    const expected = { ...authoritative };
    integratePlayer(expected, input(4), config, [], dt);
    integratePlayer(expected, input(5), config, [], dt);

    expect(view.predicted?.x).toBeCloseTo(expected.x, 10);
    expect(view.pendingInputCount).toBe(2);
  });

  it('adopts authoritative score and position wholesale', () => {
    const view = makeView();
    view.pushSnapshot(snapshot(0, [player('me')]), 0);
    view.recordInput(input(1));

    view.pushSnapshot(
      snapshot(1, [player('me', { x: 12, z: -4, score: 9, lastInputSeq: 1 })]),
      100,
    );

    expect(view.predicted?.score).toBe(9);
    expect(view.predicted?.x).toBeCloseTo(12, 10);
  });

  it('blends out a small correction instead of snapping', () => {
    const view = makeView();
    view.pushSnapshot(snapshot(0, [player('me')]), 0);
    view.recordInput(input(1));
    const beforeCorrection = view.sample(0, 'host').players[0]?.x ?? 0;

    // Host disagrees slightly.
    view.pushSnapshot(snapshot(1, [player('me', { x: 0.3, lastInputSeq: 1 })]), 100);

    const immediately = view.sample(100, 'host').players[0]?.x ?? 0;
    // Right after the correction the rendered position still reflects where we
    // were, not the raw authoritative value.
    expect(Math.abs(immediately - beforeCorrection)).toBeLessThan(0.3);

    view.advanceSmoothing(200);
    const settled = view.sample(300, 'host').players[0]?.x ?? 0;
    expect(settled).toBeCloseTo(view.predicted?.x ?? 0, 10);
  });

  it('snaps rather than blending when the correction is huge', () => {
    // A 40-unit jump is a teleport or a host migration, not misprediction.
    // Sliding across the arena over 100 ms would look broken.
    const view = makeView();
    view.pushSnapshot(snapshot(0, [player('me')]), 0);
    view.recordInput(input(1));

    view.pushSnapshot(snapshot(1, [player('me', { x: 40, lastInputSeq: 1 })]), 100);

    const rendered = view.sample(100, 'host').players[0]?.x ?? 0;
    expect(rendered).toBeCloseTo(40, 6);
  });

  it('clears prediction when the host stops reporting us', () => {
    const view = makeView();
    view.pushSnapshot(snapshot(0, [player('me')]), 0);
    view.recordInput(input(1));

    view.pushSnapshot(snapshot(1, [player('other')]), 100);

    expect(view.predicted).toBeNull();
    expect(view.pendingInputCount).toBe(0);
  });
});

describe('ClientView: interpolation', () => {
  it('renders remote players between the two straddling snapshots', () => {
    const view = makeView();
    view.pushSnapshot(snapshot(0, [player('me'), player('them', { x: 0 })]), 0);
    view.pushSnapshot(snapshot(1, [player('me'), player('them', { x: 10 })]), 100);

    // Render time = now - 100 ms delay = 50, halfway between the snapshots.
    const state = view.sample(150, 'host');
    const them = state.players.find((p) => p.id === 'them');
    expect(them?.x).toBeCloseTo(5, 6);
  });

  it('clamps to the newest snapshot when the network stalls', () => {
    // Extrapolating would be more responsive and much more likely to be wrong.
    const view = makeView();
    view.pushSnapshot(snapshot(0, [player('them', { x: 0 })]), 0);
    view.pushSnapshot(snapshot(1, [player('them', { x: 10 })]), 100);

    const state = view.sample(5000, 'host');
    expect(state.players.find((p) => p.id === 'them')?.x).toBeCloseTo(10, 6);
  });

  it('shows the only snapshot it has before the buffer fills', () => {
    const view = makeView();
    view.pushSnapshot(snapshot(0, [player('them', { x: 3 })]), 0);
    expect(view.sample(0, 'host').players[0]?.x).toBeCloseTo(3, 6);
  });

  it('handles a player appearing only in the newer snapshot', () => {
    const view = makeView();
    view.pushSnapshot(snapshot(0, [player('them', { x: 0 })]), 0);
    view.pushSnapshot(snapshot(1, [player('them', { x: 1 }), player('new', { x: 7 })]), 100);

    const state = view.sample(150, 'host');
    expect(state.players.find((p) => p.id === 'new')?.x).toBeCloseTo(7, 6);
  });

  it('returns an empty state with nothing buffered', () => {
    expect(makeView().sample(0, 'host')).toEqual({ tick: 0, players: [], pickups: [] });
  });

  it('ignores an out-of-order snapshot', () => {
    const view = makeView();
    view.pushSnapshot(snapshot(5, [player('them', { x: 10 })]), 100);
    view.pushSnapshot(snapshot(2, [player('them', { x: 0 })]), 110);

    expect(view.bufferedSnapshotCount).toBe(1);
    expect(view.sample(500, 'host').players[0]?.x).toBeCloseTo(10, 6);
  });

  it('takes pickups from the newest snapshot without interpolating', () => {
    const view = makeView();
    view.pushSnapshot(
      {
        tick: 0,
        rngState: 1,
        players: [],
        pickups: [{ id: 0, x: 0, z: 0, active: true, respawnTick: 0 }],
      },
      0,
    );
    view.pushSnapshot(
      {
        tick: 1,
        rngState: 1,
        players: [],
        pickups: [{ id: 0, x: 9, z: 0, active: false, respawnTick: 5 }],
      },
      100,
    );

    const state = view.sample(150, 'host');
    expect(state.pickups[0]).toMatchObject({ x: 9, active: false });
  });

  it('marks the local player and the host', () => {
    const view = makeView('me');
    view.pushSnapshot(snapshot(0, [player('me'), player('boss')]), 0);

    const state = view.sample(0, 'boss');
    expect(state.players.find((p) => p.id === 'me')?.isLocal).toBe(true);
    expect(state.players.find((p) => p.id === 'boss')?.isHost).toBe(true);
  });

  it('prunes stale snapshots but always keeps enough to interpolate', () => {
    const view = makeView();
    for (let i = 0; i < 100; i++) {
      view.pushSnapshot(snapshot(i, [player('them', { x: i })]), i * 100);
    }
    expect(view.bufferedSnapshotCount).toBeGreaterThanOrEqual(2);
    expect(view.bufferedSnapshotCount).toBeLessThan(100);
  });
});

describe('ClientView: sub-tick render interpolation', () => {
  // The simulation steps at 30 Hz but the screen refreshes faster, so the
  // local player has to be drawn *between* steps. Without this it is a step
  // function: still for a frame, then a jump — which reads as the character
  // vibrating against smoothly-scrolling scenery.
  it('draws the local player between two simulation steps', () => {
    const view = makeView();
    view.pushSnapshot(snapshot(0, [player('me')]), 0);
    view.recordInput(input(1));

    const start = view.sample(0, 'host', 0).players[0]?.x ?? 0;
    const middle = view.sample(0, 'host', 0.5).players[0]?.x ?? 0;
    const end = view.sample(0, 'host', 1).players[0]?.x ?? 0;

    expect(end).toBeGreaterThan(start);
    expect(middle).toBeCloseTo((start + end) / 2, 9);
  });

  it('defaults to the newest step when no fraction is given', () => {
    const view = makeView();
    view.pushSnapshot(snapshot(0, [player('me')]), 0);
    view.recordInput(input(1));

    expect(view.sample(0, 'host').players[0]?.x).toBeCloseTo(view.predicted?.x ?? 0, 9);
  });

  it('clamps an out-of-range fraction', () => {
    const view = makeView();
    view.pushSnapshot(snapshot(0, [player('me')]), 0);
    view.recordInput(input(1));

    const end = view.sample(0, 'host', 1).players[0]?.x ?? 0;
    expect(view.sample(0, 'host', 5).players[0]?.x).toBeCloseTo(end, 9);
    expect(view.sample(0, 'host', -3).players[0]?.x).toBeCloseTo(
      view.sample(0, 'host', 0).players[0]?.x ?? 0,
      9,
    );
  });

  it('keeps interpolating across an ordinary reconcile', () => {
    // Snapshots arrive every couple of ticks. If reconciling collapsed the
    // interpolation span, the player would jump on most of them — which is
    // exactly the bug this guards.
    const view = makeView();
    view.pushSnapshot(snapshot(0, [player('me')]), 0);
    view.recordInput(input(1));
    view.recordInput(input(2));

    const authoritative = player('me');
    for (const seq of [1, 2]) integratePlayer(authoritative, input(seq), config, [], dt);
    view.pushSnapshot(snapshot(1, [{ ...authoritative }]), 100);

    const start = view.sample(100, 'host', 0).players[0]?.x ?? 0;
    const end = view.sample(100, 'host', 1).players[0]?.x ?? 0;
    expect(end).toBeGreaterThan(start);
  });

  it('collapses the span on a teleport so the snap stays a snap', () => {
    const view = makeView();
    view.pushSnapshot(snapshot(0, [player('me')]), 0);
    view.recordInput(input(1));

    view.pushSnapshot(snapshot(1, [player('me', { x: 40, lastInputSeq: 1 })]), 100);

    // Every fraction renders the same place: no slide across the arena.
    expect(view.sample(100, 'host', 0).players[0]?.x).toBeCloseTo(40, 6);
    expect(view.sample(100, 'host', 1).players[0]?.x).toBeCloseTo(40, 6);
  });
});

describe('ClientView: reset', () => {
  it('drops all state', () => {
    const view = makeView();
    view.pushSnapshot(snapshot(0, [player('me')]), 0);
    view.recordInput(input(1));

    view.reset();

    expect(view.predicted).toBeNull();
    expect(view.pendingInputCount).toBe(0);
    expect(view.bufferedSnapshotCount).toBe(0);
  });
});
