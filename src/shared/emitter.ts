export type Unsubscribe = () => void;

type Listener<T> = (payload: T) => void;

/**
 * Minimal typed event emitter.
 *
 * `EventMap` maps event names to their payload type, so `emit`/`on` are
 * checked against each other:
 *
 * ```ts
 * const bus = new Emitter<{ scored: { playerId: string; total: number } }>();
 * bus.on('scored', ({ total }) => console.info(total));
 * ```
 */
export class Emitter<EventMap extends Record<string, unknown>> {
  readonly #listeners = new Map<keyof EventMap, Set<Listener<never>>>();

  on<K extends keyof EventMap>(event: K, listener: Listener<EventMap[K]>): Unsubscribe {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  once<K extends keyof EventMap>(event: K, listener: Listener<EventMap[K]>): Unsubscribe {
    const off = this.on(event, (payload) => {
      off();
      listener(payload);
    });
    return off;
  }

  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    const set = this.#listeners.get(event);
    if (!set) return;
    // Copy first: a listener may unsubscribe itself or others while running.
    for (const listener of [...set]) {
      (listener as Listener<EventMap[K]>)(payload);
    }
  }

  listenerCount(event: keyof EventMap): number {
    return this.#listeners.get(event)?.size ?? 0;
  }

  clear(): void {
    this.#listeners.clear();
  }
}
