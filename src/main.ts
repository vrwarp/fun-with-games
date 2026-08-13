import './ui/styles.css';

import { createLogger, setLogLevel, type LogLevel } from './shared/logger.js';
import { hashStringToSeed } from './sim/rng.js';
import { DEFAULT_SIM_CONFIG } from './sim/config.js';
import { NetSession } from './net/session.js';
import type { Transport } from './net/transport.js';
import { createBroadcastTransport } from './net/transports/broadcast.js';
import { createTrysteroTransport } from './net/transports/trystero.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { Renderer } from './render/renderer.js';
import { KeyboardInput, mergeIntents } from './render/input.js';
import { TouchInput } from './render/touch.js';
import { keepScreenAwake, tapFeedback } from './render/device.js';
import { loadManifest, loadModel } from './render/assets.js';
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
  name: string;
  color: string;
  transportKind: 'trystero' | 'broadcast';
}

void bootstrap();

async function bootstrap(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  setLogLevel(readLogLevel(params));

  const app = document.querySelector<HTMLElement>('#app');
  if (!app) throw new Error('missing #app element');

  const roomId = normalizeRoomId(params.get('room') ?? randomRoomId());
  const transportKind = params.get('net') === 'broadcast' ? 'broadcast' : 'trystero';

  // `?autojoin=1` skips the lobby. Used by the e2e tests, and handy when you
  // want a shareable link that drops straight into a room.
  if (params.get('autojoin') === '1') {
    await launch(app, {
      roomId,
      name: params.get('name') ?? 'player',
      color: params.get('color') ?? '#4cc9f0',
      transportKind,
    });
    return;
  }

  const lobby = new Lobby(app, { roomId });
  const choice = await lobby.waitForJoin();
  lobby.dispose();

  await launch(app, { ...choice, transportKind });
}

async function launch(app: HTMLElement, options: LaunchOptions): Promise<void> {
  syncUrl(options);

  const canvas = document.createElement('canvas');
  canvas.className = 'viewport';
  canvas.dataset['testid'] = 'viewport';
  app.append(canvas);

  let renderer: Renderer;
  const config = DEFAULT_SIM_CONFIG;

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
    renderer = new Renderer({ canvas, config, obstacles: session.world.obstacles });
  } catch (error) {
    log.error('failed to start the 3D engine', error);
    showFatalError(app, 'This browser could not start WebGL, so the game cannot render.');
    await session.dispose();
    return;
  }

  renderer.setLocalPlayer(session.selfId);

  const hud = new Hud(app);
  const input = new KeyboardInput(window);
  input.attach();

  // Mobile is a supported target, so the game ships with an on-screen stick.
  // It reveals itself on touch devices and stays out of the way otherwise.
  const touch = new TouchInput(app);
  touch.attach();

  // Art is optional: the game is fully playable on procedural geometry, so
  // this runs in the background and upgrades the look if it succeeds.
  void applyOptionalAssets(renderer);

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
  let lastLocalScore = 0;

  renderer.engine.runRenderLoop(() => {
    const now = performance.now();
    const deltaSeconds = Math.min((now - lastFrameMs) / 1000, 0.25);
    lastFrameMs = now;

    const yaw = renderer.cameraYaw;
    const intent = mergeIntents(touch.read(yaw), input.read(yaw));
    session.setIntent(intent.moveX, intent.moveZ, intent.sprint);
    session.update(now);

    const state = session.sample(now);
    renderer.renderFrame(state, deltaSeconds);

    // Buzz on scoring. Derived from the rendered score rather than a
    // simulation event, so it works identically on the host and on clients —
    // a client never runs the pickup system that raises the event.
    const localScore = state.players.find((player) => player.id === session.selfId)?.score ?? 0;
    if (localScore > lastLocalScore) tapFeedback();
    lastLocalScore = localScore;

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
    hud.dispose();
    renderer.dispose();
    void session.dispose();
  };
  window.addEventListener('pagehide', teardown, { once: true });

  exposeTestHandle(session, renderer);
}

function createTransport(options: LaunchOptions): Transport {
  if (options.transportKind === 'broadcast') {
    log.info('using BroadcastChannel transport (same-browser only)');
    return createBroadcastTransport({ roomId: options.roomId });
  }
  log.info('using Trystero WebRTC transport');
  return createTrysteroTransport({ appId: APP_ID, roomId: options.roomId });
}

/**
 * Swaps in a loaded player model when the manifest declares one.
 *
 * Failure here is expected and harmless — the repo ships without binary art.
 * See `docs/ASSETS.md` for how to populate the manifest.
 */
async function applyOptionalAssets(renderer: Renderer): Promise<void> {
  const baseUrl = import.meta.env.BASE_URL;
  const manifest = await loadManifest(baseUrl);
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
  if (options.transportKind === 'broadcast') url.searchParams.set('net', 'broadcast');
  window.history.replaceState(null, '', url);
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
function exposeTestHandle(session: NetSession, renderer: Renderer): void {
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
