import {
  DEFAULT_MODE_ID,
  GAME_MODES,
  VIEW_IDS,
  VIEW_LABELS,
  viewsFor,
  isGameModeId,
  type GameModeId,
  type ModeView,
} from '../shared/modes.js';

/** Player-chosen settings collected before joining a room. */
export interface LobbyResult {
  name: string;
  color: string;
  roomId: string;
  modeId: GameModeId;
  /**
   * Camera framing, or undefined to take whatever the mode prefers.
   *
   * Presentation only, so it never reaches the room name — but it does need
   * to be reachable without editing a URL, which on the primary target means
   * a phone keyboard.
   */
  view: ModeView | undefined;
}

const PALETTE = [
  '#4cc9f0',
  '#f72585',
  '#b5e48c',
  '#ffb703',
  '#9d4edd',
  '#06d6a0',
  '#ff7b00',
  '#ef476f',
];

const NAME_STORAGE_KEY = 'fwg:name';
const COLOR_STORAGE_KEY = 'fwg:color';

/**
 * The pre-game screen: pick a name and colour, then join a room.
 *
 * Kept as its own DOM overlay rather than folded into `main.ts` so the join
 * flow can be reworked (matchmaking, a room browser, a character picker)
 * without touching engine startup.
 */
export class Lobby {
  readonly root: HTMLElement;

  #resolve: ((result: LobbyResult) => void) | null = null;
  #nameInput: HTMLInputElement;
  #roomInput: HTMLInputElement;
  #colorInput: HTMLInputElement;
  #modeSelect: HTMLSelectElement;
  #modeTagline: HTMLElement;
  #viewSelect: HTMLSelectElement;

  constructor(
    parent: HTMLElement,
    defaults: { roomId: string; modeId?: GameModeId; view?: ModeView },
  ) {
    this.root = document.createElement('div');
    this.root.className = 'lobby';
    this.root.dataset['testid'] = 'lobby';

    const card = document.createElement('form');
    card.className = 'lobby__card';
    card.addEventListener('submit', (event) => {
      event.preventDefault();
      this.#submit();
    });

    const title = document.createElement('h1');
    title.className = 'lobby__title';
    title.textContent = 'Fun With Games';

    const subtitle = document.createElement('p');
    subtitle.className = 'lobby__subtitle';
    subtitle.textContent =
      'A peer-to-peer arena. Pick a game, share the room link, play from any phone.';

    this.#nameInput = createInput({
      label: 'Display name',
      testid: 'name-input',
      value: readStored(NAME_STORAGE_KEY) ?? randomName(),
      maxLength: 24,
      required: true,
    });

    this.#roomInput = createInput({
      label: 'Room code',
      testid: 'room-input',
      value: defaults.roomId,
      maxLength: 32,
      required: true,
    });

    const modeField = document.createElement('label');
    modeField.className = 'lobby__field';
    const modeLabel = document.createElement('span');
    modeLabel.className = 'lobby__label';
    modeLabel.textContent = 'Game mode';
    this.#modeSelect = document.createElement('select');
    this.#modeSelect.className = 'lobby__input lobby__select';
    this.#modeSelect.dataset['testid'] = 'mode-select';
    for (const mode of GAME_MODES) {
      const option = document.createElement('option');
      option.value = mode.id;
      option.textContent = mode.title;
      this.#modeSelect.append(option);
    }
    this.#modeSelect.value = defaults.modeId ?? DEFAULT_MODE_ID;
    this.#modeTagline = document.createElement('span');
    this.#modeTagline.className = 'lobby__mode-tagline';
    this.#modeTagline.dataset['testid'] = 'mode-tagline';
    this.#modeSelect.addEventListener('change', () => {
      this.#refreshTagline();
      // Modes disagree about which cameras suit them, so the list has to
      // follow the mode rather than being built once and left.
      this.#refreshViews();
    });
    modeField.append(modeLabel, this.#modeSelect, this.#modeTagline);

    const viewField = document.createElement('label');
    viewField.className = 'lobby__field';
    const viewLabel = document.createElement('span');
    viewLabel.className = 'lobby__label';
    viewLabel.textContent = 'Camera';
    this.#viewSelect = document.createElement('select');
    this.#viewSelect.className = 'lobby__input lobby__select';
    this.#viewSelect.dataset['testid'] = 'view-select';
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = 'Mode default';
    this.#viewSelect.append(auto);
    this.#viewSelect.value = defaults.view ?? '';
    viewField.append(viewLabel, this.#viewSelect);
    this.#refreshTagline();
    this.#refreshViews();

    this.#colorInput = document.createElement('input');
    this.#colorInput.type = 'hidden';
    this.#colorInput.value = readStored(COLOR_STORAGE_KEY) ?? pickColor();

    const swatches = this.#createSwatches();

    const join = document.createElement('button');
    join.type = 'submit';
    join.className = 'lobby__join';
    join.textContent = 'Join room';
    join.dataset['testid'] = 'join-button';

    const hint = document.createElement('p');
    hint.className = 'lobby__hint';
    hint.textContent =
      'No account, no server. Peers find each other over a decentralized relay, then talk directly. ' +
      'Everyone in a room plays the mode its link names.';

    card.append(
      title,
      subtitle,
      this.#nameInput.parentElement ?? this.#nameInput,
      this.#roomInput.parentElement ?? this.#roomInput,
      modeField,
      viewField,
      swatches,
      this.#colorInput,
      join,
      hint,
    );

    this.root.append(card);
    parent.append(this.root);
  }

  /** Resolves once the player submits the form. */
  waitForJoin(): Promise<LobbyResult> {
    return new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  hide(): void {
    this.root.classList.add('is-hidden');
  }

  dispose(): void {
    this.root.remove();
  }

  // -------------------------------------------------------------- internals

  #createSwatches(): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'lobby__swatches';
    wrapper.dataset['testid'] = 'color-swatches';

    for (const color of PALETTE) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'lobby__swatch';
      button.style.background = color;
      button.dataset['color'] = color;
      button.setAttribute('aria-label', `Choose colour ${color}`);
      button.classList.toggle('is-selected', color === this.#colorInput.value);

      button.addEventListener('click', () => {
        this.#colorInput.value = color;
        for (const sibling of wrapper.children) {
          sibling.classList.toggle('is-selected', sibling === button);
        }
      });

      wrapper.append(button);
    }

    return wrapper;
  }

  #refreshTagline(): void {
    const mode = GAME_MODES.find((entry) => entry.id === this.#modeSelect.value);
    this.#modeTagline.textContent = mode?.tagline ?? '';
  }

  /**
   * Rebuilds the camera list for the selected mode.
   *
   * "Mode default" always leads, because most players want the framing the
   * mode was designed for and should not have to know what that is.
   */
  #refreshViews(): void {
    const mode = GAME_MODES.find((entry) => entry.id === this.#modeSelect.value);
    const chosen = VIEW_IDS.find((id) => id === this.#viewSelect.value);
    this.#viewSelect.replaceChildren();

    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = 'Mode default';
    this.#viewSelect.append(auto);

    for (const id of viewsFor(mode?.view ?? 'follow', chosen)) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = VIEW_LABELS[id];
      this.#viewSelect.append(option);
    }
    this.#viewSelect.value = chosen ?? '';
  }

  #submit(): void {
    const name = this.#nameInput.value.trim() || randomName();
    const roomId = normalizeRoomId(this.#roomInput.value);
    const color = this.#colorInput.value;
    const modeId = isGameModeId(this.#modeSelect.value) ? this.#modeSelect.value : DEFAULT_MODE_ID;
    const chosenView = VIEW_IDS.find((id) => id === this.#viewSelect.value);

    writeStored(NAME_STORAGE_KEY, name);
    writeStored(COLOR_STORAGE_KEY, color);

    // Conditional spread: `exactOptionalPropertyTypes` will not take an
    // explicit undefined for an optional field.
    this.#resolve?.({ name, color, roomId, modeId, view: chosenView });
    this.#resolve = null;
  }
}

function createInput(options: {
  label: string;
  testid: string;
  value: string;
  maxLength: number;
  required: boolean;
}): HTMLInputElement {
  const field = document.createElement('label');
  field.className = 'lobby__field';

  const caption = document.createElement('span');
  caption.className = 'lobby__label';
  caption.textContent = options.label;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'lobby__input';
  input.value = options.value;
  input.maxLength = options.maxLength;
  input.required = options.required;
  input.autocomplete = 'off';
  input.dataset['testid'] = options.testid;

  field.append(caption, input);
  return input;
}

/**
 * Room ids travel through URLs and a shared relay network, so keep them to a
 * conservative character set rather than trusting whatever was typed.
 */
export function normalizeRoomId(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
  return cleaned.length > 0 ? cleaned : randomRoomId();
}

const ROOM_WORDS = [
  'amber',
  'basalt',
  'cobalt',
  'dune',
  'ember',
  'flint',
  'glacier',
  'harbor',
  'indigo',
  'juniper',
  'kelp',
  'lumen',
];

/**
 * Room ids only need to be unlikely to collide between strangers, so a short
 * memorable pair beats a UUID nobody can read out loud.
 */
export function randomRoomId(): string {
  const word = ROOM_WORDS[Math.floor(Math.random() * ROOM_WORDS.length)] ?? 'arena';
  const digits = Math.floor(Math.random() * 9000 + 1000);
  return `${word}-${digits}`;
}

function randomName(): string {
  return `player-${Math.floor(Math.random() * 900 + 100)}`;
}

function pickColor(): string {
  return PALETTE[Math.floor(Math.random() * PALETTE.length)] ?? '#4cc9f0';
}

function readStored(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    // Storage is unavailable in private mode and some embedded contexts.
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Non-fatal: the player just has to retype their name next time.
  }
}
