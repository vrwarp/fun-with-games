import './ui/styles.css';

import { createLogger, setLogLevel, type LogLevel } from './shared/logger.js';
import { DEFAULT_MODE_ID, isGameModeId, modeInfo, type GameModeId } from './shared/modes.js';
import { hashStringToSeed } from './sim/rng.js';
import { modeConfig } from './sim/presets.js';
import { usesVehicleAxes } from './sim/controls.js';
import type { QualityTier } from './render/quality.js';
import { NetSession } from './net/session.js';
import type { Transport } from './net/transport.js';
import { createBroadcastTransport } from './net/transports/broadcast.js';
import { createTrysteroTransport } from './net/transports/trystero.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { Renderer } from './render/renderer.js';
import { isViewMode, viewSpec, type ViewMode } from './render/views.js';
import { IDLE_INTENT, KeyboardInput, mergeIntents } from './render/input.js';
import { TouchInput } from './render/touch.js';
import { TouchButtons } from './render/buttons.js';
import { TouchDriving } from './render/driving.js';
import { DriveHaptics } from './render/haptics.js';
import { GameAudio } from './render/audio.js';
import { keepScreenAwake, tapFeedback } from './render/device.js';
import { loadManifest, loadModel } from './render/assets.js';
import type { AssetManifest } from './shared/manifest.js';
import { Announcer } from './ui/announcer.js';
import { Credits } from './ui/credits.js';
import { Settings } from './ui/settings.js';
import { readPreferences, writePreferences } from './ui/preferences.js';
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
  muted: boolean;
  /** Whether the pedals drive the phone's motor. Never in the URL — see above. */
  haptics: boolean;
  /** A tier the player picked before. Absent means "ask the device". */
  quality?: QualityTier;
  /**
   * `?dress=1`: build the trackside dressing even on a software rasteriser.
   * A diagnostics hook in the `?log=` family, not a player option — the
   * only machines that skip the dressing are ones that cannot afford it,
   * and the only reason to override that is to screenshot or test the full
   * scene on a machine without a GPU.
   */
  forceDressing?: boolean;
}

/**
 * The two pedals, recovered from a keyboard's single signed axis.
 *
 * A key has no travel, so this is the binary case: fully on or fully off.
 * Worth doing anyway rather than skipping haptics for keyboard players — a
 * phone with a Bluetooth keyboard is still a phone in somebody's hand.
 */
function keyboardPedals(moveZ: number): { throttle: number; brake: number } {
  return moveZ < 0 ? { throttle: 0, brake: -moveZ } : { throttle: moveZ, brake: 0 };
}

/** True when the device has asked for less movement than the default. */
function prefersReducedMotion(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
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
  // Presentation resolves URL first, then what this device remembers, then
  // the mode's own default. A link someone was sent describes the game they
  // were invited to; their settings fill in whatever the link did not say.
  const stored = readPreferences();
  const rawView = params.get('view');
  const view = isViewMode(rawView) ? rawView : stored.view;
  const spritesParam = params.get('sprites');
  const sprites = spritesParam === null ? stored.sprites : spritesParam === '1';
  const muteParam = params.get('mute');
  const muted = muteParam === null ? (stored.muted ?? false) : muteParam === '1';
  // Deliberately not a URL parameter. A link describes the game someone was
  // invited to; whether their phone buzzes in their hand is nobody else's
  // business, so this is stored-or-default and lives only in Settings.
  //
  // The default defers to the device. Somebody who has asked their phone for
  // less motion has not asked for a motor running in their palm, and a game
  // that ignores that on first launch has already got it wrong once.
  const haptics = stored.haptics ?? !prefersReducedMotion();
  // Deliberately not a URL parameter either. What a device can render is a
  // fact about that device, not about the match somebody was invited to.
  const quality = stored.quality;
  // Diagnostics only — see `LaunchOptions.forceDressing`.
  const forceDressing = params.get('dress') === '1';

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
      muted,
      haptics,
      view,
      sprites,
      ...(quality !== undefined ? { quality } : {}),
      ...(forceDressing ? { forceDressing } : {}),
    });
    return;
  }

  const lobby = new Lobby(app, { roomId, modeId, ...(view !== undefined ? { view } : {}) });
  const choice = await lobby.waitForJoin();
  lobby.dispose();

  // The URL still wins, so a shared link frames the game the way its sender
  // meant; the picker is what a player without one uses.
  await launch(app, {
    ...choice,
    transportKind,
    botCount,
    view: view ?? choice.view,
    sprites,
    muted,
    haptics,
    ...(quality !== undefined ? { quality } : {}),
    ...(forceDressing ? { forceDressing } : {}),
  });
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

  // URL wins over the mode's default, so any game can be demoed in any
  // projection without touching its rules.
  const resolvedView: ViewMode = options.view ?? mode.view ?? 'follow';

  try {
    renderer = new Renderer({
      canvas,
      config,
      obstacles: session.world.obstacles,
      view: resolvedView,
      sprites: options.sprites ?? mode.sprites ?? false,
      ...(options.quality !== undefined ? { quality: options.quality } : {}),
      ...(options.forceDressing ? { forceDressing: true } : {}),
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
    canOrbit: viewSpec(resolvedView).manualControl,
  });

  // Procedural blips — no audio files, and `?mute=1` for quiet demos. The
  // announcer already knows what just happened, so it drives the sounds.
  const audio = new GameAudio({ muted: options.muted });
  audio.attach();
  // Engines are a continuous layer rather than a cue, and only a mode with
  // cars has any. The numbers come from the mode because the note is a
  // fraction of top speed and the load is measured against what the engine
  // can actually pull.
  if (config.vehicle.enabled) {
    audio.enableEngines({
      topSpeed: config.playerMaxSpeed,
      engineAccel: config.vehicle.engineAccel,
    });
  }
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
  // Every presentation option in one place, changeable mid-game. These were
  // all query parameters, which meant that changing your camera meant editing
  // a URL — not something anyone does mid-race, and not something a phone
  // player can reasonably do at all.
  // Both corner buttons share one row, so neither can drift on top of the
  // other — or onto the action buttons above them.
  const utility = document.createElement('div');
  utility.className = 'hud-utility';
  app.append(utility);

  // Only a car has pedals to feel, so this is null in every other mode — and
  // null on a device with no motor, which is desktop and every iPhone.
  const haptics = config.vehicle.enabled ? new DriveHaptics() : null;
  haptics?.setEnabled(options.haptics);

  const settings = new Settings(utility, {
    defaultView: mode.view ?? 'follow',
    initial: {
      view: resolvedView,
      sprites: options.sprites ?? mode.sprites ?? false,
      muted: options.muted,
      haptics: options.haptics,
      // Whatever the renderer settled on, which is the device's answer when
      // the player has not given one.
      quality: renderer.quality,
    },
    ...(haptics?.supported ? { hasHaptics: true } : {}),
    onChange: (values) => {
      renderer?.setView(values.view);
      renderer?.setSprites(values.sprites);
      audio.setMuted(values.muted);
      haptics?.setEnabled(values.haptics);
      renderer?.setQuality(values.quality);
      hud.setCanOrbit(viewSpec(values.view).manualControl);
      writePreferences(values);
      // Keep the address bar describing what is actually on screen, so that
      // "Copy link" and a refresh both stay honest. Vibration is left out on
      // purpose: it is about this hand, not about this match.
      syncUrl({ ...options, view: values.view, sprites: values.sprites, muted: values.muted });
    },
    onAddBot: () => void session.addBot(),
    onRemoveBot: () => void session.removeBot(),
  });

  // Created once the manifest resolves, so it can list real licences.
  let credits: Credits | null = null;
  const input = new KeyboardInput(window);
  input.attach();

  // Mobile is a supported target, so the game ships with on-screen controls,
  // and there are two sets because there are two things to control.
  //
  // On foot, one stick: the thumb points where the player wants to go, which
  // is a single idea and belongs on a single control. A car is two ideas —
  // how much lock, and how much speed — and asking one thumb to hold both at
  // once on a diagonal is what made driving on a phone feel vague. So a car
  // gets a steering track under one thumb and pedals under the other.
  const driving = config.vehicle.enabled ? new TouchDriving(app) : null;
  const touch = driving ? null : new TouchInput(app);
  driving?.attach();
  touch?.attach();

  // Action buttons appear only in modes that use them — a fire button with
  // nothing to fire is just thumb clutter. In a car they ride in the pedal
  // column rather than claiming the same corner the throttle is in.
  const buttons = new TouchButtons(driving?.actions ?? app, {
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
    credits = new Credits(utility, manifest);
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
    // A car is steered, not aimed: its stick axes are steering and throttle in
    // the CAR's frame, so they must not be rotated into the camera's. Passing
    // no yaw is what keeps `moveX`/`moveZ` as the raw right/forward axes —
    // and what makes driving identical in all five views.
    //
    // Asked of `usesVehicleAxes` rather than read off the config, because the
    // bots ask the same function (`axesForDirection`, same module) for the same
    // decision. Two independent answers to "what do these axes mean?" is a bug
    // that hides: the half that is wrong passes every test the other half runs.
    const intentYaw = usesVehicleAxes(config) ? 0 : yaw;
    // Exactly one of the two touch devices exists, chosen by the mode; the
    // fallback is only here so neither branch needs an assertion.
    const stick = driving?.read() ?? touch?.read(intentYaw) ?? IDLE_INTENT;
    const intent = mergeIntents(stick, buttons.read(), input.read(intentYaw));
    session.setIntent(intent.moveX, intent.moveZ, intent.sprint, intent.buttons);

    // Driven from the pedals rather than from the car, and deliberately so.
    // What a driver feels through a pedal is their own foot: it answers the
    // instant they press, at the weight they pressed, whether or not the car
    // has got going yet. Reading it off the car's acceleration instead would
    // arrive late, say nothing at all while a wheel-spinning start went
    // nowhere, and buzz through a shunt the player never asked for.
    if (haptics) {
      const pedals = driving?.pedals ?? keyboardPedals(intent.moveZ);
      haptics.update(pedals.throttle, pedals.brake, now);
    }
    session.update(now);

    const state = session.sample(now);
    renderer.renderFrame(state, deltaSeconds);

    if (config.vehicle.enabled) {
      // The ears go on the car, not on the camera. An isometric camera sits
      // 34 units back, and hearing the race from up there would put a rival
      // alongside you a bus-length away. Orientation still comes from the
      // camera, because left and right have to match what is on screen.
      const local = state.players.find((player) => player.isLocal);
      if (local) {
        audio.updateEngines(
          state.players,
          {
            x: local.x,
            y: local.y,
            z: local.z,
            vx: local.vx,
            vz: local.vz,
            forwardX: Math.sin(yaw),
            forwardZ: Math.cos(yaw),
          },
          deltaSeconds,
        );
      }
    }
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
    settings.setBotCount(session.botCount, session.isHost);
  });

  const teardown = (): void => {
    window.removeEventListener('resize', onResize);
    window.removeEventListener('orientationchange', onOrientationChange);
    releaseWakeLock();
    haptics?.stop();
    window.removeEventListener('blur', silenceHaptics);
    document.removeEventListener('visibilitychange', silenceHaptics);
    input.detach();
    touch?.dispose();
    driving?.dispose();
    buttons.dispose();
    audio.dispose();
    announcer.dispose();
    credits?.dispose();
    settings.dispose();
    utility.remove();
    hud.dispose();
    renderer.dispose();
    void session.dispose();
  };
  // A vibration is queued on the DEVICE, not on the page, so one issued a
  // frame before the tab went away keeps running in a pocket after the render
  // loop has stopped asking for it.
  const silenceHaptics = (): void => haptics?.stop();
  window.addEventListener('blur', silenceHaptics);
  document.addEventListener('visibilitychange', silenceHaptics);

  window.addEventListener('pagehide', teardown, { once: true });

  exposeTestHandle(session, renderer, options.modeId);
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
  // Muting is off by default, so only say so when it is on: a link that reads
  // `mute=0` is noise on every share.
  if (options.muted) url.searchParams.set('mute', '1');
  else url.searchParams.delete('mute');
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
function exposeTestHandle(session: NetSession, renderer: Renderer, modeId: GameModeId): void {
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
      /** The tier in force, after governor step-downs — not the one asked for. */
      get quality() {
        return renderer.quality;
      },
      /** What shadow rig is live and how many casters feed it. */
      get shadows() {
        return renderer.shadowDiagnostics;
      },
      /** Live, not the view the page opened in: settings can change it. */
      get view() {
        return renderer.view;
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
          heading: player.heading,
          // Velocity, because several driving assertions are about whether the
          // car is actually MOVING and a stopped car is indistinguishable from
          // a broken control if you only ever look at its heading.
          vx: player.vx,
          vz: player.vz,
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
