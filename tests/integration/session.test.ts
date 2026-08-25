import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setLogLevel } from '@/shared/logger.js';
import { SessionHarness } from '../helpers/harness.js';

beforeAll(() => {
  // A failing assertion should not be buried under session chatter.
  setLogLevel('silent');
});

let harness: SessionHarness | null = null;

afterEach(async () => {
  await harness?.disposeAll();
  harness = null;
});

function makeHarness(options?: ConstructorParameters<typeof SessionHarness>[0]): SessionHarness {
  harness = new SessionHarness(options);
  return harness;
}

describe('a single peer', () => {
  it('hosts itself and simulates', () => {
    const h = makeHarness();
    h.join('solo');
    h.advance(1000);

    expect(h.peer('solo').session.isHost).toBe(true);
    expect(h.peer('solo').session.world.tick).toBeGreaterThan(20);
    expect(h.state('solo').players).toHaveLength(1);
  });

  it('moves the local player smoothly when rendering faster than the tick rate', () => {
    // Regression guard. The simulation steps at 30 Hz; a 60 Hz render loop
    // samples it twice per step. If the rendered position is not interpolated
    // across the step it stalls on every other frame and then jumps, which
    // looks like the character vibrating against the scenery — while static
    // geometry, having no such problem, glides smoothly past.
    // A big empty arena: the player must still be running freely when sampled,
    // not parked against a wall (where stalling is correct behaviour).
    const h = makeHarness({
      frameMs: 16,
      config: { arenaHalfExtentX: 500, arenaHalfExtentZ: 500, obstacleCount: 0, pickupCount: 0 },
    });
    h.join('solo');
    h.advance(500);

    h.setIntent('solo', 1, 0);
    h.advance(2000); // reach a constant top speed

    const xs: number[] = [];
    for (let frame = 0; frame < 24; frame++) {
      h.advance(16);
      xs.push(h.state('solo').players.find((p) => p.id === 'solo')?.x ?? 0);
    }

    const deltas = xs.slice(1).map((x, index) => x - (xs[index] ?? 0));

    // At a constant speed every frame must make progress...
    for (const delta of deltas) expect(delta).toBeGreaterThan(0);
    // ...and by very nearly the same amount.
    expect(Math.max(...deltas) - Math.min(...deltas)).toBeLessThan(0.02);
  });

  it('renders the arena pickups', () => {
    const h = makeHarness({ config: { pickupCount: 6 } });
    h.join('solo');
    h.advance(500);

    expect(h.state('solo').pickups).toHaveLength(6);
  });

  it('keeps game time real on a slow renderer and caps a backgrounded return', () => {
    // Ticks are what game time IS, so the frame-delta ceiling is a promise
    // with two sides. A machine rendering at one frame a second must still
    // step a full second of simulation per frame — capping below that would
    // quietly run the whole game in slow motion, which is how three e2e
    // tests once found a "1 fps" page had also nearly stopped ticking. And a
    // tab returning from minutes in the background must NOT replay them all.
    const h = makeHarness();
    h.join('solo');
    h.advance(500);

    const session = h.peer('solo').session;
    const tickRate = h.config.tickRate;
    let now = h.network.now;

    const before = session.world.tick;
    for (let frame = 0; frame < 3; frame++) {
      now += 1000; // a renderer struggling at 1 fps
      session.update(now);
    }
    // Three seconds of wall time must be three seconds of game time, give or
    // take the fraction of a tick the accumulator carries.
    expect(session.world.tick - before).toBeGreaterThanOrEqual(3 * tickRate - 1);
    expect(session.world.tick - before).toBeLessThanOrEqual(3 * tickRate + 1);

    const parked = session.world.tick;
    now += 60_000; // backgrounded for a minute
    session.update(now);
    const replayed = session.world.tick - parked;
    expect(replayed).toBeLessThanOrEqual(tickRate + 1);
    expect(replayed).toBeGreaterThan(0);
  });
});

describe('two peers', () => {
  it('agree on who hosts, by lowest id', () => {
    const h = makeHarness();
    h.join('bravo');
    h.join('alpha');
    h.advance(1000);

    expect(h.peer('alpha').session.isHost).toBe(true);
    expect(h.peer('bravo').session.isHost).toBe(false);
    expect(h.peer('bravo').session.hostId).toBe('alpha');
  });

  it('elects the same host regardless of join order', () => {
    const first = makeHarness();
    first.join('alpha');
    first.join('bravo');
    first.advance(500);
    const hostA = first.peer('bravo').session.hostId;

    const second = new SessionHarness();
    second.join('bravo');
    second.join('alpha');
    second.advance(500);
    const hostB = second.peer('bravo').session.hostId;
    void second.disposeAll();

    expect(hostA).toBe(hostB);
  });

  it('each sees the other in the rendered state', () => {
    const h = makeHarness({ latencyMs: 40 });
    h.join('alpha');
    h.join('bravo');
    h.advance(1500);

    for (const id of ['alpha', 'bravo']) {
      const ids = h
        .state(id)
        .players.map((p) => p.id)
        .sort();
      expect(ids).toEqual(['alpha', 'bravo']);
    }
  });

  it('propagates display names and colours', () => {
    const h = makeHarness({ latencyMs: 30 });
    h.join('alpha', { name: 'Ada', color: '#f72585' });
    h.join('bravo', { name: 'Grace', color: '#06d6a0' });
    h.advance(2000);

    const seenByBravo = h.state('bravo').players.find((p) => p.id === 'alpha');
    expect(seenByBravo?.name).toBe('Ada');
    expect(seenByBravo?.color).toBe('#f72585');
  });

  it('a client’s movement is visible to the host', () => {
    const h = makeHarness({ latencyMs: 50 });
    h.join('alpha');
    h.join('bravo');
    h.advance(500);

    const before = h.state('alpha').players.find((p) => p.id === 'bravo')?.x ?? 0;
    h.setIntent('bravo', 1, 0);
    h.advance(1500);
    const after = h.state('alpha').players.find((p) => p.id === 'bravo')?.x ?? 0;

    expect(after).toBeGreaterThan(before + 1);
  });

  it('the client’s own view converges on the host’s truth', () => {
    const h = makeHarness({ latencyMs: 60 });
    h.join('alpha');
    h.join('bravo');
    h.advance(500);

    h.setIntent('bravo', 1, 0.5);
    h.advance(3000);
    h.setIntent('bravo', 0, 0);
    h.advance(1500);

    const authoritative = h.peer('alpha').session.world.getPlayer('bravo');
    const predicted = h.state('bravo').players.find((p) => p.id === 'bravo');

    expect(authoritative).toBeDefined();
    expect(predicted).toBeDefined();
    // Once inputs stop, prediction and authority must agree closely.
    expect(
      Math.hypot(predicted!.x - authoritative!.x, predicted!.z - authoritative!.z),
    ).toBeLessThan(0.5);
  });

  it('agrees on scores after a pickup is collected', () => {
    const h = makeHarness({
      latencyMs: 40,
      config: { pickupCount: 40, arenaHalfExtentX: 10, arenaHalfExtentZ: 10, obstacleCount: 0 },
    });
    h.join('alpha');
    h.join('bravo');
    h.advance(500);

    // Dense pickups in a small arena: driving in any direction will hit some.
    h.setIntent('alpha', 1, 1, true);
    h.setIntent('bravo', -1, -1, true);
    h.advance(6000);

    const alphaScore = h.score('alpha', 'alpha') ?? 0;
    expect(alphaScore).toBeGreaterThan(0);
    // Both peers report the same number for the same player.
    expect(h.score('bravo', 'alpha')).toBe(alphaScore);
  });
});

describe('three peers', () => {
  it('all agree on the host and see everyone', () => {
    const h = makeHarness({ latencyMs: 40, jitterMs: 20 });
    h.join('charlie');
    h.join('alpha');
    h.join('bravo');
    h.advance(2500);

    expect(h.host()?.id).toBe('alpha');
    for (const peer of h.peers) {
      expect(h.state(peer.id).players).toHaveLength(3);
    }
  });

  it('a late joiner catches up to the running game', () => {
    const h = makeHarness({ latencyMs: 40 });
    h.join('alpha');
    h.join('bravo');
    h.advance(3000);

    const tickBefore = h.peer('alpha').session.world.tick;
    h.join('charlie');
    h.advance(1500);

    // The newcomer is handed the current world, not a fresh one.
    expect(h.state('charlie').tick).toBeGreaterThan(tickBefore);
    expect(h.state('charlie').players).toHaveLength(3);
  });
});

describe('adverse networks', () => {
  it('keeps everyone converged through 20% packet loss', () => {
    // Snapshots are full state, not deltas, so a dropped packet costs latency
    // rather than correctness. This test is what proves that claim.
    const h = makeHarness({ latencyMs: 80, jitterMs: 40, dropRate: 0.2, networkSeed: 4321 });
    h.join('alpha');
    h.join('bravo');
    h.advance(1000);

    h.setIntent('bravo', 1, 0);
    h.advance(4000);
    h.setIntent('bravo', 0, 0);
    h.advance(2000);

    expect(h.network.droppedCount).toBeGreaterThan(0);

    const authoritative = h.peer('alpha').session.world.getPlayer('bravo');
    const predicted = h.state('bravo').players.find((p) => p.id === 'bravo');
    expect(
      Math.hypot(predicted!.x - authoritative!.x, predicted!.z - authoritative!.z),
    ).toBeLessThan(1);
  });

  it('survives high latency', () => {
    const h = makeHarness({ latencyMs: 250 });
    h.join('alpha');
    h.join('bravo');
    h.advance(3000);

    expect(h.state('bravo').players).toHaveLength(2);
    expect(h.peer('bravo').session.hostId).toBe('alpha');
  });
});

describe('host migration', () => {
  it('promotes the next-lowest peer when the host vanishes', () => {
    const h = makeHarness({ latencyMs: 40 });
    h.join('alpha');
    h.join('bravo');
    h.join('charlie');
    h.advance(2000);
    expect(h.host()?.id).toBe('alpha');

    h.drop('alpha');
    h.advance(2000);

    expect(h.peer('bravo').session.isHost).toBe(true);
    expect(h.peer('charlie').session.hostId).toBe('bravo');
  });

  it('carries scores across the handover', () => {
    // The world the new host inherits is the last snapshot it received, so
    // progress survives. Losing scores on migration would make the whole
    // serverless model unusable for a real game.
    const h = makeHarness({
      latencyMs: 30,
      config: { pickupCount: 40, arenaHalfExtentX: 10, arenaHalfExtentZ: 10, obstacleCount: 0 },
    });
    h.join('alpha');
    h.join('bravo');
    h.advance(500);

    h.setIntent('bravo', 1, 1, true);
    h.advance(5000);
    h.setIntent('bravo', 0, 0);
    h.advance(500);

    const scoreBefore = h.score('bravo', 'bravo') ?? 0;
    expect(scoreBefore).toBeGreaterThan(0);

    h.drop('alpha');
    h.advance(1500);

    expect(h.peer('bravo').session.isHost).toBe(true);
    expect(h.score('bravo', 'bravo')).toBeGreaterThanOrEqual(scoreBefore);
  });

  it('keeps simulating after the handover', () => {
    const h = makeHarness({ latencyMs: 30 });
    h.join('alpha');
    h.join('bravo');
    h.advance(1500);

    h.drop('alpha');
    h.advance(500);
    const tick = h.state('bravo').tick;
    h.advance(1500);

    expect(h.state('bravo').tick).toBeGreaterThan(tick);
  });

  it('drops departed players from the roster', () => {
    const h = makeHarness({ latencyMs: 30 });
    h.join('alpha');
    h.join('bravo');
    h.join('charlie');
    h.advance(1500);

    h.drop('charlie');
    h.advance(1500);

    expect(
      h
        .state('alpha')
        .players.map((p) => p.id)
        .sort(),
    ).toEqual(['alpha', 'bravo']);
  });

  it('handles a graceful leave', () => {
    const h = makeHarness({ latencyMs: 30 });
    h.join('alpha');
    h.join('bravo');
    h.advance(1000);

    void h.leave('bravo');
    h.advance(1000);

    expect(h.state('alpha').players.map((p) => p.id)).toEqual(['alpha']);
  });
});

describe('malicious peers', () => {
  it('ignores unparseable traffic without disrupting the game', () => {
    const h = makeHarness({ latencyMs: 20 });
    h.join('alpha');
    h.join('bravo');
    h.advance(1000);

    // A peer can put anything on the wire. The session must shrug it off.
    const rogue = h.network.connect('zulu');
    for (const junk of [null, 'hello', 42, { type: 'input' }, { v: 999, type: 'snapshot' }]) {
      rogue.send(junk);
    }
    h.advance(1000);

    expect(h.peer('alpha').session.isHost).toBe(true);
    expect(h.state('bravo').players.length).toBeGreaterThanOrEqual(2);
  });

  it('does not let a non-host peer dictate world state', () => {
    // Only the elected host's snapshots are authoritative; a higher-id peer
    // claiming to be host must be ignored.
    const h = makeHarness({ latencyMs: 20 });
    h.join('alpha');
    h.join('bravo');
    h.advance(1000);

    const rogue = h.network.connect('zulu');
    rogue.send({
      v: 1,
      type: 'snapshot',
      hostId: 'zulu',
      snapshot: {
        tick: 999999,
        rngState: 1,
        players: [
          {
            id: 'zulu',
            name: 'zulu',
            color: '#ffffff',
            x: 0,
            z: 0,
            vx: 0,
            vz: 0,
            heading: 0,
            score: 9999,
            lastInputSeq: 0,
            input: { seq: 0, moveX: 0, moveZ: 0, sprint: false },
          },
        ],
        pickups: [],
      },
    });
    h.advance(1000);

    // `zulu` does join the game as an ordinary player — anyone can connect to
    // an open room. What must not happen is its self-declared score being
    // believed: only the elected host's snapshots are authoritative.
    expect(h.peer('bravo').session.hostId).toBe('alpha');
    expect(h.score('bravo', 'zulu')).toBe(0);
  });
});
