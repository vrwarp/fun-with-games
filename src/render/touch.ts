import { clamp } from '../shared/math.js';
import type { InputIntent } from './input.js';

/** Stick deflection beyond this fraction of the radius engages sprint. */
const SPRINT_THRESHOLD = 0.85;

/**
 * An on-screen thumbstick, for playing on a phone.
 *
 * Mobile is a hard requirement for this project (see `CLAUDE.md`), and a
 * keyboard-only game does not meet it. This produces the same `InputIntent`
 * as `KeyboardInput`, so everything downstream — prediction, the wire
 * protocol, the simulation — is completely unaware of how the player moved.
 *
 * Two details that matter on touch devices:
 *
 *  - The stick is a **DOM overlay**, not a canvas widget. Babylon's camera
 *    listens on the canvas, so a touch that starts on this element never
 *    reaches it. That is what lets one thumb drive the stick while another
 *    drags to orbit, with no gesture arbitration code.
 *  - **Sprint lives in the outer ring** rather than on a second button. A
 *    toggle can get stuck on, and a hold-button costs a thumb nobody has
 *    spare.
 */
export class TouchInput {
  readonly root: HTMLElement;

  #base: HTMLElement;
  #knob: HTMLElement;
  #pointerId: number | null = null;
  #centerX = 0;
  #centerY = 0;
  #radius = 56;

  /** Stick deflection, in screen space, normalized to [-1, 1]. */
  #right = 0;
  #forward = 0;
  #magnitude = 0;

  #enabled = false;
  #attached = false;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'touch';
    this.root.dataset['testid'] = 'touch-controls';
    this.root.hidden = true;

    this.#base = document.createElement('div');
    this.#base.className = 'touch__base';
    this.#base.dataset['testid'] = 'touch-stick';

    this.#knob = document.createElement('div');
    this.#knob.className = 'touch__knob';

    this.#base.append(this.#knob);
    this.root.append(this.#base);
    parent.append(this.root);
  }

  /** Whether the thumbstick is currently shown. */
  get enabled(): boolean {
    return this.#enabled;
  }

  attach(): void {
    if (this.#attached) return;
    this.#attached = true;

    this.#base.addEventListener('pointerdown', this.#onPointerDown);
    this.#base.addEventListener('pointermove', this.#onPointerMove);
    this.#base.addEventListener('pointerup', this.#onPointerEnd);
    this.#base.addEventListener('pointercancel', this.#onPointerEnd);
    window.addEventListener('resize', this.#onResize);

    // Coarse pointer is the honest signal for "this is a touch device". A
    // hybrid laptop reports fine, so also reveal the stick the first time a
    // real touch happens.
    if (globalThis.matchMedia?.('(pointer: coarse)').matches) this.#show();
    window.addEventListener('touchstart', this.#onFirstTouch, { once: true, passive: true });
  }

  detach(): void {
    if (!this.#attached) return;
    this.#attached = false;

    this.#base.removeEventListener('pointerdown', this.#onPointerDown);
    this.#base.removeEventListener('pointermove', this.#onPointerMove);
    this.#base.removeEventListener('pointerup', this.#onPointerEnd);
    this.#base.removeEventListener('pointercancel', this.#onPointerEnd);
    window.removeEventListener('resize', this.#onResize);
    window.removeEventListener('touchstart', this.#onFirstTouch);
    this.#reset();
  }

  dispose(): void {
    this.detach();
    this.root.remove();
  }

  /**
   * Current intent, rotated into world space by `cameraYaw` exactly as the
   * keyboard is, so "up" on the stick means "away from the camera".
   */
  read(cameraYaw: number): InputIntent {
    if (!this.#enabled || this.#magnitude === 0) {
      return { moveX: 0, moveZ: 0, sprint: false, buttons: 0 };
    }

    const sin = Math.sin(cameraYaw);
    const cos = Math.cos(cameraYaw);

    return {
      moveX: this.#forward * sin + this.#right * cos,
      moveZ: this.#forward * cos - this.#right * sin,
      sprint: this.#magnitude > SPRINT_THRESHOLD,
      buttons: 0,
    };
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
    const rect = this.#base.getBoundingClientRect();
    if (rect.width === 0) return;
    this.#centerX = rect.left + rect.width / 2;
    this.#centerY = rect.top + rect.height / 2;
    this.#radius = rect.width / 2;
  }

  #onPointerDown = (event: PointerEvent): void => {
    if (this.#pointerId !== null) return;
    this.#pointerId = event.pointerId;
    // Capture so the stick keeps tracking even when the thumb slides outside
    // it — which is exactly what happens when you push it to the edge.
    this.#base.setPointerCapture(event.pointerId);
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
    if (this.#base.hasPointerCapture(event.pointerId)) {
      this.#base.releasePointerCapture(event.pointerId);
    }
    this.#reset();
    event.preventDefault();
  };

  #update(event: PointerEvent): void {
    const dx = event.clientX - this.#centerX;
    // Screen Y grows downward; forward is up.
    const dy = this.#centerY - event.clientY;

    const distance = Math.hypot(dx, dy);
    const clamped = Math.min(distance, this.#radius);
    this.#magnitude = this.#radius > 0 ? clamped / this.#radius : 0;

    if (distance > 0) {
      const scale = clamped / distance;
      this.#right = clamp((dx * scale) / this.#radius, -1, 1);
      this.#forward = clamp((dy * scale) / this.#radius, -1, 1);
      this.#knob.style.transform = `translate(${dx * scale}px, ${-dy * scale}px)`;
    } else {
      this.#right = 0;
      this.#forward = 0;
      this.#knob.style.transform = 'translate(0px, 0px)';
    }

    this.#base.classList.toggle('is-sprinting', this.#magnitude > SPRINT_THRESHOLD);
  }

  #reset(): void {
    this.#pointerId = null;
    this.#right = 0;
    this.#forward = 0;
    this.#magnitude = 0;
    this.#knob.style.transform = 'translate(0px, 0px)';
    this.#base.classList.remove('is-sprinting');
  }
}
