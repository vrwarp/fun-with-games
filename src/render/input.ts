import { clamp } from '../shared/math.js';
import { BUTTON_PRIMARY, BUTTON_SECONDARY } from '../sim/types.js';

/**
 * One frame of intent, before the simulation decides what it means.
 *
 * Devices produce the same two raw axes — right and forward — and `read()`
 * rotates them by the camera's yaw so that "up" is "away from the camera".
 * **A car is the exception:** its axes are steering and throttle in its own
 * frame, so `main.ts` reads it with no yaw and leaves them raw. That is the
 * whole difference, and it is what makes driving identical in every view.
 */
export interface InputIntent {
  /** Movement on world X, or steering with `vehicle.enabled`. In [-1, 1]. */
  moveX: number;
  /** Movement on world Z, or throttle with `vehicle.enabled`. In [-1, 1]. */
  moveZ: number;
  sprint: boolean;
  /** Action buttons held, as a `BUTTON_*` bitfield (see `@/sim/types`). */
  buttons: number;
}

export const IDLE_INTENT: InputIntent = Object.freeze({
  moveX: 0,
  moveZ: 0,
  sprint: false,
  buttons: 0,
});

/**
 * Combines several input devices into one intent.
 *
 * Movement comes from the first device that is actually steering, so a phone
 * with a Bluetooth keyboard attached can use either — whichever the player
 * touched last simply wins, with no mode switch to get stuck in. Buttons and
 * sprint are OR-combined across devices: holding fire anywhere fires.
 */
export function mergeIntents(...intents: readonly InputIntent[]): InputIntent {
  let buttons = 0;
  let sprint = false;
  for (const intent of intents) {
    buttons |= intent.buttons;
    sprint ||= intent.sprint;
  }

  for (const intent of intents) {
    if (intent.moveX !== 0 || intent.moveZ !== 0) {
      return { moveX: intent.moveX, moveZ: intent.moveZ, sprint, buttons };
    }
  }

  if (!sprint && buttons === 0) return IDLE_INTENT;
  return { moveX: 0, moveZ: 0, sprint, buttons };
}

const FORWARD_KEYS = new Set(['KeyW', 'ArrowUp']);
const BACKWARD_KEYS = new Set(['KeyS', 'ArrowDown']);
const LEFT_KEYS = new Set(['KeyA', 'ArrowLeft']);
const RIGHT_KEYS = new Set(['KeyD', 'ArrowRight']);
const SPRINT_KEYS = new Set(['ShiftLeft', 'ShiftRight']);
/** Primary action (fire / kick / use). Space plus a WASD-adjacent key. */
const PRIMARY_KEYS = new Set(['Space', 'KeyJ']);
/** Secondary action, reserved for game-specific abilities (dash, drop, …). */
const SECONDARY_KEYS = new Set(['KeyE', 'KeyK']);

/**
 * Translates keyboard state into a movement intent.
 *
 * Input is *sampled*, not event-driven: `read()` returns whatever keys are held
 * at that instant. Sampling once per simulation tick keeps input rate
 * independent of both key-repeat behaviour and frame rate, which matters
 * because every sampled intent becomes exactly one networked input.
 */
export class KeyboardInput {
  #held = new Set<string>();
  #target: Window | HTMLElement;
  #attached = false;

  #onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat) return;
    if (this.#isGameKey(event.code)) {
      // Arrow keys scroll the page and space pages down; both fight the game.
      event.preventDefault();
    }
    this.#held.add(event.code);
  };

  #onKeyUp = (event: KeyboardEvent): void => {
    this.#held.delete(event.code);
  };

  /**
   * Alt-tabbing away leaves keys stuck down, and the player walks into a wall
   * for as long as the tab is hidden. Clearing on blur is the fix.
   */
  #onBlur = (): void => {
    this.#held.clear();
  };

  constructor(target: Window | HTMLElement = globalThis.window) {
    this.#target = target;
  }

  attach(): void {
    if (this.#attached) return;
    this.#attached = true;
    this.#target.addEventListener('keydown', this.#onKeyDown as EventListener);
    this.#target.addEventListener('keyup', this.#onKeyUp as EventListener);
    globalThis.window?.addEventListener('blur', this.#onBlur);
  }

  detach(): void {
    if (!this.#attached) return;
    this.#attached = false;
    this.#target.removeEventListener('keydown', this.#onKeyDown as EventListener);
    this.#target.removeEventListener('keyup', this.#onKeyUp as EventListener);
    globalThis.window?.removeEventListener('blur', this.#onBlur);
    this.#held.clear();
  }

  /**
   * Reads the current intent, rotated into world space by `cameraYaw` so that
   * "forward" always means "away from the camera".
   */
  read(cameraYaw: number): InputIntent {
    let right = 0;
    let forward = 0;

    for (const code of this.#held) {
      if (FORWARD_KEYS.has(code)) forward += 1;
      else if (BACKWARD_KEYS.has(code)) forward -= 1;
      else if (RIGHT_KEYS.has(code)) right += 1;
      else if (LEFT_KEYS.has(code)) right -= 1;
    }

    right = clamp(right, -1, 1);
    forward = clamp(forward, -1, 1);

    const sin = Math.sin(cameraYaw);
    const cos = Math.cos(cameraYaw);

    let buttons = 0;
    if ([...PRIMARY_KEYS].some((code) => this.#held.has(code))) buttons |= BUTTON_PRIMARY;
    if ([...SECONDARY_KEYS].some((code) => this.#held.has(code))) buttons |= BUTTON_SECONDARY;

    return {
      moveX: forward * sin + right * cos,
      moveZ: forward * cos - right * sin,
      sprint: [...SPRINT_KEYS].some((code) => this.#held.has(code)),
      buttons,
    };
  }

  #isGameKey(code: string): boolean {
    return (
      FORWARD_KEYS.has(code) ||
      BACKWARD_KEYS.has(code) ||
      LEFT_KEYS.has(code) ||
      RIGHT_KEYS.has(code) ||
      PRIMARY_KEYS.has(code) ||
      SECONDARY_KEYS.has(code)
    );
  }
}
