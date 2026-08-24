import { describe, expect, it } from 'vitest';
import { DriveHaptics, brakePulseFor, rumbleFor, stepFor } from '@/render/haptics.js';

/**
 * The pedal haptics, against a fake motor.
 *
 * A browser test can tell you a phone vibrated. It cannot tell you it vibrated
 * *proportionately*, which is the entire requirement — and nothing in CI has a
 * motor anyway. So the mapping is a pure function and gets checked here, and
 * the class around it is checked for the things that would otherwise show up
 * as a phone buzzing in somebody's pocket after they closed the tab.
 */

/** A motor that writes down what it was asked to do. */
function fakeMotor() {
  const calls: number[] = [];
  return {
    calls,
    vibrate: (pattern: number | number[]): void => {
      calls.push(Array.isArray(pattern) ? pattern[0]! : pattern);
    },
  };
}

describe('the throttle rumble', () => {
  it('gets heavier the further the pedal goes', () => {
    // `navigator.vibrate` has no amplitude, so "harder" can only be more of
    // each period spent switched on. This is that, and it is the whole trick.
    const light = rumbleFor(0.3);
    const heavy = rumbleFor(1);

    expect(heavy.onMs).toBeGreaterThan(light.onMs);
    expect(light.onMs).toBeGreaterThan(0);
  });

  it('keeps one steady cadence at every pressure', () => {
    // The rate must NOT move with the pedal. A buzz that speeds up reads as a
    // rhythm changing rather than as a weight increasing, and it would then be
    // indistinguishable from the brake, which is a rate.
    const periods = [0.2, 0.5, 0.8, 1].map((amount) => rumbleFor(amount).periodMs);
    expect(new Set(periods).size).toBe(1);
  });

  it('is proportional rather than merely ordered', () => {
    // Half the pedal, half the motor time. "Proportionate to the throttle" is
    // the requirement, not "more when more".
    expect(rumbleFor(0.5).onMs).toBeCloseTo(rumbleFor(1).onMs / 2, 0);
  });

  it('never runs the motor for a whole period', () => {
    // A duty cycle with no gaps stops being felt within a couple of seconds,
    // and spends the battery on a sensation the player has tuned out.
    const full = rumbleFor(1);
    expect(full.onMs).toBeLessThan(full.periodMs);
  });

  it('says nothing for a pedal that is barely touched', () => {
    expect(rumbleFor(0).onMs).toBe(0);
    expect(rumbleFor(0.01).onMs).toBe(0);
  });
});

describe('the brake pulse', () => {
  it('knocks faster AND longer as the pedal goes down', () => {
    const dab = brakePulseFor(0.25);
    const stamp = brakePulseFor(1);

    expect(stamp.periodMs).toBeLessThan(dab.periodMs);
    expect(stamp.onMs).toBeGreaterThan(dab.onMs);
  });

  it('stays a pulse rather than becoming a buzz', () => {
    // The brake has to feel unlike the throttle without being looked at, so it
    // must keep obvious gaps even at full pressure.
    const full = brakePulseFor(1);
    expect(full.onMs).toBeLessThan(full.periodMs / 2);
  });

  it('is slower than the throttle cadence even at its fastest', () => {
    // Separation between the two sensations, stated as a property rather than
    // left to whichever constants happen to be in the file.
    expect(brakePulseFor(1).periodMs).toBeLessThan(rumbleFor(1).periodMs);
    expect(brakePulseFor(0).onMs).toBe(0);
  });
});

describe('which pedal speaks', () => {
  it('lets the brake win, exactly as the pedals do', () => {
    // Both down resolves to the brake in `TouchDriving.read()`, so feeling the
    // throttle while the car is stopping would be telling the player the
    // opposite of what the car is doing.
    expect(stepFor(1, 0.8)).toEqual(brakePulseFor(0.8));
    expect(stepFor(1, 0)).toEqual(rumbleFor(1));
  });
});

describe('driving the motor', () => {
  it('issues one buzz per period, not one per frame', () => {
    // The render loop runs at 60fps. Re-issuing every frame restarts the motor
    // sixty times a second, which is a continuous hum at every pedal position
    // and throws the duty cycle away entirely.
    const motor = fakeMotor();
    const haptics = new DriveHaptics(motor.vibrate);

    // Two full periods' worth of frames at 60fps.
    const period = rumbleFor(1).periodMs;
    for (let frame = 0; frame * 16 < period * 2; frame++) {
      haptics.update(1, 0, frame * 16);
    }

    expect(motor.calls.length).toBeGreaterThanOrEqual(2);
    expect(motor.calls.length).toBeLessThanOrEqual(3);
  });

  it('asks for a longer buzz when the throttle is buried', () => {
    const light = fakeMotor();
    new DriveHaptics(light.vibrate).update(0.3, 0, 0);
    const heavy = fakeMotor();
    new DriveHaptics(heavy.vibrate).update(1, 0, 0);

    expect(heavy.calls[0]!).toBeGreaterThan(light.calls[0]!);
  });

  it('silences the motor when the pedals come up', () => {
    // Not merely "stops asking". A vibration is queued on the device rather
    // than on the page, so one already running has to be cancelled or it plays
    // out in the player's hand after they lifted off.
    const motor = fakeMotor();
    const haptics = new DriveHaptics(motor.vibrate);

    haptics.update(1, 0, 0);
    expect(motor.calls).toHaveLength(1);

    haptics.update(0, 0, 500);
    expect(motor.calls[motor.calls.length - 1]).toBe(0);
  });

  it('does not spam the cancel once it is already quiet', () => {
    const motor = fakeMotor();
    const haptics = new DriveHaptics(motor.vibrate);

    haptics.update(1, 0, 0);
    for (let i = 1; i < 20; i++) haptics.update(0, 0, i * 16);

    // One buzz, one cancel, and then silence.
    expect(motor.calls).toEqual([expect.any(Number), 0]);
  });

  it('stops and stays stopped once the player turns it off', () => {
    const motor = fakeMotor();
    const haptics = new DriveHaptics(motor.vibrate);

    haptics.update(1, 0, 0);
    haptics.setEnabled(false);
    expect(motor.calls[motor.calls.length - 1]).toBe(0);

    const after = motor.calls.length;
    for (let i = 1; i < 40; i++) haptics.update(1, 0, i * 16);
    expect(motor.calls).toHaveLength(after);
  });

  it('reports itself unsupported rather than pretending, with no motor', () => {
    // Desktop, and every iPhone. The setting is hidden on this signal, because
    // a toggle for something that cannot happen reads as a broken feature.
    const haptics = new DriveHaptics(null);
    expect(haptics.supported).toBe(false);
    expect(haptics.update(1, 0, 0)).toBeNull();
    expect(() => haptics.stop()).not.toThrow();
  });

  it('survives a motor that throws, and gives up on it', () => {
    // Browsers throw from `vibrate` for reasons that have nothing to do with
    // the game: a document never interacted with, a permissions policy. None
    // of them is worth taking the render loop down for, and none of them is
    // worth throwing once a frame for either.
    let attempts = 0;
    const haptics = new DriveHaptics(() => {
      attempts++;
      throw new Error('no user gesture');
    });

    for (let i = 0; i < 40; i++) {
      expect(() => haptics.update(1, 0, i * 100)).not.toThrow();
    }
    expect(attempts).toBe(1);
  });
});
