import { VIEW_IDS, type ModeView } from '../shared/modes.js';

/**
 * The player's presentation choices, remembered between sessions.
 *
 * Only ever presentation: camera, art style, sound. Nothing here reaches the
 * simulation or the room name, so a stored preference can never put two peers
 * on different rules — which is exactly why it is safe to remember on the
 * device rather than agree over the wire.
 *
 * Precedence is **URL, then stored, then the mode's own default**. A link
 * someone was sent describes the game they were invited to; their own settings
 * fill in whatever the link did not say.
 */
export interface Preferences {
  readonly view?: ModeView;
  readonly sprites?: boolean;
  readonly muted?: boolean;
  readonly haptics?: boolean;
}

const STORAGE_KEY = 'fwg:preferences';

/**
 * Reads stored preferences, or nothing at all.
 *
 * Every path here is defensive on purpose: `localStorage` throws outright in
 * some privacy modes, the value may be from an older build, and a corrupt
 * preference should cost a player their camera choice rather than the game.
 */
export function readPreferences(): Preferences {
  let raw: string | null;
  try {
    raw = globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return {};
  }
  if (raw === null) return {};

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const record = parsed as Record<string, unknown>;
    const view = VIEW_IDS.find((id) => id === record['view']);

    return {
      ...(view !== undefined ? { view } : {}),
      ...(typeof record['sprites'] === 'boolean' ? { sprites: record['sprites'] } : {}),
      ...(typeof record['muted'] === 'boolean' ? { muted: record['muted'] } : {}),
      ...(typeof record['haptics'] === 'boolean' ? { haptics: record['haptics'] } : {}),
    };
  } catch {
    return {};
  }
}

/** Merges `patch` into what is stored. Silently does nothing if it cannot. */
export function writePreferences(patch: Preferences): void {
  const next = { ...readPreferences(), ...patch };
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // A player in a private window still gets the setting for this session;
    // they just do not get it back tomorrow. Not worth telling them about.
  }
}
