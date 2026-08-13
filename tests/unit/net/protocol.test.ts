import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  decodeMessage,
  encodeSnapshot,
  type SnapshotMessage,
} from '@/net/protocol.js';
import { makeSimConfig } from '@/sim/config.js';
import { World } from '@/sim/world.js';

function sampleSnapshot() {
  const world = new World({
    seed: 5,
    config: makeSimConfig({ obstacleCount: 2, pickupCount: 3 }),
  });
  world.addPlayer('alice', { name: 'alice', color: '#4cc9f0' });
  world.setInput('alice', { seq: 4, moveX: 0.5, moveZ: -0.25, sprint: false });
  world.stepMany(12);
  return world.snapshot();
}

function snapshotMessage(): SnapshotMessage {
  return {
    v: PROTOCOL_VERSION,
    type: 'snapshot',
    hostId: 'alice',
    snapshot: encodeSnapshot(sampleSnapshot()),
  };
}

describe('encodeSnapshot', () => {
  it('quantizes positions without changing structure', () => {
    const original = sampleSnapshot();
    const encoded = encodeSnapshot(original);

    expect(encoded.players).toHaveLength(original.players.length);
    expect(encoded.pickups).toHaveLength(original.pickups.length);
    expect(encoded.tick).toBe(original.tick);
    expect(encoded.rngState).toBe(original.rngState);

    for (const player of encoded.players) {
      expect(player.x).toBeCloseTo(player.x, 3);
      // Three decimals means at most three digits after the point.
      expect(String(player.x).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(3);
    }
  });

  it('stays within a millimetre of the source', () => {
    const original = sampleSnapshot();
    const encoded = encodeSnapshot(original);

    original.players.forEach((player, index) => {
      expect(Math.abs((encoded.players[index]?.x ?? 0) - player.x)).toBeLessThan(0.001);
    });
  });

  it('does not mutate the source snapshot', () => {
    const original = sampleSnapshot();
    const copy = structuredClone(original);
    encodeSnapshot(original);
    expect(original).toEqual(copy);
  });
});

describe('decodeMessage: happy paths', () => {
  it('round-trips a snapshot', () => {
    const message = snapshotMessage();
    expect(decodeMessage(structuredClone(message))).toEqual(message);
  });

  it('round-trips hello', () => {
    const message = {
      v: PROTOCOL_VERSION,
      type: 'hello',
      profile: { name: 'bob', color: '#f72585' },
    };
    expect(decodeMessage(message)).toEqual(message);
  });

  it('round-trips input', () => {
    const message = { v: PROTOCOL_VERSION, type: 'input', seq: 12, mx: 0.5, mz: -1, sprint: true };
    expect(decodeMessage(message)).toEqual(message);
  });

  it('round-trips bye', () => {
    expect(decodeMessage({ v: PROTOCOL_VERSION, type: 'bye' })).toEqual({
      v: PROTOCOL_VERSION,
      type: 'bye',
    });
  });
});

describe('decodeMessage: hostile and malformed input', () => {
  // Everything here arrives from an unauthenticated peer over a data channel.
  // There is no server to filter it, so the parser has to be total.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'hello'],
    ['a number', 42],
    ['an array', [1, 2, 3]],
    ['an empty object', {}],
    ['an unknown type', { v: PROTOCOL_VERSION, type: 'exec' }],
    ['a wrong protocol version', { v: PROTOCOL_VERSION + 1, type: 'bye' }],
    ['a missing version', { type: 'bye' }],
  ])('rejects %s', (_label, payload) => {
    expect(decodeMessage(payload)).toBeNull();
  });

  it('rejects hello without a well-formed profile', () => {
    expect(decodeMessage({ v: PROTOCOL_VERSION, type: 'hello' })).toBeNull();
    expect(decodeMessage({ v: PROTOCOL_VERSION, type: 'hello', profile: 'bob' })).toBeNull();
    expect(decodeMessage({ v: PROTOCOL_VERSION, type: 'hello', profile: { name: 1 } })).toBeNull();
  });

  it('rejects input with non-numeric or negative fields', () => {
    const base = { v: PROTOCOL_VERSION, type: 'input', seq: 1, mx: 0, mz: 0, sprint: false };
    expect(decodeMessage({ ...base, seq: 'soon' })).toBeNull();
    expect(decodeMessage({ ...base, seq: -1 })).toBeNull();
    expect(decodeMessage({ ...base, mx: Number.NaN })).toBeNull();
    expect(decodeMessage({ ...base, mz: Number.POSITIVE_INFINITY })).toBeNull();
  });

  it('rejects a snapshot with a malformed player', () => {
    const message = snapshotMessage();
    const broken = structuredClone(message) as unknown as {
      snapshot: { players: Array<Record<string, unknown>> };
    };
    broken.snapshot.players[0] = { id: 'alice' };
    expect(decodeMessage(broken)).toBeNull();
  });

  it('rejects a snapshot whose collections are not arrays', () => {
    const message = structuredClone(snapshotMessage()) as unknown as {
      snapshot: Record<string, unknown>;
    };
    message.snapshot['players'] = 'nope';
    expect(decodeMessage(message)).toBeNull();
  });

  it('clamps oversized movement axes rather than trusting them', () => {
    const decoded = decodeMessage({
      v: PROTOCOL_VERSION,
      type: 'input',
      seq: 1,
      mx: 9999,
      mz: -9999,
      sprint: true,
    });
    expect(decoded).toMatchObject({ mx: 1, mz: -1 });
  });

  it('truncates an absurdly long display name', () => {
    const decoded = decodeMessage({
      v: PROTOCOL_VERSION,
      type: 'hello',
      profile: { name: 'x'.repeat(5000), color: '#fff' },
    });
    expect(decoded).toMatchObject({ profile: { name: 'x'.repeat(24) } });
  });

  it('replaces a non-colour colour string', () => {
    // A colour is written straight into a DOM style; only hex gets through.
    const decoded = decodeMessage({
      v: PROTOCOL_VERSION,
      type: 'hello',
      profile: { name: 'bob', color: 'url(javascript:alert(1))' },
    });
    expect(decoded).toMatchObject({ profile: { color: '#9aa0a6' } });
  });

  it('accepts both short and long hex colours', () => {
    for (const color of ['#fff', '#4cc9f0']) {
      expect(
        decodeMessage({ v: PROTOCOL_VERSION, type: 'hello', profile: { name: 'b', color } }),
      ).toMatchObject({ profile: { color } });
    }
  });

  it('coerces fractional counters to integers', () => {
    const decoded = decodeMessage({
      v: PROTOCOL_VERSION,
      type: 'input',
      seq: 3.7,
      mx: 0,
      mz: 0,
      sprint: false,
    });
    expect(decoded).toMatchObject({ seq: 3 });
  });

  it('treats a non-boolean sprint flag as false', () => {
    const decoded = decodeMessage({
      v: PROTOCOL_VERSION,
      type: 'input',
      seq: 1,
      mx: 0,
      mz: 0,
      sprint: 'yes',
    });
    expect(decoded).toMatchObject({ sprint: false });
  });
});
