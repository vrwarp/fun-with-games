import { createLogger } from '../shared/logger.js';

const log = createLogger('render:device');

/**
 * Small platform niceties that only matter on a phone.
 *
 * Every one of these APIs is optional, permission-gated, or both, and none is
 * available in every browser. They are all written to degrade to nothing: the
 * game is identical without them, just slightly less pleasant.
 */

/**
 * Keeps the screen awake while playing.
 *
 * Without this a phone dims and locks after ~30 seconds of not being touched,
 * which is exactly what happens to a player who is standing still watching the
 * scoreboard. The lock is dropped by the browser whenever the tab is hidden,
 * so it has to be re-acquired on the way back.
 */
export function keepScreenAwake(): () => void {
  const wakeLock = (
    navigator as Navigator & {
      wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> };
    }
  ).wakeLock;

  if (!wakeLock) return () => undefined;

  let sentinel: { release(): Promise<void> } | null = null;
  let released = false;

  const acquire = async (): Promise<void> => {
    if (released || sentinel || document.visibilityState !== 'visible') return;
    try {
      sentinel = await wakeLock.request('screen');
    } catch (error) {
      // Denied, unsupported, or the document lost focus mid-request. Not worth
      // bothering the player about.
      log.debug('wake lock unavailable', error);
    }
  };

  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') {
      sentinel = null;
      void acquire();
    }
  };

  void acquire();
  document.addEventListener('visibilitychange', onVisibilityChange);

  return () => {
    released = true;
    document.removeEventListener('visibilitychange', onVisibilityChange);
    void sentinel?.release().catch(() => undefined);
    sentinel = null;
  };
}

/**
 * A short buzz for a scoring event.
 *
 * Ignored on desktop and on iOS, where `navigator.vibrate` does not exist.
 * Deliberately brief — anything longer reads as an error, not a reward.
 */
export function tapFeedback(durationMs = 15): void {
  try {
    navigator.vibrate?.(durationMs);
  } catch {
    // Some browsers throw when the document has never been interacted with.
  }
}
