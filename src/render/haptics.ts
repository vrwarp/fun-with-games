import { clamp } from '../shared/math.js';

/**
 * Haptics for the two pedals.
 *
 * ## The constraint that shapes all of this
 *
 * `navigator.vibrate` has **no amplitude**. It takes durations, nothing else:
 * the motor is on or it is off. So "rumble harder" cannot be expressed
 * directly, and every mapping below is a way of spending on/off time to fake
 * an intensity the API will not give you.
 *
 *  - **Throttle is a duty cycle.** A fixed cadence with a longer on-time for
 *    more throttle. At full it is nearly continuous; at a light press it is a
 *    fast flutter with gaps. The pulse rate never changes, which is what makes
 *    it read as one buzz getting stronger rather than as a rhythm speeding up.
 *  - **Brake is a rate.** Discrete knocks that get shorter-spaced and longer
 *    as the pedal goes down, from an occasional tick to a hammer. That is a
 *    different sensation on purpose: a driver has to be able to tell braking
 *    from accelerating without looking, and two intensities of the same buzz
 *    are indistinguishable through a phone case.
 *
 * Brake wins when both are down, matching the pedals themselves.
 *
 * ## Being a good citizen about it
 *
 * The render loop runs at 60fps and `vibrate` must not. Calls are gated to the
 * cadence the pattern asks for, so the API sees ~10 calls a second at most.
 * The motor is also stopped explicitly on release, on blur and when the tab is
 * hidden: a vibration already queued keeps running after the page stops
 * animating, so a player who backgrounds the game mid-corner would otherwise
 * be left holding a buzzing phone.
 *
 * `vibrate` is absent on desktop and, notably, on **iOS Safari** — which is
 * half the phones this game is meant for. Everything here degrades to nothing
 * rather than branching on the platform, and no other behaviour depends on it.
 */

/** Below this the pedal is not really being pressed; say nothing. */
const SILENCE = 0.06;

/** How often the throttle's buzz repeats. Constant, so only the weight moves. */
const RUMBLE_PERIOD_MS = 90;
/**
 * The most of each period the motor may be on.
 *
 * Not 1: a duty cycle that never lets go stops being felt within a second or
 * two, and drains the battery for a sensation the player has stopped noticing.
 */
const RUMBLE_MAX_DUTY = 0.8;

/** Brake knock spacing, from a light touch down to a full press. */
const BRAKE_SLOW_MS = 220;
const BRAKE_FAST_MS = 70;
/** Brake knock length over the same range. */
const BRAKE_SHORT_MS = 8;
const BRAKE_LONG_MS = 26;

/** One step of a vibration pattern: how long on, and how long until the next. */
export interface HapticStep {
  /** Milliseconds of motor. 0 means stay quiet. */
  readonly onMs: number;
  /** Milliseconds until this should be issued again. */
  readonly periodMs: number;
}

const QUIET: HapticStep = { onMs: 0, periodMs: RUMBLE_PERIOD_MS };

const lerp = (from: number, to: number, t: number): number => from + (to - from) * t;

/**
 * The throttle's buzz: a fixed cadence, weighted by how far the pedal is down.
 *
 * Exported so the mapping can be checked without a motor. A browser test can
 * only tell you a phone buzzed; it cannot tell you it buzzed *proportionately*.
 */
export function rumbleFor(throttle: number): HapticStep {
  const amount = clamp(throttle, 0, 1);
  if (amount < SILENCE) return QUIET;
  return {
    onMs: Math.round(RUMBLE_PERIOD_MS * RUMBLE_MAX_DUTY * amount),
    periodMs: RUMBLE_PERIOD_MS,
  };
}

/**
 * The brake's knock: harder means more often AND longer.
 *
 * Both move together deliberately. Rate alone is hard to judge at speed, and
 * length alone is hard to feel at all; moving both makes the difference
 * between a dab and a stamp obvious through a pocket.
 */
export function brakePulseFor(pressure: number): HapticStep {
  const amount = clamp(pressure, 0, 1);
  if (amount < SILENCE) return QUIET;
  return {
    onMs: Math.round(lerp(BRAKE_SHORT_MS, BRAKE_LONG_MS, amount)),
    periodMs: Math.round(lerp(BRAKE_SLOW_MS, BRAKE_FAST_MS, amount)),
  };
}

/** Whichever pedal is speaking. The brake wins, exactly as the pedals do. */
export function stepFor(throttle: number, brake: number): HapticStep {
  return clamp(brake, 0, 1) >= SILENCE ? brakePulseFor(brake) : rumbleFor(throttle);
}

/** What this needs of the platform, so a test can hand it something else. */
export type Vibrate = (pattern: number | number[]) => void;

function platformVibrate(): Vibrate | null {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return null;
  return (pattern) => navigator.vibrate(pattern);
}

/**
 * Drives the motor from the pedals, once per frame.
 *
 * Holds no timers of its own: `update` is called from the render loop with the
 * frame's timestamp and decides whether this frame is one the motor should
 * hear about. That keeps it stoppable — there is no interval left running when
 * the page goes away — and testable, because the clock is a parameter.
 */
export class DriveHaptics {
  #vibrate: Vibrate | null;
  #enabled = true;
  #nextAt = 0;
  #buzzing = false;

  constructor(vibrate: Vibrate | null = platformVibrate()) {
    this.#vibrate = vibrate;
  }

  /** Whether the platform can do this at all. False on desktop and on iOS. */
  get supported(): boolean {
    return this.#vibrate !== null;
  }

  /** Turned off by the player, or by a device that asked for less of this. */
  setEnabled(enabled: boolean): void {
    if (enabled === this.#enabled) return;
    this.#enabled = enabled;
    if (!enabled) this.stop();
  }

  /**
   * One frame. `nowMs` is any monotonic clock — the render loop's is fine.
   *
   * Returns the step it issued, or null for a frame it stayed quiet on, which
   * is what makes the gating observable to a test.
   */
  update(throttle: number, brake: number, nowMs: number): HapticStep | null {
    if (!this.#enabled || !this.#vibrate) return null;

    const step = stepFor(throttle, brake);
    if (step.onMs <= 0) {
      this.stop();
      return null;
    }

    // Not yet due. Re-issuing every frame would restart the motor 60 times a
    // second, which reads as a continuous hum at every pedal position and
    // throws away the whole duty-cycle idea.
    if (nowMs < this.#nextAt) return null;

    this.#nextAt = nowMs + step.periodMs;
    this.#buzzing = true;
    this.#buzz(step.onMs);
    return step;
  }

  /**
   * Silences the motor now.
   *
   * Worth calling even when nothing seems to be running: a vibration is queued
   * on the device, not on the page, so one issued a frame before the tab was
   * hidden outlives the render loop that asked for it.
   */
  stop(): void {
    this.#nextAt = 0;
    if (!this.#buzzing) return;
    this.#buzzing = false;
    this.#buzz(0);
  }

  /**
   * Every call to the motor goes through here, guarded.
   *
   * The guard is on this side rather than inside the platform adapter so that
   * it covers whatever motor was handed in. Browsers throw from `vibrate` for
   * reasons that have nothing to do with the game — a document that has never
   * been interacted with, a permissions policy that forbids it — and none of
   * them is worth taking the render loop down for.
   */
  #buzz(ms: number): void {
    try {
      this.#vibrate?.(ms);
    } catch {
      // Unavailable after all. Stop asking rather than throwing once a frame.
      this.#vibrate = null;
    }
  }
}
