import { clamp } from '../shared/math.js';
import { IDLE_INTENT, type InputIntent } from './input.js';

/** Deflection below this fraction of the track reads as centred. */
const STEER_DEADZONE = 0.06;

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
 * The pedals are discrete rather than analog. A tyre-limited car is controlled
 * by *when* you brake far more than by how hard, and a pressure-sensitive
 * pedal on a screen with no pressure to sense is a fiction. Analog throttle
 * survives on the keyboard and on a gamepad stick, where an axis actually
 * exists.
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
  #throttle: HTMLElement;
  #brake: HTMLElement;

  #pointerId: number | null = null;
  #centerX = 0;
  #halfWidth = 1;

  #steer = 0;
  #throttleHeld = false;
  #brakeHeld = false;

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
    this.#brake = this.#createPedal('driving__pedal--brake', 'Brake', 'driving-brake');
    this.#throttle = this.#createPedal('driving__pedal--throttle', 'Go', 'driving-throttle');
    pedals.append(this.#brake, this.#throttle);

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
    window.addEventListener('resize', this.#onResize);

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
    window.removeEventListener('resize', this.#onResize);
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

    // Both pedals at once resolves to the brake. It is the answer that fails
    // safe, and it is what a real car does with both feet down.
    const pedal = this.#brakeHeld ? -1 : this.#throttleHeld ? 1 : 0;
    if (this.#steer === 0 && pedal === 0) return IDLE_INTENT;

    return { moveX: this.#steer, moveZ: pedal, sprint: false, buttons: 0 };
  }

  // -------------------------------------------------------------- internals

  #createPedal(modifier: string, label: string, testId: string): HTMLElement {
    const pedal = document.createElement('button');
    pedal.type = 'button';
    pedal.className = `driving__pedal ${modifier}`;
    pedal.textContent = label;
    pedal.dataset['testid'] = testId;

    const press = (event: PointerEvent): void => {
      pedal.setPointerCapture(event.pointerId);
      this.#setPedal(pedal, true);
      event.preventDefault();
    };
    const release = (event: PointerEvent): void => {
      if (pedal.hasPointerCapture(event.pointerId)) pedal.releasePointerCapture(event.pointerId);
      this.#setPedal(pedal, false);
      event.preventDefault();
    };

    pedal.addEventListener('pointerdown', press);
    pedal.addEventListener('pointerup', release);
    pedal.addEventListener('pointercancel', release);
    // A pedal is hold state, so a thumb that slides off it has to let go —
    // otherwise the throttle sticks on with nothing holding it down.
    pedal.addEventListener('pointerleave', release);
    return pedal;
  }

  #setPedal(pedal: HTMLElement, held: boolean): void {
    if (pedal === this.#throttle) this.#throttleHeld = held;
    else this.#brakeHeld = held;
    pedal.classList.toggle('is-held', held);
  }

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
    if (this.#pointerId !== null) return;
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
    if (this.#track.hasPointerCapture(event.pointerId)) {
      this.#track.releasePointerCapture(event.pointerId);
    }
    this.#reset();
    event.preventDefault();
  };

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
    this.#throttleHeld = false;
    this.#brakeHeld = false;
    this.#knob.style.transform = 'translateX(0px)';
    this.#throttle.classList.remove('is-held');
    this.#brake.classList.remove('is-held');
  }
}
