import { BUTTON_PRIMARY, BUTTON_SECONDARY } from '../sim/types.js';
import { IDLE_INTENT, type InputIntent } from './input.js';

export interface TouchButtonsOptions {
  /** Show the primary (fire/use) button. */
  primary?: boolean;
  /** Show the secondary button. Off by default; enable it for new abilities. */
  secondary?: boolean;
  /** Label on the primary button. Keep it one short word or an emoji. */
  primaryLabel?: string;
  secondaryLabel?: string;
}

/**
 * On-screen action buttons for phones, opposite the thumbstick.
 *
 * Same philosophy as `TouchInput`: a DOM overlay (touches never reach the
 * canvas or the camera), pointer events with capture, `touch-action: none`,
 * and ≥ 56px hit targets so a thumb cannot miss. Buttons are *hold* state,
 * sampled per tick like every other input — the simulation decides what a
 * press means, including cooldowns.
 *
 * The whole overlay only reveals itself on coarse-pointer devices (or the
 * first real touch), and only when the game mode actually uses a button — a
 * fire button in a mode with nothing to fire is just screen clutter.
 */
export class TouchButtons {
  readonly root: HTMLElement;

  #held = 0;
  #enabled = false;
  #attached = false;
  #anyVisible: boolean;

  constructor(parent: HTMLElement, options: TouchButtonsOptions = {}) {
    this.root = document.createElement('div');
    this.root.className = 'touch-buttons';
    this.root.dataset['testid'] = 'touch-buttons';
    this.root.hidden = true;

    const wantPrimary = options.primary ?? false;
    const wantSecondary = options.secondary ?? false;
    this.#anyVisible = wantPrimary || wantSecondary;

    if (wantSecondary) {
      this.root.append(
        this.#createButton(
          'touch-button-secondary',
          options.secondaryLabel ?? 'B',
          BUTTON_SECONDARY,
        ),
      );
    }
    if (wantPrimary) {
      this.root.append(
        this.#createButton('touch-button-primary', options.primaryLabel ?? 'A', BUTTON_PRIMARY),
      );
    }

    parent.append(this.root);
  }

  attach(): void {
    if (this.#attached || !this.#anyVisible) return;
    this.#attached = true;

    if (globalThis.matchMedia?.('(pointer: coarse)').matches) this.#show();
    window.addEventListener('touchstart', this.#onFirstTouch, { once: true, passive: true });
  }

  detach(): void {
    if (!this.#attached) return;
    this.#attached = false;
    window.removeEventListener('touchstart', this.#onFirstTouch);
    this.#held = 0;
  }

  dispose(): void {
    this.detach();
    this.root.remove();
  }

  /** Currently held buttons as a `BUTTON_*` bitfield. */
  read(): InputIntent {
    if (this.#held === 0) return IDLE_INTENT;
    return { moveX: 0, moveZ: 0, sprint: false, buttons: this.#held };
  }

  // -------------------------------------------------------------- internals

  #onFirstTouch = (): void => {
    this.#show();
  };

  #show(): void {
    if (this.#enabled || !this.#anyVisible) return;
    this.#enabled = true;
    this.root.hidden = false;
  }

  #createButton(testid: string, label: string, bit: number): HTMLElement {
    const button = document.createElement('div');
    button.className = 'touch-buttons__button';
    // A word ("Jump", "Fire") needs a smaller face than the single-character
    // default, or it overflows the 4rem circle.
    if (label.length > 1) button.classList.add('touch-buttons__button--word');
    button.dataset['testid'] = testid;
    button.textContent = label;

    const press = (event: PointerEvent): void => {
      this.#held |= bit;
      button.classList.add('is-held');
      button.setPointerCapture(event.pointerId);
      event.preventDefault();
    };
    const release = (): void => {
      this.#held &= ~bit;
      button.classList.remove('is-held');
    };

    button.addEventListener('pointerdown', press);
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);

    return button;
  }
}
