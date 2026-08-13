import { describe, expect, it, vi } from 'vitest';
import { Emitter } from '@/shared/emitter.js';

type TestEvents = {
  ping: { value: number };
  pong: { text: string };
};

describe('Emitter', () => {
  it('delivers payloads to subscribers of that event only', () => {
    const emitter = new Emitter<TestEvents>();
    const onPing = vi.fn();
    const onPong = vi.fn();

    emitter.on('ping', onPing);
    emitter.on('pong', onPong);
    emitter.emit('ping', { value: 1 });

    expect(onPing).toHaveBeenCalledWith({ value: 1 });
    expect(onPong).not.toHaveBeenCalled();
  });

  it('stops delivering after unsubscribe', () => {
    const emitter = new Emitter<TestEvents>();
    const listener = vi.fn();

    const off = emitter.on('ping', listener);
    emitter.emit('ping', { value: 1 });
    off();
    emitter.emit('ping', { value: 2 });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('fires a `once` listener exactly once', () => {
    const emitter = new Emitter<TestEvents>();
    const listener = vi.fn();

    emitter.once('ping', listener);
    emitter.emit('ping', { value: 1 });
    emitter.emit('ping', { value: 2 });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(emitter.listenerCount('ping')).toBe(0);
  });

  it('survives a listener that unsubscribes another during dispatch', () => {
    // Mutating the listener set mid-emit is a classic source of skipped
    // callbacks; the emitter iterates a copy to avoid it.
    const emitter = new Emitter<TestEvents>();
    const third = vi.fn();

    const offSecond = emitter.on('ping', () => {
      /* no-op */
    });
    emitter.on('ping', () => offSecond());
    emitter.on('ping', third);

    expect(() => emitter.emit('ping', { value: 1 })).not.toThrow();
    expect(third).toHaveBeenCalledTimes(1);
  });

  it('emitting with no listeners is a no-op', () => {
    const emitter = new Emitter<TestEvents>();
    expect(() => emitter.emit('ping', { value: 1 })).not.toThrow();
  });

  it('clear() removes every listener', () => {
    const emitter = new Emitter<TestEvents>();
    const listener = vi.fn();
    emitter.on('ping', listener);

    emitter.clear();
    emitter.emit('ping', { value: 1 });

    expect(listener).not.toHaveBeenCalled();
  });
});
