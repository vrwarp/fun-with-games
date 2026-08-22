import { describe, expect, it } from 'vitest';
import { modeConfig } from '@/sim/presets.js';
import { World } from '@/sim/world.js';
import { isOnTrack, sampleTrack, trackLength, trackPoseAt } from '@/sim/track.js';
import { hasEffect } from '@/sim/systems/effects.js';
import { tyreLife } from '@/sim/systems/vehicle.js';
import type { SimConfig } from '@/sim/config.js';

/**
 * How a race actually runs, measured rather than asserted in the abstract.
 *
 * Each of these guards a thing that was wrong and was found by measuring it: a
 * lap counted a gate early, a field of bots that were one driver copied five
 * times, a slipstream switched on for most of a lap, and tyres that went to
 * nothing in a race nobody could pit in.
 */
function race(config: SimConfig, seconds: number, bots = 5) {
  const world = new World({ config, seed: 7 });
  for (let i = 0; i < bots; i++) world.addBot();

  const length = trackLength(config.trackPath);
  const lapAt: number[] = [];
  const seenLap = new Map<string, number>();
  const bestLap = new Map<string, number>();
  let tow = 0;
  let off = 0;
  let dead = 0;
  let samples = 0;

  for (let i = 0; i < config.tickRate * seconds; i++) {
    world.step();
    for (const player of world.players()) {
      samples++;
      if (hasEffect(player, 'tow', world.tick)) tow++;
      if (!isOnTrack(config, player.x, player.z)) off++;
      if (tyreLife(player, config, world.tick) <= 0.02) dead++;

      if (player.lap > (seenLap.get(player.id) ?? 0)) {
        seenLap.set(player.id, player.lap);
        lapAt.push(sampleTrack(config.trackPath, player.x, player.z).progress / length);
      }
      if (player.bestLapTicks) {
        const secs = player.bestLapTicks / config.tickRate;
        if (secs < (bestLap.get(player.id) ?? Infinity)) bestLap.set(player.id, secs);
      }
    }
  }

  const best = [...bestLap.values()].sort((a, b) => a - b);
  return {
    /** Mean position round the circuit, 0-1, at which a lap was awarded. */
    lapAt: lapAt.reduce((a, b) => a + b, 0) / Math.max(1, lapAt.length),
    laps: lapAt.length,
    towShare: tow / samples,
    offShare: off / samples,
    deadTyreShare: dead / samples,
    bestLaps: best,
    spread: best.length > 1 ? best[best.length - 1]! - best[0]! : 0,
  };
}

describe('the lap ends at the line', () => {
  it.each(['grandprix', 'street'] as const)(
    'awards %s laps at the finish, not a gate early',
    (mode) => {
      // The gates are evenly spaced and the last one sits a whole gate short of
      // the line, so counting the wrap as the car LEAVES it takes that section
      // off the lap counter, off every lap time, and off where the flag falls.
      const result = race(modeConfig(mode), 90);

      expect(result.laps).toBeGreaterThan(3);
      // Right at the line. The small shortfall is the timing loop's own capture
      // radius, which is symmetric — the clock starts and stops at the same
      // point either side, so lap times are exact even though the trigger sits
      // a car's length before the board.
      expect(result.lapAt).toBeGreaterThan(0.9);
    },
  );

  it('measures a lap time over a whole lap', () => {
    // The lap the bots set has to be consistent with the road they drove: a
    // lap awarded a gate early reads about a ninth quick on this circuit.
    const config = modeConfig('grandprix');
    const result = race(config, 90);
    const length = trackLength(config.trackPath);

    const quickest = result.bestLaps[0]!;
    const impliedSpeed = length / quickest;
    // No car can average more than it can ever go.
    expect(impliedSpeed).toBeLessThan(config.playerMaxSpeed * config.race.drsMultiplier);
    // And a lap this circuit long cannot be done at a crawl either.
    expect(impliedSpeed).toBeGreaterThan(config.playerMaxSpeed * 0.5);
  });
});

describe('the field is a field', () => {
  it('puts a real spread between the bots', () => {
    // Every bot used to share one set of driving constants, so a race was
    // decided entirely by grid slot and the whole field ran nose to tail.
    const result = race(modeConfig('grandprix'), 90);

    expect(result.bestLaps.length).toBeGreaterThan(2);
    expect(result.spread).toBeGreaterThan(0.5);
    // Different, but still all racing drivers.
    expect(result.spread).toBeLessThan(4);
  });

  it('keeps them on the road while they are at it', () => {
    // Style is spread around the traction limit rather than under it, so some
    // bots do run wide. That has to stay a mistake rather than a way of life.
    for (const mode of ['grandprix', 'street'] as const) {
      expect(race(modeConfig(mode), 90).offShare).toBeLessThan(0.15);
    }
  });
});

describe('the slipstream is earned', () => {
  it('is not switched on for most of the lap', () => {
    // A tow that is always available is not a tow, it is everyone's top speed.
    for (const mode of ['grandprix', 'street'] as const) {
      expect(race(modeConfig(mode), 90).towShare).toBeLessThan(0.45);
    }
  });

  it('needs the two cars pointed the same way, not merely close', () => {
    // Exercised directly on two placed cars rather than across a field. A
    // population measurement was tried and is nearly blind here: once cars
    // stopped spinning, a field of bots is almost always aligned anyway, so
    // the aggregate barely moves whether the rule is on or off. What the rule
    // is actually for is the case below — alongside through a corner, where a
    // follower is beside the wake rather than in it.
    const config = modeConfig('grandprix');
    const gap = config.race.slipstreamRange * 0.6;

    const towFor = (followerHeading: (roadHeading: number) => number): boolean => {
      const world = new World({ config, seed: 3 });
      const leader = world.addPlayer('a-leader', { name: 'lead', color: '#fff' });
      const follower = world.addPlayer('b-follower', { name: 'chase', color: '#fff' });
      // The tow is only granted while the round is running, so let the lights
      // go out before placing anybody.
      for (let i = 0; i < config.tickRate * 12; i++) world.step();

      // Both on the racing line, the follower a short way back down it.
      const ahead = trackPoseAt(config.trackPath, 40);
      const behind = trackPoseAt(config.trackPath, 40 - gap);
      const road = Math.atan2(ahead.dirX, ahead.dirZ);

      // Held for several ticks. A tow is granted two ticks at a time, so a
      // single step would still be reading the one the pair picked up sitting
      // on the grid together rather than anything this geometry earned.
      for (let i = 0; i < 4; i++) {
        Object.assign(leader, { x: ahead.x, z: ahead.z, heading: road, vx: 0, vz: 0 });
        Object.assign(follower, {
          x: behind.x,
          z: behind.z,
          heading: followerHeading(road),
          vx: 0,
          vz: 0,
        });
        world.step();
      }

      return hasEffect(world.getPlayer('b-follower')!, 'tow', world.tick - 1);
    };

    // Nose to tail down the road: in the wake.
    expect(towFor((road) => road)).toBe(true);
    // Same gap, but square across it: alongside the wake, not in it.
    expect(towFor((road) => road + Math.PI / 2)).toBe(false);
  });
});

describe('tyres go off without ending the race', () => {
  it('wears them down over a grand prix but never to nothing', () => {
    // Wear here is a function of time, so a stint the race can outlast leaves
    // cars on dead rubber — and a car on dead rubber cannot corner, leaves the
    // road, and cannot get back on. The stint is deliberately a little longer
    // than the race for that reason.
    const config = modeConfig('grandprix');
    const world = new World({ config, seed: 7 });
    for (let i = 0; i < 5; i++) world.addBot();

    let worst = 1;
    let winner = 0;
    for (let i = 0; i < config.tickRate * 150; i++) {
      world.step();
      for (const player of world.players()) {
        worst = Math.min(worst, tyreLife(player, config, world.tick));
        winner = Math.max(winner, player.lap);
      }
    }

    // The race is long enough that the car is measurably worse at the end.
    expect(worst).toBeLessThan(0.8);
    // But nobody is ever left driving on nothing.
    expect(worst).toBeGreaterThan(0.1);
    expect(winner).toBeGreaterThanOrEqual(config.phases.targetScore);
  });

  it('leaves the field on the road even so', () => {
    expect(race(modeConfig('grandprix'), 150).deadTyreShare).toBeLessThan(0.02);
  });
});
