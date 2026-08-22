import './ui/styles.css';

import { createLogger, setLogLevel, type LogLevel } from './shared/logger.js';
import { DEFAULT_MODE_ID, isGameModeId, modeInfo, type GameModeId } from './shared/modes.js';
import { hashStringToSeed } from './sim/rng.js';
import { modeConfig } from './sim/presets.js';
import { NetSession } from './net/session.js';
import type { Transport } from './net/transport.js';
import { createBroadcastTransport } from './net/transports/broadcast.js';
import { createTrysteroTransport } from './net/transports/trystero.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { Renderer } from './render/renderer.js';
import { isViewMode, type ViewMode } from './render/views.js';
import { KeyboardInput, mergeIntents } from './render/input.js';
import { TouchInput } from './render/touch.js';
import { TouchButtons } from './render/buttons.js';
import { GameAudio } from './render/audio.js';
import { keepScreenAwake, tapFeedback } from './render/device.js';
import { loadManifest, loadModel } from './render/assets.js';
import type { AssetManifest } from './shared/manifest.js';
import { Announcer } from './ui/announcer.js';
import { Credits } from './ui/credits.js';
import { Hud } from './ui/hud.js';
import { Lobby, normalizeRoomId, randomRoomId } from './ui/lobby.js';

const log = createLogger('main');

/**
 * Namespaces this game on the shared public relay network. Change it if you
 * fork the project, or your rooms will collide with everyone else's.
 */
const APP_ID = 'fun-with-games-starter';

interface LaunchOptions {
  roomId: string;
  modeId: GameModeId;
  name: string;
  color: string;
  transportKind: 'trystero' | 'broadcast';
  botCount: number;
  /**
   * Camera framing and sprite style, when the URL overrides the mode's own.
   *
   * Both are presentation-only, so they are deliberately NOT part of the
   * transport room name: two people can play the same match in different
   * projections without desyncing anything.
   */
  view: ViewMode | undefined;
  sprites: boolean | undefined;
}

void bootstrap();

async function bootstrap(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  setLogLevel(readLogLevel(params));

  const app = document.querySelector<HTMLElement>('#app');
  if (!app) throw new Error('missing #app element');

  const roomId = normalizeRoomId(params.get('room') ?? randomRoomId());
  const rawMode = params.get('mode');
  const modeId: GameModeId = isGameModeId(rawMode) ? rawMode : DEFAULT_MODE_ID;
  const transportKind = params.get('net') === 'broadcast' ? 'broadcast' : 'trystero';
  const botCount = clampBotCount(params.get('bots'));
  const rawView = params.get('view');
  const view = isViewMode(rawView) ? rawView : undefined;
  const spritesParam = params.get('sprites');
  const sprites = spritesParam === null ? undefined : spritesParam === '1';

  // `?autojoin=1` skips the lobby. Used by the e2e tests, and handy when you
  // want a shareable link that drops straight into a room.
  if (params.get('autojoin') === '1') {
    await launch(app, {
      roomId,
      modeId,
      name: params.get('name') ?? 'player',
      color: params.get('color') ?? '#4cc9f0',
      transportKind,
      botCount,
      view,
      sprites,
    });
    return;
  }

  const lobby = new Lobby(app, { roomId, modeId });
  const choice = await lobby.waitForJoin();
  lobby.dispose();

  await launch(app, { ...choice, transportKind, botCount, view, sprites });
}

async function launch(app: HTMLElement, options: LaunchOptions): Promise<void> {
  syncUrl(options);

  const canvas = document.createElement('canvas');
  canvas.className = 'viewport';
  canvas.dataset['testid'] = 'viewport';
  app.append(canvas);

  let renderer: Renderer;
  const mode = modeInfo(options.modeId);
  const config = modeConfig(options.modeId);

  // The world seed comes from the room id, so every peer builds an identical
  // arena without anyone having to send the geometry.
  const seed = hashStringToSeed(options.roomId);

  const transport = createTransport(options);
  const session = new NetSession({
    transport,
    seed,
    profile: { name: options.name, color: options.color },
    config,
  });

  try {
    renderer = new Renderer({
      canvas,
      config,
      obstacles: session.world.obstacles,
      // URL wins over the mode's default, so any game can be demoed in any
      // projection without touching its rules.
      view: options.view ?? mode.view ?? 'follow',
      sprites: options.sprites ?? mode.sprites ?? false,
    });
  } catch (error) {
    log.error('failed to start the 3D engine', error);
    showFatalError(app, 'This browser could not start WebGL, so the game cannot render.');
    await session.dispose();
    return;
  }

  renderer.setLocalPlayer(session.selfId);

  const hud = new Hud(app, {
    mode,
    // The UI layer may not read `SimConfig`, so the composition root hands it
    // the one fact it needs from there rather than duplicating the answer in
    // the mode metadata.
    drives: config.vehicle.enabled,
    onAddBot: () => void session.addBot(),
    onRemoveBot: () => void session.removeBot(),
  });

  // Procedural blips — no audio files, and `?mute=1` for quiet demos. The
  // announcer already knows what just happened, so it drives the sounds.
  const audio = new GameAudio({
    muted: new URLSearchParams(window.location.search).get('mute') === '1',
  });
  audio.attach();
  const announcer = new Announcer(app, session.selfId, {
    onCue: (cue) => {
      switch (cue) {
        case 'go':
          audio.play('go');
          break;
        case 'tagged':
        case 'frozen':
          audio.play('tagged');
          tapFeedback(30);
          break;
        case 'ko':
          audio.play('ko');
          tapFeedback(60);
          break;
        case 'respawn':
          audio.play('respawn');
          break;
        case 'goal':
          audio.play('goal');
          break;
        case 'lap':
          audio.play('lap');
          break;
        case 'fastlap':
          audio.play('score');
          tapFeedback(30);
          break;
        case 'drs':
          audio.play('powerup');
          break;
        case 'item':
          audio.play('crown');
          break;
        case 'powerup':
          audio.play('powerup');
          break;
        case 'pickup':
          audio.play('score');
          tapFeedback();
          break;
        case 'untagged':
          break;
      }
    },
  });
  // Created once the manifest resolves, so it can list real licences.
  let credits: Credits | null = null;
  const input = new KeyboardInput(window);
  input.attach();

  // Mobile is a supported target, so the game ships with an on-screen stick.
  // It reveals itself on touch devices and stays out of the way otherwise.
  const touch = new TouchInput(app);
  touch.attach();

  // Action buttons appear only in modes that use them — a fire button with
  // nothing to fire is just thumb clutter.
  const buttons = new TouchButtons(app, {
    primary: mode.usesPrimaryAction,
    secondary: mode.usesSecondaryAction ?? false,
    // Conditional spread rather than `label: mode.primaryLabel`:
    // exactOptionalPropertyTypes rejects an explicit undefined here, and the
    // absence is what selects the button's own default.
    ...(mode.primaryLabel !== undefined ? { primaryLabel: mode.primaryLabel } : {}),
    ...(mode.secondaryLabel !== undefined ? { secondaryLabel: mode.secondaryLabel } : {}),
  });
  buttons.attach();

  // `?bots=N` pre-fills the arena. Only the host actually spawns them
  // (`addBot` refuses on clients), so a shared link with bots "just works"
  // for the first person in and is harmless for everyone after.
  for (let i = 0; i < options.botCount; i++) session.addBot();

  // The manifest is read once and shared: the renderer needs it to upgrade the
  // player model, and the credits panel needs it to show licences. Art is
  // optional, so this runs in the background and upgrades things if it lands.
  void loadManifest(import.meta.env.BASE_URL).then((manifest) => {
    void applyOptionalAssets(renderer, manifest);
    credits = new Credits(app, manifest);
  });

  // A phone dims and locks after seconds of not being touched — including
  // while a player stands still watching the scoreboard.
  const releaseWakeLock = keepScreenAwake();

  const onResize = (): void => renderer.resize();
  window.addEventListener('resize', onResize);
  // iOS fires `orientationchange` before the viewport has settled, so resize
  // once more on the next frame or the canvas keeps the old aspect ratio.
  const onOrientationChange = (): void => {
    requestAnimationFrame(() => renderer.resize());
  };
  window.addEventListener('orientationchange', onOrientationChange);

  let lastFrameMs = performance.now();
  let lastCountdownSecond = -1;
  let lastPhaseId = '';

  renderer.engine.runRenderLoop(() => {
    const now = performance.now();
    const deltaSeconds = Math.min((now - lastFrameMs) / 1000, 0.25);
    lastFrameMs = now;

    const yaw = renderer.cameraYaw;
    const intent = mergeIntents(touch.read(yaw), buttons.read(), input.read(yaw));
    session.setIntent(intent.moveX, intent.moveZ, intent.sprint, intent.buttons);
    session.update(now);

    const state = session.sample(now);
    renderer.renderFrame(state, deltaSeconds);
    // The announcer diffs rendered states, so feedback (toasts, sounds,
    // haptics via the cue callback above) is identical on host and clients.
    announcer.update(state);

    // Tick during the last three countdown seconds; fanfare on a round end.
    if (state.phase.id === 'countdown') {
      const second = Math.ceil(state.phase.remainingSeconds);
      if (second !== lastCountdownSecond && second <= 3 && second > 0) {
        audio.play('countdown');
      }
      lastCountdownSecond = second;
    } else {
      lastCountdownSecond = -1;
    }
    if (state.phase.id === 'ended' && lastPhaseId === 'playing') audio.play('win');
    lastPhaseId = state.phase.id;

    hud.update(state, {
      roomId: options.roomId,
      selfId: session.selfId,
      hostId: session.hostId,
      isHost: session.isHost,
      peerCount: session.peerIds.length,
      tick: state.tick,
      fps: renderer.engine.getFps(),
      pendingInputs: session.pendingInputCount,
    });
  });

  const teardown = (): void => {
    window.removeEventListener('resize', onResize);
    window.removeEventListener('orientationchange', onOrientationChange);
    releaseWakeLock();
    input.detach();
    touch.dispose();
    buttons.dispose();
    audio.dispose();
    announcer.dispose();
    credits?.dispose();
    hud.dispose();
    renderer.dispose();
    void session.dispose();
  };
  window.addEventListener('pagehide', teardown, { once: true });

  exposeTestHandle(session, renderer, options.modeId, options.view ?? mode.view ?? 'follow');
}

function createTransport(options: LaunchOptions): Transport {
  // The mode is part of the room name, so peers running different rules can
  // never meet: every peer in a room is guaranteed the same SimConfig, which
  // is a precondition for prediction and determinism.
  const transportRoom = `${options.roomId}--${options.modeId}`;
  if (options.transportKind === 'broadcast') {
    log.info('using BroadcastChannel transport (same-browser only)');
    return createBroadcastTransport({ roomId: transportRoom });
  }
  log.info('using Trystero WebRTC transport');
  return createTrysteroTransport({ appId: APP_ID, roomId: transportRoom });
}

/**
 * Swaps in a loaded player model when the manifest declares one.
 *
 * Failure here is expected and harmless — the repo ships without binary art.
 * See `docs/ASSETS.md` for how to populate the manifest.
 */
async function applyOptionalAssets(renderer: Renderer, manifest: AssetManifest): Promise<void> {
  const baseUrl = import.meta.env.BASE_URL;
  const playerEntry = manifest.models.find((model) => model.id === 'player');
  if (!playerEntry) return;

  const container = await loadModel(renderer.scene, playerEntry, baseUrl);
  if (!container) return;

  // Only a full `Mesh` can act as a clone prototype; glTF files routinely also
  // contain empty transform nodes and skeleton roots.
  const source = container.meshes.find(
    (mesh): mesh is Mesh => mesh instanceof Mesh && mesh.getTotalVertices() > 0,
  );
  if (!source) {
    log.warn('player model contained no renderable geometry');
    return;
  }

  const prototype = source.clone('player:proto', null);
  if (!prototype) return;
  if (playerEntry.scale !== undefined) {
    prototype.scaling.scaleInPlace(playerEntry.scale);
  }
  renderer.entities.setPlayerPrototype(prototype);
}

/** Keeps the address bar shareable: the URL always names the current room. */
function syncUrl(options: LaunchOptions): void {
  const url = new URL(window.location.href);
  url.searchParams.set('room', options.roomId);
  if (options.modeId !== DEFAULT_MODE_ID) url.searchParams.set('mode', options.modeId);
  else url.searchParams.delete('mode');
  if (options.view) url.searchParams.set('view', options.view);
  if (options.sprites !== undefined) url.searchParams.set('sprites', options.sprites ? '1' : '0');
  if (options.transportKind === 'broadcast') url.searchParams.set('net', 'broadcast');
  window.history.replaceState(null, '', url);
}

function clampBotCount(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(8, parsed));
}

function readLogLevel(params: URLSearchParams): LogLevel {
  const level = params.get('log');
  const allowed: LogLevel[] = ['debug', 'info', 'warn', 'error', 'silent'];
  return allowed.includes(level as LogLevel) ? (level as LogLevel) : 'info';
}

function showFatalError(app: HTMLElement, message: string): void {
  const banner = document.createElement('div');
  banner.className = 'fatal';
  banner.dataset['testid'] = 'fatal-error';
  banner.textContent = message;
  app.append(banner);
}

/**
 * A small read-only window handle for end-to-end tests.
 *
 * Without it a test can only assert on pixels and DOM text, which makes it
 * hard to tell "the peers connected" from "the peers connected and the HUD
 * happened to update". Read-only on purpose: tests observe, they do not drive
 * the simulation from outside.
 */
function exposeTestHandle(
  session: NetSession,
  renderer: Renderer,
  modeId: GameModeId,
  view: ViewMode,
): void {
  Object.defineProperty(window, '__FWG__', {
    configurable: true,
    value: {
      get selfId() {
        return session.selfId;
      },
      get hostId() {
        return session.hostId;
      },
      get isHost() {
        return session.isHost;
      },
      get peerCount() {
        return session.peerIds.length;
      },
      get tick() {
        return session.world.tick;
      },
      get mode() {
        return modeId;
      },
      get view() {
        return view;
      },
      /** Orthographic in the 2D and 2.5D views, perspective in 3D. */
      get orthographic() {
        return renderer.camera.mode === 1;
      },
      get phase() {
        return session.world.phase.id;
      },
      get botCount() {
        return session.botCount;
      },
      get playerCount() {
        return session.sample(performance.now()).players.length;
      },
      /** Positions as currently rendered, so tests can assert on movement. */
      get players() {
        return session.sample(performance.now()).players.map((player) => ({
          id: player.id,
          name: player.name,
          x: player.x,
          z: player.z,
          y: player.y,
          score: player.score,
        }));
      },
      get fps() {
        return renderer.engine.getFps();
      },
      /** Camera orbit angle, so tests can assert auto-follow actually swings. */
      get cameraAlpha() {
        return renderer.camera.alpha;
      },
      get cameraRadius() {
        return renderer.camera.radius;
      },
      get cameraBeta() {
        return renderer.camera.beta;
      },
    },
  });
}
