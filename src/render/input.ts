import { clamp } from '../shared/math.js';

export interface InputIntent {
  /** World-space movement on X, in [-1, 1]. */
  moveX: number;
  /** World-space movement on Z, in [-1, 1]. */
  moveZ: number;
  sprint: boolean;
}

export const IDLE_INTENT: InputIntent = Object.freeze({ moveX: 0, moveZ: 0, sprint: false });

/**
 * Combines several input devices into one intent.
 *
 * A device that is idle contributes nothing, so a phone with a Bluetooth
 * keyboard attached can use either — whichever the player touched last simply
 * wins, with no mode switch to get stuck in.
 */
export function mergeIntents(...intents: readonly InputIntent[]): InputIntent {
  for (const intent of intents) {
    if (intent.moveX !== 0 || intent.moveZ !== 0) return intent;
  }
  // Nobody is steering; preserve a sprint held on its own.
  const sprint = intents.some((intent) => intent.sprint);
  return sprint ? { moveX: 0, moveZ: 0, sprint: true } : IDLE_INTENT;
}

const FORWARD_KEYS = new Set(['KeyW', 'ArrowUp']);
const BACKWARD_KEYS = new Set(['KeyS', 'ArrowDown']);
const LEFT_KEYS = new Set(['KeyA', 'ArrowLeft']);
const RIGHT_KEYS = new Set(['KeyD', 'ArrowRight']);
const SPRINT_KEYS = new Set(['ShiftLeft', 'ShiftRight']);

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
      // Arrow keys scroll the page otherwise, which fights the camera.
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

    return {
      moveX: forward * sin + right * cos,
      moveZ: forward * cos - right * sin,
      sprint: [...SPRINT_KEYS].some((code) => this.#held.has(code)),
    };
  }

  #isGameKey(code: string): boolean {
    return (
      FORWARD_KEYS.has(code) ||
      BACKWARD_KEYS.has(code) ||
      LEFT_KEYS.has(code) ||
      RIGHT_KEYS.has(code)
    );
  }
}
