import { describe, expect, it, afterEach } from 'vitest';
import { modeOverrides } from '@/sim/presets.js';
import { effectRemaining } from '@/sim/systems/effects.js';
import { isOnTrack } from '@/sim/track.js';
import { BUTTON_PRIMARY, ROLE_IT } from '@/sim/types.js';
import { SessionHarness } from '../helpers/harness.js';

/**
 * Whole-session tests for the game kit: real `NetSession`s over the virtual
 * network, asserting that what one peer's simulation decides is what every
 * peer's screen shows. Peer ids sort alphabetically, so `alpha` is the host.
 */

let harness: SessionHarness;

afterEach(async () => {
  await harness?.disposeAll();
});

describe('tag over the network', () => {
  it('every peer agrees who is it, and a tag propagates', () => {
    harness = new SessionHarness({
      latencyMs: 40,
      config: {
        obstacleCount: 0,
        pickupCount: 0,
        arenaHalfExtentX: 30,
        arenaHalfExtentZ: 30,
        // Long grace: the two players stay overlapped after the forced tag,
        // and a short grace would let the tag bounce straight back mid-test.
        tag: { enabled: true, graceTicks: 300 },
      },
    });
    harness.join('alpha');
    harness.join('bravo');
    harness.advance(1000);

    // Roles assigned on the host and visible on every peer.
    const itSeenByAlpha = harness.state('alpha').players.find((p) => p.role === ROLE_IT);
    const itSeenByBravo = harness.state('bravo').players.find((p) => p.role === ROLE_IT);
    expect(itSeenByAlpha).toBeDefined();
    expect(itSeenByAlpha?.id).toBe(itSeenByBravo?.id);

    // Teleport them together on the authoritative world; the tag must land
    // and reach both screens.
    const world = harness.hostWorld();
    const [a, b] = world.players();
    const previousIt = a?.role === ROLE_IT ? a : b;
    const other = previousIt === a ? b : a;
    Object.assign(other!, { x: previousIt!.x + 0.5, z: previousIt!.z, vx: 0, vz: 0 });
    harness.advance(500);

    const nowIt = harness.state('bravo').players.find((p) => p.role === ROLE_IT);
    expect(nowIt?.id).toBe(other!.id);
  });
});

describe('arena over the network', () => {
  it("a client's fire button crosses the wire, hits, and everyone sees the damage", () => {
    harness = new SessionHarness({
      latencyMs: 30,
      config: {
        obstacleCount: 0,
        pickupCount: 0,
        arenaHalfExtentX: 30,
        arenaHalfExtentZ: 30,
        combat: { enabled: true, maxHp: 3, respawnTicks: 30 },
        projectiles: { enabled: true, cooldownTicks: 8 },
      },
    });
    harness.join('alpha'); // host, will be the target
    harness.join('bravo'); // client, will shoot
    harness.advance(600);

    // Line them up on the authoritative world: bravo behind alpha, facing +Z.
    const world = harness.hostWorld();
    const alphaState = world.getPlayer('alpha')!;
    const bravoState = world.getPlayer('bravo')!;
    Object.assign(alphaState, { x: 0, z: 6, vx: 0, vz: 0 });
    Object.assign(bravoState, { x: 0, z: 0, vx: 0, vz: 0, heading: 0 });

    // The client holds fire. The input message carries the button to the host.
    harness.setIntent('bravo', 0, 0, false, BUTTON_PRIMARY);
    harness.advance(400);
    harness.setIntent('bravo', 0, 0, false, 0);
    harness.advance(400);

    const hpSeenByAlpha = harness.state('alpha').players.find((p) => p.id === 'alpha')?.hp ?? 99;
    const hpSeenByBravo = harness.state('bravo').players.find((p) => p.id === 'alpha')?.hp ?? 99;
    expect(hpSeenByAlpha).toBeLessThan(3);
    expect(hpSeenByAlpha).toBe(hpSeenByBravo);
  });

  it('a knocked-out player respawns and both peers converge on it', () => {
    harness = new SessionHarness({
      latencyMs: 20,
      config: {
        obstacleCount: 0,
        pickupCount: 0,
        combat: { enabled: true, maxHp: 1, respawnTicks: 45, spawnProtectionTicks: 10 },
        projectiles: { enabled: true },
      },
    });
    harness.join('alpha');
    harness.join('bravo');
    harness.advance(600);

    const world = harness.hostWorld();
    Object.assign(world.getPlayer('alpha')!, { x: 0, z: 6, vx: 0, vz: 0 });
    Object.assign(world.getPlayer('bravo')!, { x: 0, z: 0, vx: 0, vz: 0, heading: 0 });
    harness.setIntent('bravo', 0, 0, false, BUTTON_PRIMARY);
    harness.advance(300);
    harness.setIntent('bravo', 0, 0, false, 0);
    // Give the in-flight shot time to land and the snapshot to reach clients.
    harness.advance(300);

    // KO happened…
    expect(
      harness
        .state('bravo')
        .players.find((p) => p.id === 'alpha')
        ?.effects.includes('ko'),
    ).toBe(true);

    // …and after the respawn timer, they are back with full hp on all peers.
    harness.advance(1500);
    for (const peer of ['alpha', 'bravo']) {
      const seen = harness.state(peer).players.find((p) => p.id === 'alpha');
      expect(seen?.effects.includes('ko')).toBe(false);
      expect(seen?.hp).toBe(1);
    }
  });
});

describe('soccer over the network', () => {
  it('a goal scores for the team and every peer sees the same score', () => {
    harness = new SessionHarness({
      latencyMs: 40,
      config: {
        obstacleCount: 0,
        pickupCount: 0,
        arenaHalfExtentX: 20,
        arenaHalfExtentZ: 20,
        teams: { count: 2 },
        ball: { enabled: true },
        zones: [
          { kind: 'goal', x: -18, z: 0, radius: 2.5, team: 0, order: 0 },
          { kind: 'goal', x: 18, z: 0, radius: 2.5, team: 1, order: 0 },
        ],
      },
    });
    harness.join('alpha');
    harness.join('bravo');
    harness.advance(600);

    // Every peer sees the ball.
    expect(harness.state('bravo').ball).not.toBeNull();

    // Park players away, then roll the ball into team 1's goal on the host.
    const world = harness.hostWorld();
    for (const player of world.players()) Object.assign(player, { x: 0, z: 15, vx: 0, vz: 0 });
    const ball = world.ball as { x: number; vx: number; lastTouchId: string };
    Object.assign(ball, { x: 14, vx: 20, lastTouchId: 'alpha' });
    harness.advance(800);

    expect(harness.state('alpha').teamScores).toEqual([1, 0]);
    expect(harness.state('bravo').teamScores).toEqual([1, 0]);
    // The ball reset to centre on every screen.
    expect(Math.abs(harness.state('bravo').ball?.x ?? 99)).toBeLessThan(3);
  });
});

describe('phases over the network', () => {
  it('clients see lobby, countdown and playing, and scores reset', () => {
    harness = new SessionHarness({
      latencyMs: 30,
      config: {
        obstacleCount: 0,
        pickupCount: 0,
        phases: {
          enabled: true,
          minPlayers: 2,
          countdownTicks: 30,
          playTicks: 300,
          endTicks: 30,
        },
      },
    });
    harness.join('alpha');
    harness.advance(400);
    expect(harness.state('alpha').phase.id).toBe('lobby');

    harness.join('bravo');
    harness.advance(300); // enough to reach the countdown
    expect(['countdown', 'playing']).toContain(harness.state('bravo').phase.id);

    harness.advance(1500);
    expect(harness.state('bravo').phase.id).toBe('playing');
    expect(harness.state('bravo').phase.round).toBe(1);
  });
});

describe('bots over the network and host migration', () => {
  it('host-added bots appear on every peer and survive a host migration', () => {
    harness = new SessionHarness({
      latencyMs: 30,
      config: { obstacleCount: 0, pickupCount: 4, arenaHalfExtentX: 20, arenaHalfExtentZ: 20 },
    });
    harness.join('alpha');
    harness.join('bravo');
    harness.join('charlie');
    harness.advance(500);

    // Clients cannot add bots; the host can.
    expect(harness.peer('bravo').session.addBot()).toBe(false);
    expect(harness.peer('alpha').session.addBot()).toBe(true);
    expect(harness.peer('alpha').session.addBot()).toBe(true);
    harness.advance(500);

    expect(harness.state('charlie').players).toHaveLength(5);
    const botSeen = harness.state('charlie').players.find((p) => p.isBot);
    expect(botSeen).toBeDefined();

    // Bots roam on their own.
    const before = harness
      .state('charlie')
      .players.filter((p) => p.isBot)
      .map((p) => ({ x: p.x, z: p.z }));
    harness.advance(2000);
    const after = harness
      .state('charlie')
      .players.filter((p) => p.isBot)
      .map((p) => ({ x: p.x, z: p.z }));
    const moved = before.some(
      (pos, i) => Math.hypot((after[i]?.x ?? 0) - pos.x, (after[i]?.z ?? 0) - pos.z) > 0.5,
    );
    expect(moved).toBe(true);

    // Kill the host. Bravo takes over and KEEPS simulating the bots.
    harness.drop('alpha');
    harness.advance(1000);

    expect(harness.host()?.id).toBe('bravo');
    const bots = harness.state('charlie').players.filter((p) => p.isBot);
    expect(bots).toHaveLength(2);

    const beforeMigrated = bots.map((p) => ({ x: p.x, z: p.z }));
    harness.advance(2000);
    const afterMigrated = harness.state('charlie').players.filter((p) => p.isBot);
    const stillMoving = beforeMigrated.some(
      (pos, i) =>
        Math.hypot((afterMigrated[i]?.x ?? 0) - pos.x, (afterMigrated[i]?.z ?? 0) - pos.z) > 0.5,
    );
    expect(stillMoving).toBe(true);
  });
});

describe('items over the network', () => {
  it('a carried crown follows its carrier on every peer', () => {
    harness = new SessionHarness({
      latencyMs: 30,
      config: {
        obstacleCount: 0,
        pickupCount: 0,
        arenaHalfExtentX: 20,
        arenaHalfExtentZ: 20,
        items: [{ kind: 'crown', homeX: 0, homeZ: 0, team: -1 }],
      },
    });
    harness.join('alpha');
    harness.join('bravo');
    harness.advance(500);

    const world = harness.hostWorld();
    Object.assign(world.getPlayer('bravo')!, { x: 0, z: 0, vx: 0, vz: 0 });
    Object.assign(world.getPlayer('alpha')!, { x: 15, z: 15, vx: 0, vz: 0 });
    harness.advance(300);

    const itemSeenByAlpha = harness.state('alpha').items[0];
    expect(itemSeenByAlpha?.carrierId).toBe('bravo');
    const carrier = harness.state('alpha').players.find((p) => p.id === 'bravo');
    expect(carrier?.carrying).toBe('crown');
  });
});

describe('a grand prix over the network', () => {
  /**
   * The shipped circuit, but with the field shrunk to something a test can
   * finish: two laps, and a tyre stint short enough to actually run out.
   */
  const grandPrix = (): SessionHarness =>
    new SessionHarness({
      latencyMs: 50,
      config: {
        ...modeOverrides('grandprix'),
        phases: {
          enabled: true,
          minPlayers: 2,
          countdownTicks: 30,
          playTicks: 30 * 300,
          targetScore: 2,
        },
      },
    });

  it('puts every car on its own grid slot, pointed down the road', () => {
    harness = grandPrix();
    harness.join('alpha');
    harness.join('bravo');
    harness.advance(200);

    const cars = harness.state('bravo').players;
    expect(cars).toHaveLength(2);

    const config = harness.config;
    for (const car of cars) {
      // On the tarmac, behind the line, facing the way the road goes.
      expect(isOnTrack(config, car.x, car.z)).toBe(true);
      expect(Math.abs(car.heading - Math.PI / 2)).toBeLessThan(0.4);
    }
    const [pole, second] = cars;
    expect(Math.hypot(pole!.x - second!.x, pole!.z - second!.z)).toBeGreaterThan(
      config.playerRadius * 2,
    );
  });

  it('runs a full race: bots lap, times are set, and a winner is declared', () => {
    harness = grandPrix();
    harness.join('alpha');
    harness.join('bravo');
    const world = harness.hostWorld();
    world.addBot();
    world.addBot();

    // Collected as they happen rather than read off the players afterwards:
    // finishing the race starts the next one, and the reset wipes the very
    // lap times this is about.
    const laps: { playerId: string; lapTicks: number; best: boolean }[] = [];
    world.events.on('lapCompleted', (event) => laps.push(event));

    // Long enough for two laps of a ~280-unit circuit at racing pace.
    harness.advance(75_000);

    // Bots that cannot lap would leave the race unwinnable and this test green
    // for the wrong reason, so this is the real assertion.
    for (const bot of world.bots()) {
      const theirs = laps.filter((lap) => lap.playerId === bot.id);
      expect(theirs.length, `${bot.id} completed a lap`).toBeGreaterThan(0);
      for (const lap of theirs) expect(lap.lapTicks, `${bot.id} lap time`).toBeGreaterThan(0);
      expect(
        theirs.some((lap) => lap.best),
        `${bot.id} set a best lap`,
      ).toBe(true);
    }

    // Somebody won a race, and the result reached every screen.
    expect(world.phase.round).toBeGreaterThan(1);
    expect(harness.state('bravo').phase.round).toBe(harness.state('alpha').phase.round);
  });

  it('shows the same running order and lap times on every screen', () => {
    harness = grandPrix();
    harness.join('alpha');
    harness.join('bravo');
    harness.hostWorld().addBot();
    harness.advance(30_000);

    const seenByHost = harness.state('alpha').players;
    const seenByClient = harness.state('bravo').players;
    expect(seenByHost.length).toBe(3);

    for (const car of seenByHost) {
      const mirror = seenByClient.find((entry) => entry.id === car.id);
      expect(mirror, `${car.id} on the client`).toBeDefined();
      expect(mirror!.position).toBe(car.position);
      expect(mirror!.bestLap).toBeCloseTo(car.bestLap, 3);
      expect(mirror!.lap).toBe(car.lap);
    }

    // A running order is a permutation of the field, leader first.
    const positions = seenByClient.map((car) => car.position).sort((a, b) => a - b);
    expect(positions).toEqual([1, 2, 3]);
    expect(harness.state('bravo').totalLaps).toBe(2);
  });

  it('wears tyres down over a stint and refits them in the pit lane', () => {
    harness = grandPrix();
    harness.join('alpha');
    harness.join('bravo');
    harness.advance(20_000);

    const world = harness.hostWorld();
    const car = world.players()[0]!;
    const stint = world.config.race.tyreStintTicks;
    expect(stint).toBeGreaterThan(0);

    const worn = effectRemaining(car, 'tyre', world.tick);
    expect(worn).toBeLessThan(stint);

    // Park it in the pit lane; one visit is a full set again.
    const pit = world.config.zones.find((zone) => zone.kind === 'pit');
    expect(pit).toBeDefined();
    Object.assign(car, { x: pit!.x, z: pit!.z, vx: 0, vz: 0 });
    harness.advance(200);

    expect(effectRemaining(car, 'tyre', world.tick)).toBeGreaterThan(worn);
  });
});
