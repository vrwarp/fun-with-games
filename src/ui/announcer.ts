import type { RenderState } from '../net/view.js';
import { TEAM_INFO } from '../shared/modes.js';

const TOAST_LIFETIME_MS = 2600;
const MAX_TOASTS = 3;

/**
 * A semantic label for each announcement, so the caller can attach sound or
 * haptics without re-deriving the diff. Deliberately plain strings: the ui
 * layer cannot import the render layer's audio types.
 */
export type AnnouncerCue =
  | 'go'
  | 'tagged'
  | 'untagged'
  | 'ko'
  | 'respawn'
  | 'goal'
  | 'lap'
  | 'item'
  | 'powerup'
  | 'frozen'
  | 'pickup';

export interface AnnouncerOptions {
  /** Called once per announcement, alongside the toast. */
  onCue?: (cue: AnnouncerCue) => void;
}

/**
 * Turns state *changes* into short on-screen toasts: "GO!", "You are IT!",
 * goals, knockouts, laps, power-ups.
 *
 * Deliberately built by diffing successive `RenderState`s rather than by
 * listening to simulation events: events only fire on the peer that steps the
 * authoritative world (the host), while state reaches every peer. Diffing
 * means every player sees the same announcements — and it is idempotent, so a
 * re-applied snapshot can never double-announce.
 */
export class Announcer {
  readonly root: HTMLElement;

  #selfId: string;
  #previous: RenderState | null = null;
  #onCue: ((cue: AnnouncerCue) => void) | undefined;

  constructor(parent: HTMLElement, selfId: string, options: AnnouncerOptions = {}) {
    this.#selfId = selfId;
    this.#onCue = options.onCue;
    this.root = document.createElement('div');
    this.root.className = 'toasts';
    this.root.dataset['testid'] = 'toasts';
    parent.append(this.root);
  }

  /** Call once per frame with the state just rendered. */
  update(state: RenderState): void {
    const previous = this.#previous;
    this.#previous = state;
    if (!previous) return;
    // A stalled or identical snapshot cannot announce anything new.
    if (state.tick === previous.tick) return;

    this.#announcePhase(previous, state);
    this.#announceSelf(previous, state);
    this.#announceGoals(previous, state);
    this.#announceCrown(previous, state);
    this.#announcePickups(previous, state);
  }

  dispose(): void {
    this.root.remove();
  }

  // -------------------------------------------------------------- internals

  #announcePhase(previous: RenderState, state: RenderState): void {
    if (previous.phase.id === 'countdown' && state.phase.id === 'playing') {
      this.#toast('GO!', 'is-big', 'go');
    }
  }

  #announceSelf(previous: RenderState, state: RenderState): void {
    const was = previous.players.find((player) => player.id === this.#selfId);
    const now = state.players.find((player) => player.id === this.#selfId);
    if (!was || !now) return;

    if (now.role === 1 && was.role !== 1) {
      this.#toast('🔥 You are IT — tag someone!', '', 'tagged');
    }
    if (now.role !== 1 && was.role === 1) this.#toast('You passed it on!', '', 'untagged');

    const gained = (effect: string): boolean =>
      now.effects.includes(effect) && !was.effects.includes(effect);
    if (gained('ko')) this.#toast('💀 Knocked out!', '', 'ko');
    if (was.effects.includes('ko') && !now.effects.includes('ko')) {
      this.#toast('Back in!', '', 'respawn');
    }
    if (gained('speed')) this.#toast('⚡ Speed boost!', '', 'powerup');
    if (gained('shield')) this.#toast('🛡 Shield!', '', 'powerup');
    if (gained('frozen')) this.#toast('❄ Frozen!', '', 'frozen');

    if (now.lap > was.lap) this.#toast(`🏁 Lap ${now.lap}!`, '', 'lap');
    if (now.carrying === 'flag' && was.carrying !== 'flag') {
      this.#toast('⚑ You have the flag!', '', 'item');
    }
  }

  #announceGoals(previous: RenderState, state: RenderState): void {
    for (let team = 0; team < state.teamScores.length; team++) {
      const before = previous.teamScores[team] ?? 0;
      const after = state.teamScores[team] ?? 0;
      if (after > before && state.ball !== null) {
        const name = TEAM_INFO[team]?.name ?? `Team ${team + 1}`;
        this.#toast(`⚽ ${name} scores!`, '', 'goal');
      }
    }
  }

  #announceCrown(previous: RenderState, state: RenderState): void {
    for (const item of state.items) {
      if (item.kind !== 'crown') continue;
      const before = previous.items.find((entry) => entry.id === item.id);
      if (!before || before.carrierId === item.carrierId) continue;
      if (item.carrierId === this.#selfId) {
        this.#toast('👑 You have the crown!', '', 'item');
      } else if (before.carrierId === this.#selfId) {
        this.#toast('👑 Crown stolen!', '', 'tagged');
      }
    }
  }

  /**
   * A pickup that just deactivated right next to us was almost certainly ours.
   * Cue only — a toast per shard would be spam; effect pickups already toast
   * through the effects diff. Deliberately NOT keyed on score changes: tag
   * and crown modes tick scores every second, which would beep forever.
   */
  #announcePickups(previous: RenderState, state: RenderState): void {
    const self = state.players.find((player) => player.id === this.#selfId);
    if (!self) return;

    for (const pickup of state.pickups) {
      if (pickup.active) continue;
      const before = previous.pickups.find((entry) => entry.id === pickup.id);
      if (!before?.active) continue;
      const dx = pickup.x - self.x;
      const dz = pickup.z - self.z;
      if (dx * dx + dz * dz < 6.25) this.#cue('pickup');
    }
  }

  #cue(cue: AnnouncerCue): void {
    this.#onCue?.(cue);
  }

  #toast(text: string, extraClass = '', cue?: AnnouncerCue): void {
    if (cue) this.#cue(cue);
    const toast = document.createElement('div');
    toast.className = extraClass ? `toasts__item ${extraClass}` : 'toasts__item';
    toast.dataset['testid'] = 'toast';
    toast.textContent = text;
    this.root.append(toast);

    while (this.root.childElementCount > MAX_TOASTS) {
      this.root.firstElementChild?.remove();
    }
    setTimeout(() => toast.remove(), TOAST_LIFETIME_MS);
  }
}
