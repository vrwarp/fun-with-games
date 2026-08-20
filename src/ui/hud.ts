import type { RenderPlayer, RenderState } from '../net/view.js';
import { TEAM_INFO, type GameModeInfo } from '../shared/modes.js';

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

export interface HudOptions {
  /** Mode metadata: title and goal line. Omit for the plain sandbox. */
  mode?: GameModeInfo;
  /** When provided (and this peer is host), shows the add/remove bot buttons. */
  onAddBot?: () => void;
  onRemoveBot?: () => void;
}

/**
 * The in-game overlay: scoreboard, phase banner, timers, team scores,
 * connection status, share link.
 *
 * Plain DOM on top of the canvas rather than Babylon GUI — it is lighter,
 * styleable with ordinary CSS, and reachable from Playwright by `data-testid`,
 * which is how the e2e tests assert that two browsers actually see each other.
 * Every element the tests depend on is marked; keep those attributes stable.
 *
 * Everything here is driven by `RenderState`, so it works identically on the
 * host and on clients — the HUD never asks the simulation anything directly.
 */
export class Hud {
  readonly root: HTMLElement;

  #scoreboard: HTMLElement;
  #status: HTMLElement;
  #roomCode: HTMLElement;
  #copyButton: HTMLButtonElement;
  #goal: HTMLElement;
  #vitals: HTMLElement;
  #botRow: HTMLElement;
  #teamStrip: HTMLElement;
  #timer: HTMLElement;
  #banner: HTMLElement;
  #bannerTitle: HTMLElement;
  #bannerSubtitle: HTMLElement;
  #copyResetTimer: ReturnType<typeof setTimeout> | null = null;
  #mode: GameModeInfo | undefined;

  constructor(parent: HTMLElement, options: HudOptions = {}) {
    this.#mode = options.mode;

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

    this.#goal = document.createElement('div');
    this.#goal.className = 'hud__goal';
    this.#goal.dataset['testid'] = 'mode-goal';
    if (this.#mode) {
      this.#goal.textContent = this.#mode.goal;
    } else {
      this.#goal.hidden = true;
    }

    this.#scoreboard = document.createElement('ol');
    this.#scoreboard.className = 'hud__scores';
    this.#scoreboard.dataset['testid'] = 'scoreboard';

    this.#vitals = document.createElement('div');
    this.#vitals.className = 'hud__vitals';
    this.#vitals.dataset['testid'] = 'vitals';
    this.#vitals.hidden = true;

    this.#botRow = document.createElement('div');
    this.#botRow.className = 'hud__bots';
    this.#botRow.hidden = true;
    if (options.onAddBot) {
      const add = this.#createBotButton('+ Bot', 'add-bot', options.onAddBot);
      this.#botRow.append(add);
    }
    if (options.onRemoveBot) {
      const remove = this.#createBotButton('−', 'remove-bot', options.onRemoveBot);
      this.#botRow.append(remove);
    }

    this.#status = document.createElement('div');
    this.#status.className = 'hud__status';
    this.#status.dataset['testid'] = 'net-status';

    panel.append(roomRow, this.#goal, this.#scoreboard, this.#vitals, this.#botRow, this.#status);

    // Top centre: team scores and the round timer.
    const top = document.createElement('div');
    top.className = 'hud__center-top';

    this.#teamStrip = document.createElement('div');
    this.#teamStrip.className = 'hud__teams';
    this.#teamStrip.dataset['testid'] = 'team-scores';
    this.#teamStrip.hidden = true;

    this.#timer = document.createElement('div');
    this.#timer.className = 'hud__timer';
    this.#timer.dataset['testid'] = 'round-timer';
    this.#timer.hidden = true;

    top.append(this.#teamStrip, this.#timer);

    // Centre: the phase banner (countdown numbers, winner screen).
    this.#banner = document.createElement('div');
    this.#banner.className = 'hud__banner';
    this.#banner.dataset['testid'] = 'phase-banner';
    this.#banner.hidden = true;
    this.#bannerTitle = document.createElement('div');
    this.#bannerTitle.className = 'hud__banner-title';
    this.#bannerSubtitle = document.createElement('div');
    this.#bannerSubtitle.className = 'hud__banner-subtitle';
    this.#banner.append(this.#bannerTitle, this.#bannerSubtitle);

    const help = document.createElement('div');
    help.className = 'hud__help';
    help.innerHTML =
      '<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move &nbsp;·&nbsp; ' +
      '<kbd>Shift</kbd> sprint &nbsp;·&nbsp; <kbd>Space</kbd> action &nbsp;·&nbsp; drag to orbit';

    this.root.append(panel, top, this.#banner, help);
    parent.append(this.root);
  }

  update(state: RenderState, status: HudStatus): void {
    this.#renderScores(state, status);
    this.#renderStatus(status);
    this.#renderTeams(state);
    this.#renderTimer(state);
    this.#renderBanner(state, status);
    this.#renderVitals(state, status);
    this.#botRow.hidden = !status.isHost || this.#botRow.childElementCount === 0;
  }

  dispose(): void {
    if (this.#copyResetTimer) clearTimeout(this.#copyResetTimer);
    this.root.remove();
  }

  // -------------------------------------------------------------- internals

  #createBotButton(label: string, testid: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'hud__bot-button';
    button.dataset['testid'] = testid;
    button.textContent = label;
    button.addEventListener('click', onClick);
    return button;
  }

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
      row.classList.toggle('is-out', player.effects.includes('ko'));

      const swatch = row.querySelector<HTMLElement>('.hud__swatch');
      const name = row.querySelector<HTMLElement>('.hud__name');
      const score = row.querySelector<HTMLElement>('.hud__score');
      if (swatch) {
        swatch.style.background = player.color;
        const teamColor = player.team >= 0 ? TEAM_INFO[player.team]?.color : undefined;
        swatch.style.boxShadow = teamColor ? `0 0 0 2px ${teamColor}` : '';
      }
      if (name) {
        name.textContent = this.#nameWithBadges(player, status);
      }
      if (score) score.textContent = String(player.score);
    });
  }

  #nameWithBadges(player: RenderPlayer, status: HudStatus): string {
    let text = player.name;
    if (player.isBot) text = `🤖 ${text}`;
    if (player.role === 1) text = `🔥 ${text}`;
    if (player.carrying === 'crown') text = `👑 ${text}`;
    if (player.carrying === 'flag') text = `⚑ ${text}`;
    if (player.effects.includes('frozen')) text = `❄ ${text}`;
    if (player.effects.includes('ko')) text = `💀 ${text}`;
    if (player.id === status.hostId) text = `${text} (host)`;
    return text;
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

  #renderTeams(state: RenderState): void {
    const teams = state.teamScores;
    if (teams.length < 2) {
      this.#teamStrip.hidden = true;
      return;
    }
    this.#teamStrip.hidden = false;

    if (this.#teamStrip.childElementCount !== teams.length) {
      this.#teamStrip.replaceChildren(
        ...teams.map((_, index) => {
          const chip = document.createElement('span');
          chip.className = 'hud__team-chip';
          chip.style.borderColor = TEAM_INFO[index]?.color ?? 'transparent';
          return chip;
        }),
      );
    }
    teams.forEach((score, index) => {
      const chip = this.#teamStrip.children[index];
      if (chip instanceof HTMLElement) {
        chip.textContent = `${TEAM_INFO[index]?.name ?? `Team ${index + 1}`} ${score}`;
      }
    });
  }

  #renderTimer(state: RenderState): void {
    const show = state.phase.id === 'playing' && state.phase.remainingSeconds > 0;
    this.#timer.hidden = !show;
    if (!show) return;

    const total = Math.ceil(state.phase.remainingSeconds);
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    this.#timer.textContent = `${minutes}:${String(seconds).padStart(2, '0')}`;
    this.#timer.classList.toggle('is-urgent', total <= 10);
  }

  #renderBanner(state: RenderState, status: HudStatus): void {
    const phase = state.phase;

    switch (phase.id) {
      case 'lobby': {
        this.#showBanner('Waiting for players…', this.#lobbyHint(state, status));
        break;
      }
      case 'countdown': {
        const count = Math.max(1, Math.ceil(phase.remainingSeconds));
        this.#showBanner(String(count), `Round ${phase.round}`);
        break;
      }
      case 'ended': {
        this.#showBanner(
          this.#winnerText(state),
          `Next round in ${Math.max(1, Math.ceil(phase.remainingSeconds))}…`,
        );
        break;
      }
      default:
        this.#banner.hidden = true;
    }
  }

  #lobbyHint(state: RenderState, status: HudStatus): string {
    const wanted = this.#mode?.suggestedPlayers ?? 2;
    const have = state.players.length;
    if (have >= wanted) return 'Starting soon…';
    return status.isHost
      ? 'Share the room link — or add a bot'
      : 'Share the room link to fill the arena';
  }

  #winnerText(state: RenderState): string {
    const phase = state.phase;
    if (phase.winnerTeam >= 0) {
      const team = TEAM_INFO[phase.winnerTeam]?.name ?? `Team ${phase.winnerTeam + 1}`;
      return `🏆 ${team} wins!`;
    }
    if (phase.winnerId !== '') {
      const name =
        phase.winnerName ||
        state.players.find((player) => player.id === phase.winnerId)?.name ||
        'Winner';
      return `🏆 ${name} wins!`;
    }
    return 'Draw!';
  }

  #showBanner(title: string, subtitle: string): void {
    this.#banner.hidden = false;
    if (this.#bannerTitle.textContent !== title) this.#bannerTitle.textContent = title;
    if (this.#bannerSubtitle.textContent !== subtitle) this.#bannerSubtitle.textContent = subtitle;
  }

  #renderVitals(state: RenderState, status: HudStatus): void {
    if (state.maxHp <= 0) {
      this.#vitals.hidden = true;
      return;
    }
    const self = state.players.find((player) => player.id === status.selfId);
    if (!self) {
      this.#vitals.hidden = true;
      return;
    }

    this.#vitals.hidden = false;
    const hearts =
      '♥'.repeat(Math.max(0, Math.min(self.hp, state.maxHp))) +
      '♡'.repeat(Math.max(0, state.maxHp - self.hp));
    const lives = self.lives > 0 ? `  ·  ${self.lives} ${self.lives === 1 ? 'life' : 'lives'}` : '';
    this.#vitals.textContent = `${hearts}${lives}`;
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
