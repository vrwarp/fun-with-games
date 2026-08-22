import { describe, expect, it, vi } from 'vitest';
import { makeSimConfig, type SimConfigOverrides, type TrackPoint } from '@/sim/config.js';
import { effectRemaining, hasEffect } from '@/sim/systems/effects.js';
import { gapAhead, raceStandings } from '@/sim/systems/race.js';
import { BUTTON_PRIMARY, type PlayerState } from '@/sim/types.js';
import { World } from '@/sim/world.js';

/** A 40 x 20 lap (120 units round), driven anticlockwise from one long side. */
const RECTANGLE_LAP = 120;

const RECTANGLE: readonly TrackPoint[] = [
  { x: 0, z: -10 },
  { x: 20, z: -10 },
  { x: 20, z: 10 },
  { x: -20, z: 10 },
  { x: -20, z: -10 },
];

const profile = { name: 'p', color: '#ffffff' };

function raceWorld(overrides: SimConfigOverrides = {}): World {
  const config = makeSimConfig({
    vehicle: { enabled: true },
    track: { enabled: true, halfWidth: 5 },
    trackPath: RECTANGLE,
    race: { enabled: true },
    playerMaxSpeed: 20,
    arenaHalfExtentX: 40,
    arenaHalfExtentZ: 30,
    obstacleCount: 0,
    pickupCount: 0,
    zones: [
      { kind: 'checkpoint', x: 0, z: -10, radius: 6, team: -1, order: 0 },
      { kind: 'checkpoint', x: 20, z: 0, radius: 6, team: -1, order: 1 },
      { kind: 'checkpoint', x: 0, z: 10, radius: 6, team: -1, order: 2 },
      { kind: 'checkpoint', x: -20, z: 0, radius: 6, team: -1, order: 3 },
    ],
    ...overrides,
  });
  return new World({ seed: 5, config });
}

/** Puts a car at a spot on the road, stationary, with no round-reset noise. */
function place(world: World, id: string, x: number, z: number): PlayerState {
  const player = world.addPlayer(id, profile);
  Object.assign(player, { x, z, vx: 0, vz: 0, heading: Math.PI / 2 });
  return player;
}

describe('race standings', () => {
  it('ranks by laps, then gates, then how close the next gate is', () => {
    const world = raceWorld();
    const config = world.config;

    const leader = place(world, 'a', 0, -10);
    const second = place(world, 'b', 0, -10);
    const third = place(world, 'c', 0, -10);

    Object.assign(leader, { lap: 1, checkpoint: 0 });
    Object.assign(second, { lap: 0, checkpoint: 2 });
    // Same sector as `second`, but further from the gate it is heading for.
    Object.assign(third, { lap: 0, checkpoint: 2, x: -10, z: 10 });
    Object.assign(second, { x: 5, z: 10 });

    const order = raceStandings(config, world.players()).map((entry) => entry.id);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(raceStandings(config, world.players())[0]?.position).toBe(1);
  });

  it('breaks exact ties by id, so every peer agrees on the order', () => {
    const world = raceWorld();
    place(world, 'b', 0, -10);
    place(world, 'a', 0, -10);
    const order = raceStandings(world.config, world.players()).map((entry) => entry.id);
    expect(order).toEqual(['a', 'b']);
  });

  it('reports an interval to the car ahead, but not across a lap boundary', () => {
    const world = raceWorld();
    // Both heading for gate 1, ten units apart down the same straight.
    const leader = place(world, 'a', 18, -10);
    const chaser = place(world, 'b', 8, -10);
    leader.checkpoint = 1;
    chaser.checkpoint = 1;

    const [first, second] = raceStandings(world.config, world.players());
    expect(first?.id).toBe('a');
    expect(first?.interval).toBe(0); // the leader is behind nobody
    // Ten units at a nominal 20 units/second is half a second.
    expect(second?.interval).toBeCloseTo(0.5, 3);

    // A car a lap ahead is not "1.2 seconds up the road", so no number is
    // better than a wrong one.
    leader.lap = 1;
    expect(raceStandings(world.config, world.players())[1]?.interval).toBe(0);
  });
});

describe('gaps along the road', () => {
  it('measures forward along the centreline and wraps at the line', () => {
    const world = raceWorld();
    const behind = place(world, 'a', -4, -10); // four units before the line
    const ahead = place(world, 'b', 4, -10); // four units after it

    // The wrap is the whole point: a car just past the line is eight units
    // AHEAD of one just before it, not most of a lap behind.
    expect(gapAhead(world.config, behind, ahead)).toBeCloseTo(8, 3);
    // The other way round is almost the whole lap, which is the same fact.
    expect(gapAhead(world.config, ahead, behind)).toBeCloseTo(RECTANGLE_LAP - 8, 3);
  });

  it('is infinite when the mode has no circuit to measure along', () => {
    const world = new World({ seed: 1, config: makeSimConfig() });
    const a = place(world, 'a', 0, 0);
    const b = place(world, 'b', 5, 0);
    expect(gapAhead(world.config, a, b)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('the slipstream', () => {
  it('tows a car that is close behind, and drops it when the gap opens', () => {
    const world = raceWorld({ race: { enabled: true, slipstreamRange: 10 } });
    place(world, 'a', 8, -10); // leader
    const chaser = place(world, 'b', 0, -10); // eight units back — in the tow

    world.step();
    expect(hasEffect(chaser, 'tow', world.tick)).toBe(true);

    // Drop back beyond the range and it lapses within a couple of ticks
    // rather than lingering, because it is refreshed, not granted.
    Object.assign(chaser, { x: -15, z: -10 });
    world.stepMany(4);
    expect(hasEffect(chaser, 'tow', world.tick)).toBe(false);
  });

  it('gives the leader nothing', () => {
    const world = raceWorld({ race: { enabled: true, slipstreamRange: 10 } });
    const leader = place(world, 'a', 8, -10);
    place(world, 'b', 0, -10);
    world.step();
    // The only car ahead of the leader is most of a lap away.
    expect(hasEffect(leader, 'tow', world.tick)).toBe(false);
  });
});

describe('DRS', () => {
  const drsWorld = (): World =>
    raceWorld({
      race: {
        enabled: true,
        drsGapSeconds: 1,
        drsTicks: 40,
        drsButton: 'primary',
        slipstreamRange: 0,
      },
      zones: [
        { kind: 'checkpoint', x: 0, z: -10, radius: 6, team: -1, order: 0 },
        { kind: 'checkpoint', x: 20, z: 0, radius: 6, team: -1, order: 1 },
        { kind: 'checkpoint', x: 0, z: 10, radius: 6, team: -1, order: 2 },
        { kind: 'checkpoint', x: -20, z: 0, radius: 6, team: -1, order: 3 },
        { kind: 'drs', x: 5, z: -10, radius: 8, team: -1, order: 0 },
      ],
    });

  const press = (world: World, id: string): void => {
    world.setInput(id, {
      seq: world.tick + 1,
      moveX: 0,
      moveZ: 0,
      sprint: false,
      buttons: BUTTON_PRIMARY,
    });
  };

  it('arms inside the zone when the car ahead is within the gap', () => {
    const world = drsWorld();
    place(world, 'a', 8, -10);
    const chaser = place(world, 'b', 2, -10); // six units back, inside the zone

    world.step();
    expect(hasEffect(chaser, 'drsok', world.tick)).toBe(true);
  });

  it('stays shut outside the zone, however close the car ahead is', () => {
    const world = drsWorld();
    place(world, 'a', -14, -10);
    const chaser = place(world, 'b', -18, -10); // nose to tail, but past the zone

    press(world, 'b');
    world.step();
    expect(hasEffect(chaser, 'drsok', world.tick)).toBe(false);
    expect(hasEffect(chaser, 'drs', world.tick)).toBe(false);
  });

  it('stays shut in clear air, however far into the zone', () => {
    const world = drsWorld();
    const alone = place(world, 'a', 5, -10);
    place(world, 'b', -18, -10); // most of a lap ahead: no tow, no wing

    press(world, 'a');
    world.step();
    expect(hasEffect(alone, 'drsok', world.tick)).toBe(false);
  });

  it('opens on the button and closes on its own', () => {
    const world = drsWorld();
    place(world, 'a', 8, -10);
    const chaser = place(world, 'b', 2, -10);
    const opened = vi.fn();
    world.events.on('drsOpened', opened);

    press(world, 'b');
    world.step();
    expect(hasEffect(chaser, 'drs', world.tick)).toBe(true);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(effectRemaining(chaser, 'drs', world.tick)).toBeLessThanOrEqual(40);

    // Holding the button must not restart the timer every tick.
    press(world, 'b');
    world.stepMany(5);
    expect(opened).toHaveBeenCalledTimes(1);
  });
});

describe('tyres and the pit lane', () => {
  const pitWorld = (): World =>
    raceWorld({
      race: { enabled: true, tyreStintTicks: 100, pitSpeedLimit: 4 },
      phases: { enabled: false },
      zones: [
        { kind: 'checkpoint', x: 0, z: -10, radius: 6, team: -1, order: 0 },
        { kind: 'pit', x: 0, z: -22, radius: 5, team: -1, order: 0 },
      ],
    });

  it('wears a set down over a stint while the race runs', () => {
    const world = pitWorld();
    const car = place(world, 'a', 0, -10);
    // Fitted once so the stint has somewhere to start from.
    car.effects['tyre'] = 100;

    world.stepMany(60);
    expect(effectRemaining(car, 'tyre', world.tick)).toBe(40);
  });

  it('refits in the pit lane, and only there', () => {
    const world = pitWorld();
    const car = place(world, 'a', 0, -10);
    car.effects['tyre'] = 20;

    world.stepMany(10);
    expect(effectRemaining(car, 'tyre', world.tick)).toBe(10);

    // Into the pits: a full set again, and never fewer than it had. Measured
    // at the tick that was simulated — `world.tick` has already moved on.
    Object.assign(car, { x: 0, z: -22 });
    world.step();
    expect(effectRemaining(car, 'tyre', world.tick - 1)).toBe(100);
  });

  it('fits a fresh set to everyone while the race is not running', () => {
    const world = raceWorld({
      race: { enabled: true, tyreStintTicks: 100 },
      phases: { enabled: true, minPlayers: 3 },
    });
    const car = place(world, 'a', 0, -10);
    expect(world.phase.id).toBe('lobby');

    world.stepMany(5);
    // Warm-up laps must not cost a stint, or a driver who joined early would
    // start the race on rubber they never used.
    expect(effectRemaining(car, 'tyre', world.tick - 1)).toBe(100);
  });
});
