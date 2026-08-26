/**
 * The pre-race loading veil.
 *
 * Shown while the composition root holds the simulation waiting for the
 * scene's art to settle, so a race starts on a dressed circuit instead of
 * counting down over textures that are still arriving. Purely informational:
 * it does not take pointer events, because there is nothing to click and the
 * game underneath is deliberately visible — the circuit dressing itself IS
 * the progress report, the veil just says so in words.
 *
 * The count it shows comes in from outside every frame; this class knows
 * nothing about renderers or manifests, which is what lets the UI layer stay
 * below `render` in the dependency order.
 */
export class LoadingVeil {
  #root: HTMLElement;
  #count: HTMLElement;
  #dismissed = false;

  constructor(host: HTMLElement) {
    this.#root = document.createElement('div');
    this.#root.className = 'loading-veil';
    this.#root.dataset['testid'] = 'loading-veil';
    this.#root.setAttribute('role', 'status');

    const card = document.createElement('div');
    card.className = 'loading-veil__card';

    const title = document.createElement('div');
    title.className = 'loading-veil__title';
    title.textContent = 'Preparing the circuit…';

    this.#count = document.createElement('div');
    this.#count.className = 'loading-veil__count';
    this.#count.textContent = '';

    card.append(title, this.#count);
    this.#root.append(card);
    host.append(this.#root);
  }

  /** Updates the progress line. Zero total means "still finding out". */
  update(settled: number, total: number): void {
    if (this.#dismissed) return;
    this.#count.textContent = total > 0 ? `${settled} / ${total}` : '';
  }

  /** Fades the veil out and removes it. Safe to call more than once. */
  dismiss(): void {
    if (this.#dismissed) return;
    this.#dismissed = true;
    this.#root.classList.add('is-leaving');
    // Removal waits for the fade so the reveal reads as a curtain rather
    // than a cut; matches the transition length in the stylesheet.
    setTimeout(() => this.#root.remove(), 400);
  }

  get dismissed(): boolean {
    return this.#dismissed;
  }
}
