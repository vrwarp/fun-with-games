import { VIEW_IDS, VIEW_LABELS, viewsFor, type ModeView } from '../shared/modes.js';

export interface SettingsValues {
  view: ModeView;
  sprites: boolean;
  muted: boolean;
}

export interface SettingsOptions {
  /** Current values to open with. */
  readonly initial: SettingsValues;
  /**
   * The view this mode is designed around, which decides what the camera
   * picker offers alongside the supported pair.
   */
  readonly defaultView: ModeView;
  /** Called with the complete set whenever any one of them changes. */
  readonly onChange: (values: SettingsValues) => void;
  /** Host-only bot controls. Omit both to leave the section out. */
  readonly onAddBot?: () => void;
  readonly onRemoveBot?: () => void;
}

/**
 * The in-game settings panel.
 *
 * Everything here used to be a query parameter, which meant that changing your
 * camera involved editing a URL — a thing nobody does mid-race and phone
 * players effectively cannot do at all. Same modal pattern as `Credits`: a
 * thumb-sized button, a native `<dialog>` so focus and the Escape key behave,
 * and a keydown guard so the movement keys do not leak into the game while a
 * player is reading.
 *
 * Only presentation lives in here. Anything that changes the *rules* has to be
 * agreed with the other peers, so it belongs to the room and stays in the
 * lobby — a settings menu that could quietly desync a match would be a trap.
 */
export class Settings {
  readonly button: HTMLButtonElement;
  readonly dialog: HTMLDialogElement;

  #values: SettingsValues;
  readonly #onChange: (values: SettingsValues) => void;
  #botCount: HTMLElement | null = null;

  #onKeyGuard = (event: KeyboardEvent): void => {
    event.stopPropagation();
  };

  constructor(parent: HTMLElement, options: SettingsOptions) {
    this.#values = { ...options.initial };
    this.#onChange = options.onChange;

    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'settings__open';
    this.button.dataset['testid'] = 'settings-button';
    this.button.setAttribute('aria-label', 'Settings');
    this.button.textContent = '⚙';

    this.dialog = document.createElement('dialog');
    this.dialog.className = 'settings';
    this.dialog.dataset['testid'] = 'settings-dialog';
    this.dialog.append(this.#buildContent(options));

    this.button.addEventListener('click', () => this.dialog.showModal());
    this.dialog.addEventListener('keydown', this.#onKeyGuard);
    // Clicking the backdrop lands on the dialog element itself.
    this.dialog.addEventListener('click', (event) => {
      if (event.target === this.dialog) this.dialog.close();
    });

    parent.append(this.button, this.dialog);
  }

  /** Shows the live bot count, and whether the player may change it. */
  setBotCount(count: number, isHost: boolean): void {
    if (!this.#botCount) return;
    this.#botCount.textContent = String(count);
    this.#botCount.dataset['host'] = String(isHost);
  }

  dispose(): void {
    this.dialog.removeEventListener('keydown', this.#onKeyGuard);
    this.button.remove();
    this.dialog.remove();
  }

  // -------------------------------------------------------------- internals

  #buildContent(options: SettingsOptions): HTMLElement {
    const body = document.createElement('div');
    body.className = 'settings__body';

    const header = document.createElement('div');
    header.className = 'settings__header';
    const title = document.createElement('h2');
    title.className = 'settings__title';
    title.textContent = 'Settings';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'settings__close';
    close.dataset['testid'] = 'settings-close';
    close.textContent = 'Done';
    close.addEventListener('click', () => this.dialog.close());
    header.append(title, close);

    const camera = document.createElement('select');
    camera.className = 'settings__select';
    camera.dataset['testid'] = 'settings-view';
    for (const id of viewsFor(options.defaultView, this.#values.view)) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = VIEW_LABELS[id];
      camera.append(option);
    }
    camera.value = this.#values.view;
    camera.addEventListener('change', () => {
      const chosen = VIEW_IDS.find((id) => id === camera.value);
      if (chosen) this.#emit({ view: chosen });
    });

    body.append(
      header,
      this.#row(
        'Camera',
        'How the game is framed. Yours alone — it never reaches the room.',
        camera,
      ),
      this.#row(
        'Pixel art',
        'Draw players as sprites instead of 3D bodies.',
        this.#toggle('settings-sprites', this.#values.sprites, (sprites) =>
          this.#emit({ sprites }),
        ),
      ),
      this.#row(
        'Sound',
        'Procedural blips for goals, laps and knockouts.',
        this.#toggle('settings-sound', !this.#values.muted, (on) => this.#emit({ muted: !on })),
      ),
    );

    const bots = this.#buildBots(options);
    if (bots) body.append(bots);

    return body;
  }

  #buildBots(options: SettingsOptions): HTMLElement | null {
    if (!options.onAddBot && !options.onRemoveBot) return null;

    const controls = document.createElement('div');
    controls.className = 'settings__bots';

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'settings__bot-button';
    remove.dataset['testid'] = 'settings-remove-bot';
    remove.textContent = '−';
    remove.setAttribute('aria-label', 'Remove a bot');
    if (options.onRemoveBot) remove.addEventListener('click', options.onRemoveBot);

    this.#botCount = document.createElement('span');
    this.#botCount.className = 'settings__bot-count';
    this.#botCount.dataset['testid'] = 'settings-bot-count';
    this.#botCount.textContent = '0';

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'settings__bot-button';
    add.dataset['testid'] = 'settings-add-bot';
    add.textContent = '+';
    add.setAttribute('aria-label', 'Add a bot');
    if (options.onAddBot) add.addEventListener('click', options.onAddBot);

    controls.append(remove, this.#botCount, add);
    // Bots are simulation, so only the host may add them — but everyone can
    // see how many are in the room, which is the useful half.
    return this.#row('Bots', 'Fill the room with opponents. Host only.', controls);
  }

  #row(label: string, hint: string, control: HTMLElement): HTMLElement {
    const row = document.createElement('div');
    row.className = 'settings__row';

    const text = document.createElement('div');
    text.className = 'settings__text';
    const name = document.createElement('span');
    name.className = 'settings__label';
    name.textContent = label;
    const note = document.createElement('span');
    note.className = 'settings__hint';
    note.textContent = hint;
    text.append(name, note);

    row.append(text, control);
    return row;
  }

  /** A switch, not a checkbox: a 44px target rather than a 13px one. */
  #toggle(testid: string, on: boolean, onToggle: (on: boolean) => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'settings__toggle';
    button.dataset['testid'] = testid;
    button.setAttribute('role', 'switch');

    const paint = (state: boolean): void => {
      button.setAttribute('aria-checked', String(state));
      button.dataset['on'] = String(state);
      button.textContent = state ? 'On' : 'Off';
    };
    paint(on);

    button.addEventListener('click', () => {
      const next = button.dataset['on'] !== 'true';
      paint(next);
      onToggle(next);
    });
    return button;
  }

  #emit(patch: Partial<SettingsValues>): void {
    this.#values = { ...this.#values, ...patch };
    this.#onChange({ ...this.#values });
  }
}
