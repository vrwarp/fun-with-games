import type { RenderState } from '../net/view.js';
import { TEAM_INFO } from '../shared/modes.js';

const TOAST_LIFETIME_MS = 2600;
const MAX_TOASTS = 3;

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

  constructor(parent: HTMLElement, selfId: string) {
    this.#selfId = selfId;
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
  }

  dispose(): void {
    this.root.remove();
  }

  // -------------------------------------------------------------- internals

  #announcePhase(previous: RenderState, state: RenderState): void {
    if (previous.phase.id === 'countdown' && state.phase.id === 'playing') {
      this.#toast('GO!', 'is-big');
    }
  }

  #announceSelf(previous: RenderState, state: RenderState): void {
    const was = previous.players.find((player) => player.id === this.#selfId);
    const now = state.players.find((player) => player.id === this.#selfId);
    if (!was || !now) return;

    if (now.role === 1 && was.role !== 1) this.#toast('🔥 You are IT — tag someone!');
    if (now.role !== 1 && was.role === 1) this.#toast('You passed it on!');

    const gained = (effect: string): boolean =>
      now.effects.includes(effect) && !was.effects.includes(effect);
    if (gained('ko')) this.#toast('💀 Knocked out!');
    if (was.effects.includes('ko') && !now.effects.includes('ko')) this.#toast('Back in!');
    if (gained('speed')) this.#toast('⚡ Speed boost!');
    if (gained('shield')) this.#toast('🛡 Shield!');
    if (gained('frozen')) this.#toast('❄ Frozen!');

    if (now.lap > was.lap) this.#toast(`🏁 Lap ${now.lap}!`);
    if (now.carrying === 'flag' && was.carrying !== 'flag') this.#toast('⚑ You have the flag!');
  }

  #announceGoals(previous: RenderState, state: RenderState): void {
    for (let team = 0; team < state.teamScores.length; team++) {
      const before = previous.teamScores[team] ?? 0;
      const after = state.teamScores[team] ?? 0;
      if (after > before && state.ball !== null) {
        const name = TEAM_INFO[team]?.name ?? `Team ${team + 1}`;
        this.#toast(`⚽ ${name} scores!`);
      }
    }
  }

  #announceCrown(previous: RenderState, state: RenderState): void {
    for (const item of state.items) {
      if (item.kind !== 'crown') continue;
      const before = previous.items.find((entry) => entry.id === item.id);
      if (!before || before.carrierId === item.carrierId) continue;
      if (item.carrierId === this.#selfId) {
        this.#toast('👑 You have the crown!');
      } else if (before.carrierId === this.#selfId) {
        this.#toast('👑 Crown stolen!');
      }
    }
  }

  #toast(text: string, extraClass = ''): void {
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
