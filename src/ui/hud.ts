import type { RenderState } from '../net/view.js';

export interface HudStatus {
  roomId: string;
  selfId: string;
  hostId: string;
  isHost: boolean;
  peerCount: number;
  tick: number;
  fps: number;
  pendingInputs: number;
}

/**
 * The in-game overlay: scoreboard, connection status, share link.
 *
 * Plain DOM on top of the canvas rather than Babylon GUI — it is lighter,
 * styleable with ordinary CSS, and reachable from Playwright by `data-testid`,
 * which is how the e2e tests assert that two browsers actually see each other.
 * Every element the tests depend on is marked; keep those attributes stable.
 */
export class Hud {
  readonly root: HTMLElement;

  #scoreboard: HTMLElement;
  #status: HTMLElement;
  #roomCode: HTMLElement;
  #copyButton: HTMLButtonElement;
  #copyResetTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.dataset['testid'] = 'hud';

    const panel = document.createElement('div');
    panel.className = 'hud__panel';

    const roomRow = document.createElement('div');
    roomRow.className = 'hud__room';

    this.#roomCode = document.createElement('span');
    this.#roomCode.className = 'hud__room-code';
    this.#roomCode.dataset['testid'] = 'room-code';

    this.#copyButton = document.createElement('button');
    this.#copyButton.type = 'button';
    this.#copyButton.className = 'hud__copy';
    this.#copyButton.textContent = 'Copy link';
    this.#copyButton.dataset['testid'] = 'copy-link';
    this.#copyButton.addEventListener('click', () => void this.#copyLink());

    roomRow.append(this.#roomCode, this.#copyButton);

    this.#scoreboard = document.createElement('ol');
    this.#scoreboard.className = 'hud__scores';
    this.#scoreboard.dataset['testid'] = 'scoreboard';

    this.#status = document.createElement('div');
    this.#status.className = 'hud__status';
    this.#status.dataset['testid'] = 'net-status';

    panel.append(roomRow, this.#scoreboard, this.#status);

    const help = document.createElement('div');
    help.className = 'hud__help';
    help.innerHTML =
      '<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move &nbsp;·&nbsp; ' +
      '<kbd>Shift</kbd> sprint &nbsp;·&nbsp; drag to orbit';

    this.root.append(panel, help);
    parent.append(this.root);
  }

  update(state: RenderState, status: HudStatus): void {
    this.#renderScores(state, status);
    this.#renderStatus(status);
  }

  dispose(): void {
    if (this.#copyResetTimer) clearTimeout(this.#copyResetTimer);
    this.root.remove();
  }

  // -------------------------------------------------------------- internals

  #renderScores(state: RenderState, status: HudStatus): void {
    const ranked = [...state.players].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

    // Rebuild only when the roster changes; otherwise patch in place so the
    // DOM does not churn 60 times a second.
    if (this.#scoreboard.childElementCount !== ranked.length) {
      this.#scoreboard.replaceChildren(...ranked.map(() => this.#createScoreRow()));
    }

    ranked.forEach((player, index) => {
      const row = this.#scoreboard.children[index];
      if (!(row instanceof HTMLElement)) return;

      row.dataset['playerId'] = player.id;
      row.classList.toggle('is-local', player.isLocal);

      const swatch = row.querySelector<HTMLElement>('.hud__swatch');
      const name = row.querySelector<HTMLElement>('.hud__name');
      const score = row.querySelector<HTMLElement>('.hud__score');
      if (swatch) swatch.style.background = player.color;
      if (name) {
        name.textContent = player.id === status.hostId ? `${player.name} (host)` : player.name;
      }
      if (score) score.textContent = String(player.score);
    });
  }

  #createScoreRow(): HTMLElement {
    const row = document.createElement('li');
    row.className = 'hud__score-row';
    row.dataset['testid'] = 'score-row';

    const swatch = document.createElement('span');
    swatch.className = 'hud__swatch';

    const name = document.createElement('span');
    name.className = 'hud__name';
    name.dataset['testid'] = 'score-name';

    const score = document.createElement('span');
    score.className = 'hud__score';
    score.dataset['testid'] = 'score-value';

    row.append(swatch, name, score);
    return row;
  }

  #renderStatus(status: HudStatus): void {
    const role = status.isHost ? 'host' : 'client';
    this.#roomCode.textContent = status.roomId;
    this.#status.dataset['role'] = role;
    this.#status.dataset['peers'] = String(status.peerCount);
    this.#status.textContent =
      `${role} · ${status.peerCount} peer${status.peerCount === 1 ? '' : 's'} · ` +
      `tick ${status.tick} · ${Math.round(status.fps)} fps`;
  }

  async #copyLink(): Promise<void> {
    const label = this.#copyButton;
    try {
      await navigator.clipboard.writeText(window.location.href);
      label.textContent = 'Copied!';
    } catch {
      // Clipboard access is denied in plenty of contexts (insecure origin,
      // headless browsers). Tell the user rather than failing silently.
      label.textContent = 'Copy failed';
    }
    if (this.#copyResetTimer) clearTimeout(this.#copyResetTimer);
    this.#copyResetTimer = setTimeout(() => {
      label.textContent = 'Copy link';
    }, 1500);
  }
}
