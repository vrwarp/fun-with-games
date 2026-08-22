import { createLogger } from '../shared/logger.js';

const log = createLogger('render:audio');

/** The gameplay moments that make a sound. `main.ts` maps events to these. */
export type SoundCue =
  | 'score'
  | 'powerup'
  | 'tagged'
  | 'ko'
  | 'respawn'
  | 'goal'
  | 'lap'
  | 'crown'
  | 'countdown'
  | 'go'
  | 'win';

/**
 * Tiny procedural sound effects — pure WebAudio oscillators, no files, no
 * network, in keeping with the "runs with no art at all" rule.
 *
 * Browser autoplay policy blocks audio until the page has been interacted
 * with, so the context resumes on the first pointer or key event and every
 * cue before that is silently dropped. Everything is scheduled on the
 * AudioContext clock (never `setTimeout`), and every failure path degrades
 * to silence: a browser without WebAudio just plays a quiet game.
 */
export class GameAudio {
  #ctx: AudioContext | null = null;
  #attached = false;
  #muted: boolean;

  #resume = (): void => {
    if (!this.#ctx) return;
    if (this.#ctx.state === 'suspended') {
      this.#ctx.resume().catch(() => undefined);
    }
  };

  constructor(options: { muted?: boolean } = {}) {
    this.#muted = options.muted ?? false;
    if (!this.#muted) this.#open();
  }

  get muted(): boolean {
    return this.#muted;
  }

  /**
   * Turns sound on or off.
   *
   * Unmuting opens the audio context lazily, because a player who started
   * muted never had one — and because browsers only allow it to start after a
   * gesture, which flipping this switch conveniently is.
   */
  setMuted(muted: boolean): void {
    if (muted === this.#muted) return;
    this.#muted = muted;

    if (muted) {
      void this.#ctx?.close().catch(() => undefined);
      this.#ctx = null;
      return;
    }

    this.#open();
    if (this.#attached) this.#resume();
  }

  attach(): void {
    if (this.#attached) return;
    this.#attached = true;
    window.addEventListener('pointerdown', this.#resume, { passive: true });
    window.addEventListener('keydown', this.#resume);
  }

  dispose(): void {
    if (this.#attached) {
      window.removeEventListener('pointerdown', this.#resume);
      window.removeEventListener('keydown', this.#resume);
      this.#attached = false;
    }
    void this.#ctx?.close().catch(() => undefined);
    this.#ctx = null;
  }

  #open(): void {
    if (this.#ctx) return;
    try {
      const Ctor =
        globalThis.AudioContext ??
        (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      this.#ctx = Ctor ? new Ctor() : null;
    } catch (error) {
      log.debug('audio unavailable', error);
      this.#ctx = null;
    }
  }

  play(cue: SoundCue): void {
    if (!this.#ctx || this.#ctx.state !== 'running') return;

    switch (cue) {
      case 'score':
        this.#tone([{ freq: 880, at: 0, duration: 0.07 }]);
        break;
      case 'powerup':
        this.#tone([
          { freq: 660, at: 0, duration: 0.06 },
          { freq: 990, at: 0.07, duration: 0.09 },
        ]);
        break;
      case 'tagged':
        this.#tone(
          [
            { freq: 520, at: 0, duration: 0.09 },
            { freq: 370, at: 0.1, duration: 0.14 },
          ],
          'sawtooth',
          0.035,
        );
        break;
      case 'ko':
        this.#tone(
          [
            { freq: 220, at: 0, duration: 0.12 },
            { freq: 140, at: 0.12, duration: 0.22 },
          ],
          'sawtooth',
          0.045,
        );
        break;
      case 'respawn':
        this.#tone([
          { freq: 440, at: 0, duration: 0.07 },
          { freq: 660, at: 0.08, duration: 0.1 },
        ]);
        break;
      case 'goal':
      case 'win':
        this.#tone([
          { freq: 523, at: 0, duration: 0.09 },
          { freq: 659, at: 0.1, duration: 0.09 },
          { freq: 784, at: 0.2, duration: 0.16 },
        ]);
        break;
      case 'lap':
      case 'crown':
        this.#tone([
          { freq: 784, at: 0, duration: 0.06 },
          { freq: 988, at: 0.07, duration: 0.1 },
        ]);
        break;
      case 'countdown':
        this.#tone([{ freq: 440, at: 0, duration: 0.08 }], 'square', 0.03);
        break;
      case 'go':
        this.#tone([{ freq: 880, at: 0, duration: 0.25 }], 'square', 0.045);
        break;
    }
  }

  /** Schedules a short envelope-shaped note sequence on the audio clock. */
  #tone(
    notes: readonly { freq: number; at: number; duration: number }[],
    type: OscillatorType = 'square',
    peak = 0.04,
  ): void {
    const ctx = this.#ctx;
    if (!ctx) return;
    const now = ctx.currentTime;

    for (const note of notes) {
      try {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type;
        osc.frequency.value = note.freq;

        const start = now + note.at;
        const end = start + note.duration;
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(peak, start + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0005, end);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(start);
        osc.stop(end + 0.02);
      } catch (error) {
        log.debug('tone failed', error);
      }
    }
  }
}
