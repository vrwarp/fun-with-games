import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readPreferences, writePreferences } from '@/ui/preferences.js';

/** A `localStorage` stand-in, since the unit suite runs headless. */
function useStorage(impl?: Partial<Storage>): Map<string, string> {
  const store = new Map<string, string>();
  const storage: Partial<Storage> = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    ...impl,
  };
  vi.stubGlobal('localStorage', storage);
  return store;
}

describe('preferences', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('round-trips the presentation choices', () => {
    useStorage();
    writePreferences({ view: 'first', sprites: true, muted: true });
    expect(readPreferences()).toEqual({ view: 'first', sprites: true, muted: true });
  });

  it('merges rather than replaces, so one setting never clears another', () => {
    useStorage();
    writePreferences({ view: 'topdown' });
    writePreferences({ muted: true });
    expect(readPreferences()).toEqual({ view: 'topdown', muted: true });
  });

  it('reads nothing when nothing is stored', () => {
    useStorage();
    expect(readPreferences()).toEqual({});
  });

  it('ignores a view id this build does not have', () => {
    // Preferences outlive builds: a stored view from a future version, or a
    // hand-edited one, must not put the renderer into a view that has no spec.
    const store = useStorage();
    store.set('fwg:preferences', JSON.stringify({ view: 'holodeck', muted: true }));
    expect(readPreferences()).toEqual({ muted: true });
  });

  it('ignores values of the wrong type', () => {
    const store = useStorage();
    store.set('fwg:preferences', JSON.stringify({ sprites: 'yes', muted: 1 }));
    expect(readPreferences()).toEqual({});
  });

  it('survives corrupt or non-object storage', () => {
    const store = useStorage();
    store.set('fwg:preferences', '{not json');
    expect(readPreferences()).toEqual({});
    store.set('fwg:preferences', '"a string"');
    expect(readPreferences()).toEqual({});
  });

  it('survives storage that throws, as private modes do', () => {
    // Safari in private browsing throws on both reads and writes. Losing a
    // camera preference is acceptable; losing the game is not.
    useStorage({
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    expect(readPreferences()).toEqual({});
    expect(() => writePreferences({ muted: true })).not.toThrow();
  });

  it('survives an environment with no storage at all', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(readPreferences()).toEqual({});
    expect(() => writePreferences({ view: 'iso' })).not.toThrow();
  });
});
