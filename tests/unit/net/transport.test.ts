import { describe, expect, it, vi } from 'vitest';
import { electHost } from '@/net/transport.js';
import { MemoryNetwork } from '@/net/transports/memory.js';

describe('electHost', () => {
  it('elects self when alone', () => {
    expect(electHost('bravo', [])).toBe('bravo');
  });

  it('elects the lowest id', () => {
    expect(electHost('charlie', ['alpha', 'bravo'])).toBe('alpha');
  });

  it('elects self when self is lowest', () => {
    expect(electHost('alpha', ['bravo', 'charlie'])).toBe('alpha');
  });

  it('is independent of the order peers are listed in', () => {
    // Every peer learns about the others in a different order; election has to
    // converge regardless, since no one coordinates the decision.
    const peers = ['delta', 'alpha', 'charlie'];
    const reversed = [...peers].reverse();
    expect(electHost('bravo', peers)).toBe(electHost('bravo', reversed));
  });

  it('agrees across peers given the same membership', () => {
    const everyone = ['delta', 'alpha', 'charlie', 'bravo'];
    const elected = everyone.map((self) =>
      electHost(
        self,
        everyone.filter((id) => id !== self),
      ),
    );
    expect(new Set(elected).size).toBe(1);
    expect(elected[0]).toBe('alpha');
  });
});

describe('MemoryNetwork', () => {
  it('delivers a broadcast to every other peer but not the sender', () => {
    const network = new MemoryNetwork();
    const a = network.connect('a');
    const b = network.connect('b');
    const c = network.connect('c');

    const onB = vi.fn();
    const onC = vi.fn();
    const onA = vi.fn();
    b.onMessage(onB);
    c.onMessage(onC);
    a.onMessage(onA);

    a.send({ hello: true });
    network.flush();

    expect(onB).toHaveBeenCalledWith({ hello: true }, 'a');
    expect(onC).toHaveBeenCalledWith({ hello: true }, 'a');
    expect(onA).not.toHaveBeenCalled();
  });

  it('delivers a targeted message only to the target', () => {
    const network = new MemoryNetwork();
    const a = network.connect('a');
    const b = network.connect('b');
    const c = network.connect('c');

    const onB = vi.fn();
    const onC = vi.fn();
    b.onMessage(onB);
    c.onMessage(onC);

    a.send({ secret: 1 }, 'b');
    network.flush();

    expect(onB).toHaveBeenCalledTimes(1);
    expect(onC).not.toHaveBeenCalled();
  });

  it('accepts an array of targets', () => {
    const network = new MemoryNetwork();
    const a = network.connect('a');
    const b = network.connect('b');
    const c = network.connect('c');
    const onB = vi.fn();
    const onC = vi.fn();
    b.onMessage(onB);
    c.onMessage(onC);

    a.send({ x: 1 }, ['b', 'c']);
    network.flush();

    expect(onB).toHaveBeenCalledTimes(1);
    expect(onC).toHaveBeenCalledTimes(1);
  });

  it('holds messages until the latency has elapsed', () => {
    const network = new MemoryNetwork({ latencyMs: 100 });
    const a = network.connect('a');
    const b = network.connect('b');
    const onB = vi.fn();
    b.onMessage(onB);

    a.send({ x: 1 });
    network.advance(50);
    expect(onB).not.toHaveBeenCalled();

    network.advance(60);
    expect(onB).toHaveBeenCalledTimes(1);
  });

  it('copies payloads so sender and receiver cannot share objects', () => {
    // Real transports serialize. A test that passes only because both sides
    // alias the same object would be lying.
    const network = new MemoryNetwork();
    const a = network.connect('a');
    const b = network.connect('b');

    let received: { value: number } | null = null;
    b.onMessage((data) => {
      received = data as { value: number };
    });

    const payload = { value: 1 };
    a.send(payload);
    network.flush();
    payload.value = 2;

    expect(received).toEqual({ value: 1 });
  });

  it('drops messages at the configured rate', () => {
    const network = new MemoryNetwork({ dropRate: 1 });
    const a = network.connect('a');
    const b = network.connect('b');
    const onB = vi.fn();
    b.onMessage(onB);

    for (let i = 0; i < 10; i++) a.send({ i });
    network.flush();

    expect(onB).not.toHaveBeenCalled();
    expect(network.droppedCount).toBe(10);
  });

  it('reproduces the same drop pattern for the same seed', () => {
    const run = (): number => {
      const network = new MemoryNetwork({ dropRate: 0.5, seed: 1234 });
      const a = network.connect('a');
      network.connect('b');
      for (let i = 0; i < 50; i++) a.send({ i });
      network.flush();
      return network.droppedCount;
    };
    expect(run()).toBe(run());
  });

  it('announces peers to each other on connect', () => {
    const network = new MemoryNetwork();
    const a = network.connect('a');
    const joins: string[] = [];
    a.onPeerJoin((id) => joins.push(id));

    network.connect('b');

    expect(joins).toEqual(['b']);
    expect(a.peers()).toEqual(['b']);
  });

  it('notifies remaining peers on disconnect', () => {
    const network = new MemoryNetwork();
    const a = network.connect('a');
    network.connect('b');
    const leaves: string[] = [];
    a.onPeerLeave((id) => leaves.push(id));

    network.disconnect('b');

    expect(leaves).toEqual(['b']);
    expect(a.peers()).toEqual([]);
  });

  it('discards in-flight messages to and from a disconnected peer', () => {
    const network = new MemoryNetwork({ latencyMs: 100 });
    const a = network.connect('a');
    const b = network.connect('b');
    const onB = vi.fn();
    b.onMessage(onB);

    a.send({ x: 1 });
    network.disconnect('b');
    network.advance(200);

    expect(onB).not.toHaveBeenCalled();
  });

  it('rejects a duplicate peer id', () => {
    const network = new MemoryNetwork();
    network.connect('a');
    expect(() => network.connect('a')).toThrow(/already connected/);
  });

  it('stops delivering after close()', async () => {
    const network = new MemoryNetwork();
    const a = network.connect('a');
    const b = network.connect('b');
    const onB = vi.fn();
    b.onMessage(onB);

    await b.close();
    a.send({ x: 1 });
    network.flush();

    expect(onB).not.toHaveBeenCalled();
  });

  it('send() after close() is a no-op rather than an error', async () => {
    const network = new MemoryNetwork();
    const a = network.connect('a');
    network.connect('b');

    await a.close();
    expect(() => a.send({ x: 1 })).not.toThrow();
  });

  it('unsubscribing stops delivery', () => {
    const network = new MemoryNetwork();
    const a = network.connect('a');
    const b = network.connect('b');
    const onB = vi.fn();

    const off = b.onMessage(onB);
    off();
    a.send({ x: 1 });
    network.flush();

    expect(onB).not.toHaveBeenCalled();
  });

  it('delivers messages a handler sends in response to a message', () => {
    const network = new MemoryNetwork({ latencyMs: 10 });
    const a = network.connect('a');
    const b = network.connect('b');
    const onA = vi.fn();

    a.onMessage(onA);
    b.onMessage(() => b.send({ pong: true }, 'a'));

    a.send({ ping: true }, 'b');
    network.advance(100);

    expect(onA).toHaveBeenCalledWith({ pong: true }, 'b');
  });

  it('advances the clock to the requested time', () => {
    const network = new MemoryNetwork();
    network.advance(250);
    expect(network.now).toBe(250);
  });
});
