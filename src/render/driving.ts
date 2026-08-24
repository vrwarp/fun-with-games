import { clamp } from '../shared/math.js';
import { INPUT_DEADZONE } from '../sim/controls.js';
import { IDLE_INTENT, type InputIntent } from './input.js';

/**
 * Deflection below this fraction of the track reads as centred.
 *
 * Never under the simulation's own floor, which is the number that actually
 * decides whether an input does anything. A device with a smaller deadzone
 * than `INPUT_DEADZONE` opens a dead band nobody can see — the knob moves, the
 * value on the wire changes, and the car ignores it — so the two are pinned
 * together here rather than left to drift apart in separate files. A device is
 * free to want MORE than the floor, as this one does: a thumb resting on a
 * track is noisier than a value arriving over the network.
 */
const STEER_DEADZONE = Math.max(0.06, INPUT_DEADZONE);

/**
 * What a pedal gives you for pressing it at all, before any travel.
 *
 * Analog travel must not cost a player the ability to simply jab the throttle
 * and go — that is what the control is for most of the time, and a thumb that
 * lands low on the pedal should not read as "barely move". So the bottom of
 * the travel is a firm press rather than nothing, and the top half is the
 * modulation. A thumb landing in the middle asks for about two thirds.
 */
const PEDAL_FLOOR = 0.35;

/**
 * On-screen driving controls: a steering track for one thumb, pedals for the
 * other.
 *
 * This exists because a car is not steered the way a person is walked, and one
 * thumbstick cannot express the difference. A stick conflates the two axes into
 * a single gesture — to hold a steering angle while lifting off you have to
 * roll one thumb diagonally and hold it there, which is a thing hands are bad
 * at and which makes "turn a bit less" and "slow down" impossible to do
 * independently. Separating them is not a cosmetic change: it is the
 * difference between having a throttle and having a direction.
 *
 * So the two axes get two controls, on two thumbs, exactly as a car does:
 *
 * ```
 *   left thumb    a horizontal track      ->  moveX, steering, analog
 *   right thumb   throttle / brake pedals ->  moveZ, +1 / -1
 * ```
 *
 * The steering track is **horizontal only**. Vertical thumb movement is
 * discarded rather than interpreted, because a thumb pivots around a knuckle
 * and therefore travels in an arc: a control that read the vertical component
 * would apply throttle every time the player steered.
 *
 * Steering **re-centres when released**. A car whose lock stayed where you left
 * it would need a deliberate straightening input after every corner, which is
 * one more thing to get wrong at 27 units per second.
 *
 * **Both pedals are analog, and they read travel rather than pressure.** A
 * screen has no pressure to sense, so asking for one would be a fiction — but
 * a pedal has never really been a pressure sensor either. It is a thing you
 * push further or less far, and how far your thumb has travelled down the
 * control is exactly that, measurable and visible. Press anywhere for a usable
 * amount and slide toward the far edge for all of it.
 *
 * It earns its keep at both ends. Easing the throttle on corner exit is the
 * difference between driving out of a slide and spinning; easing the brake
 * hands grip back to the front tyres through the friction circle, which is
 * what trail braking IS. A binary pedal has two states and neither of those
 * techniques exists.
 *
 * Like every other input device here it produces a plain `InputIntent`, so
 * nothing downstream — prediction, the wire protocol, the simulation — knows
 * or cares that the player is on a phone.
 */
export class TouchDriving {
  readonly root: HTMLElement;
  /**
   * Where a mode's action buttons go — DRS, and anything else a car gets.
   *
   * Handed out rather than positioned independently so that the whole
   * right-hand column stacks in one place. Two absolutely-positioned overlays
   * both claiming the bottom-right corner is how a DRS button ends up sitting
   * on top of the throttle.
   */
  readonly actions: HTMLElement;

  #track: HTMLElement;
  #knob: HTMLElement;
  #throttle: Pedal;
  #brake: Pedal;

  #pointerId: number | null = null;
  #centerX = 0;
  #halfWidth = 1;

  #steer = 0;

  #enabled = false;
  #attached = false;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'driving';
    this.root.dataset['testid'] = 'driving-controls';
    this.root.hidden = true;

    this.#track = document.createElement('div');
    this.#track.className = 'driving__track';
    this.#track.dataset['testid'] = 'driving-steer';
    this.#track.setAttribute('aria-label', 'Steering');

    this.#knob = document.createElement('div');
    this.#knob.className = 'driving__knob';
    this.#track.append(this.#knob);

    const pedals = document.createElement('div');
    pedals.className = 'driving__pedals';

    this.actions = document.createElement('div');
    this.actions.className = 'driving__actions';
    pedals.append(this.actions);

    // Brake above throttle: the thumb rests on the throttle, which is where it
    // spends most of a lap, and reaches up for the brake.
    this.#brake = new Pedal('driving__pedal--brake', 'Brake', 'driving-brake');
    this.#throttle = new Pedal('driving__pedal--throttle', 'Go', 'driving-throttle');
    pedals.append(this.#brake.root, this.#throttle.root);

    this.root.append(this.#track, pedals);
    parent.append(this.root);
  }

  /** Whether the driving controls are currently shown. */
  get enabled(): boolean {
    return this.#enabled;
  }

  attach(): void {
    if (this.#attached) return;
    this.#attached = true;

    this.#track.addEventListener('pointerdown', this.#onPointerDown);
    this.#track.addEventListener('pointermove', this.#onPointerMove);
    this.#track.addEventListener('pointerup', this.#onPointerEnd);
    this.#track.addEventListener('pointercancel', this.#onPointerEnd);
    this.#track.addEventListener('lostpointercapture', this.#onLostCapture);
    window.addEventListener('resize', this.#onResize);
    window.addEventListener('blur', this.#onInterrupted);
    document.addEventListener('visibilitychange', this.#onVisibility);

    // Same reveal rule as the thumbstick: coarse pointer is the honest signal,
    // and a hybrid laptop reports fine until someone actually touches it.
    if (globalThis.matchMedia?.('(pointer: coarse)').matches) this.#show();
    window.addEventListener('touchstart', this.#onFirstTouch, { once: true, passive: true });
  }

  detach(): void {
    if (!this.#attached) return;
    this.#attached = false;

    this.#track.removeEventListener('pointerdown', this.#onPointerDown);
    this.#track.removeEventListener('pointermove', this.#onPointerMove);
    this.#track.removeEventListener('pointerup', this.#onPointerEnd);
    this.#track.removeEventListener('pointercancel', this.#onPointerEnd);
    this.#track.removeEventListener('lostpointercapture', this.#onLostCapture);
    window.removeEventListener('resize', this.#onResize);
    window.removeEventListener('blur', this.#onInterrupted);
    document.removeEventListener('visibilitychange', this.#onVisibility);
    window.removeEventListener('touchstart', this.#onFirstTouch);
    this.#reset();
  }

  dispose(): void {
    this.detach();
    this.root.remove();
  }

  /**
   * Current intent, in the car's own frame.
   *
   * No camera yaw, and deliberately so: steering is steering whatever the
   * camera is doing. That is what makes driving identical in every view, and
   * what stops a chase camera's own lag feeding back into the front axle.
   */
  read(): InputIntent {
    if (!this.#enabled) return IDLE_INTENT;

    // Both pedals at once resolves to the brake, at whatever it is asking for.
    // It is the answer that fails safe, and it is what a real car does with
    // both feet down.
    const pedal = this.#brake.value > 0 ? -this.#brake.value : this.#throttle.value;
    if (this.#steer === 0 && pedal === 0) return IDLE_INTENT;

    return { moveX: this.#steer, moveZ: pedal, sprint: false, buttons: 0 };
  }

  /**
   * How far each pedal is currently pushed, 0-1.
   *
   * Read by the haptics, which is a rendering concern and has no business
   * digging the numbers back out of an `InputIntent` — there the two pedals
   * have already been folded into one signed axis, and a brake and a reverse
   * request are indistinguishable.
   */
  get pedals(): { throttle: number; brake: number } {
    if (!this.#enabled) return { throttle: 0, brake: 0 };
    return { throttle: this.#throttle.value, brake: this.#brake.value };
  }

  // -------------------------------------------------------------- internals

  #onFirstTouch = (): void => {
    this.#show();
  };

  #show(): void {
    if (this.#enabled) return;
    this.#enabled = true;
    this.root.hidden = false;
    this.#measure();
  }

  #onResize = (): void => {
    this.#measure();
  };

  #measure(): void {
    const rect = this.#track.getBoundingClientRect();
    if (rect.width === 0) return;
    this.#centerX = rect.left + rect.width / 2;
    this.#halfWidth = rect.width / 2;
  }

  #onPointerDown = (event: PointerEvent): void => {
    // Deliberately NOT `if (busy) return`. Refusing a second pointer means one
    // missed `pointerup` — a capture torn away, the app backgrounded with a
    // thumb down, an OS gesture cutting in — strands the old id forever: the
    // last steering angle sticks, so the car turns for ever, and every later
    // touch is ignored, so the driver cannot take it back. Last touch wins
    // instead, which is both self-healing and what a driver expects.
    if (this.#pointerId !== null && this.#pointerId !== event.pointerId) {
      this.#releaseTrack(this.#pointerId);
    }
    this.#pointerId = event.pointerId;
    // Capture so a thumb pushed past the end of the track keeps steering
    // rather than silently letting go at full lock.
    this.#track.setPointerCapture(event.pointerId);
    this.#measure();
    this.#update(event);
    event.preventDefault();
  };

  #onPointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.#pointerId) return;
    this.#update(event);
    event.preventDefault();
  };

  #onPointerEnd = (event: PointerEvent): void => {
    if (event.pointerId !== this.#pointerId) return;
    this.#releaseTrack(event.pointerId);
    this.#reset();
    event.preventDefault();
  };

  /**
   * Capture taken away without a `pointerup`.
   *
   * The browser does this on its own — a gesture escalated, an element
   * removed, a device disconnected — and it is the failure that used to leave
   * the wheel stuck at whatever angle it was last at.
   */
  #onLostCapture = (event: PointerEvent): void => {
    if (event.pointerId !== this.#pointerId) return;
    this.#reset();
  };

  /**
   * Anything that means the player's hands are no longer on the controls.
   *
   * A phone that backgrounds the tab mid-corner never delivers the `pointerup`
   * for the thumb that was steering, so without this the car would still be
   * turning — and still be refusing new input — when the player came back.
   */
  #onInterrupted = (): void => {
    this.#reset();
  };

  #onVisibility = (): void => {
    if (document.visibilityState === 'hidden') this.#reset();
  };

  #releaseTrack(pointerId: number): void {
    try {
      if (this.#track.hasPointerCapture(pointerId)) {
        this.#track.releasePointerCapture(pointerId);
      }
    } catch {
      // Releasing a capture the browser has already taken back throws; the
      // reset that follows is the part that matters.
    }
  }

  #update(event: PointerEvent): void {
    // Horizontal only. A thumb pivots around its knuckle and so travels in an
    // arc; reading the vertical component would open the throttle every time
    // the player asked for lock.
    const offset = clamp((event.clientX - this.#centerX) / this.#halfWidth, -1, 1);
    this.#steer = Math.abs(offset) < STEER_DEADZONE ? 0 : offset;
    this.#knob.style.transform = `translateX(${offset * this.#halfWidth}px)`;
  }

  #reset(): void {
    this.#pointerId = null;
    this.#steer = 0;
    this.#knob.style.transform = 'translateX(0px)';
    this.#throttle.release();
    this.#brake.release();
  }
}

/**
 * One analog pedal: press it anywhere, slide toward the far edge for more.
 *
 * Travel is measured from the BOTTOM of the control upward, because that is
 * the direction a thumb travels to push a pedal further — away from the palm.
 * It reads the same on the brake and on the throttle, so there is one gesture
 * to learn rather than two.
 *
 * The recovery rules are the steering track's, and for the same reason: a
 * capture can be taken away without a `pointerup` ever arriving — the tab
 * backgrounded mid-corner, an OS gesture cutting in — and a pedal stranded at
 * full throttle is worse than a wheel stranded at full lock.
 */
class Pedal {
  readonly root: HTMLElement;

  #fill: HTMLElement;
  #pointerId: number | null = null;
  #value = 0;
  #top = 0;
  #height = 1;

  constructor(modifier: string, label: string, testId: string) {
    this.root = document.createElement('div');
    this.root.className = `driving__pedal ${modifier}`;
    this.root.dataset['testid'] = testId;
    // A slider rather than a button, because that is now what it is. Screen
    // readers announcing "button" for a control with travel would be a lie.
    this.root.setAttribute('role', 'slider');
    this.root.setAttribute('aria-label', label);
    this.root.setAttribute('aria-valuemin', '0');
    this.root.setAttribute('aria-valuemax', '100');
    this.root.setAttribute('aria-valuenow', '0');

    // Behind the label, so how far the pedal is down is visible rather than
    // only felt. A control whose state you cannot see is one you have to learn
    // by crashing.
    this.#fill = document.createElement('div');
    this.#fill.className = 'driving__pedal-fill';

    const text = document.createElement('span');
    text.className = 'driving__pedal-label';
    text.textContent = label;

    this.root.append(this.#fill, text);

    this.root.addEventListener('pointerdown', this.#onDown);
    this.root.addEventListener('pointermove', this.#onMove);
    this.root.addEventListener('pointerup', this.#onUp);
    this.root.addEventListener('pointercancel', this.#onUp);
    // Not `pointerleave`: boundary events are suppressed at a captured
    // element, so it would never fire for the case it looks like it covers.
    this.root.addEventListener('lostpointercapture', this.#onLostCapture);
  }

  /** How far down this pedal is, 0-1. */
  get value(): number {
    return this.#value;
  }

  /** Lets go, whatever the pointer is doing. */
  release(): void {
    this.#pointerId = null;
    this.#set(0);
  }

  #onDown = (event: PointerEvent): void => {
    // Last touch wins, exactly as on the steering track: refusing a second
    // pointer is how one missed `pointerup` strands a pedal for ever.
    this.#pointerId = event.pointerId;
    try {
      this.root.setPointerCapture(event.pointerId);
    } catch {
      // A pointer the browser has already taken back. The value below is
      // still worth setting — the press happened.
    }
    this.#measure();
    this.#update(event);
    event.preventDefault();
  };

  #onMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.#pointerId) return;
    this.#update(event);
    event.preventDefault();
  };

  #onUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.#pointerId) return;
    try {
      if (this.root.hasPointerCapture(event.pointerId)) {
        this.root.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Already reclaimed; the release below is the part that matters.
    }
    this.release();
    event.preventDefault();
  };

  #onLostCapture = (event: PointerEvent): void => {
    if (event.pointerId !== this.#pointerId) return;
    this.release();
  };

  #measure(): void {
    const rect = this.root.getBoundingClientRect();
    if (rect.height === 0) return;
    this.#top = rect.top;
    this.#height = rect.height;
  }

  #update(event: PointerEvent): void {
    // 0 at the bottom edge, 1 at the top. Clamped rather than released at the
    // ends so a thumb pushed past the pedal stays at full rather than silently
    // letting go — the same rule the steering track follows at full lock.
    const travel = clamp(1 - (event.clientY - this.#top) / this.#height, 0, 1);
    this.#set(PEDAL_FLOOR + (1 - PEDAL_FLOOR) * travel);
  }

  #set(value: number): void {
    this.#value = value;
    this.root.classList.toggle('is-held', value > 0);
    this.#fill.style.transform = `scaleY(${value})`;
    this.root.setAttribute('aria-valuenow', String(Math.round(value * 100)));
  }
}
