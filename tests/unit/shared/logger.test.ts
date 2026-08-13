import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger, getLogLevel, setLogLevel } from '@/shared/logger.js';

afterEach(() => {
  setLogLevel('info');
  vi.restoreAllMocks();
});

describe('createLogger', () => {
  it('suppresses messages below the active level', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    setLogLevel('warn');

    createLogger('test').info('hidden');

    expect(info).not.toHaveBeenCalled();
  });

  it('emits messages at or above the active level', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setLogLevel('warn');

    createLogger('test').warn('shown');

    expect(warn).toHaveBeenCalledWith('[test]', 'shown');
  });

  it('silences everything at the silent level', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    setLogLevel('silent');

    createLogger('test').error('nope');

    expect(error).not.toHaveBeenCalled();
  });

  it('reports the current level', () => {
    setLogLevel('debug');
    expect(getLogLevel()).toBe('debug');
  });
});
