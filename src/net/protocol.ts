import { quantize } from '../shared/math.js';
import type { PlayerInput, PlayerProfile, WorldSnapshot } from '../sim/types.js';

/**
 * Bump on any breaking change to the message shapes below.
 *
 * Peers with mismatched versions ignore each other's traffic rather than
 * half-parsing it. In a decentralized game there is no server to upgrade, so
 * two versions of the client WILL meet in the wild.
 */
export const PROTOCOL_VERSION = 1;

export type MessageType = 'hello' | 'input' | 'snapshot' | 'bye';

interface BaseMessage {
  /** Protocol version. */
  v: number;
  type: MessageType;
}

/** Announces cosmetic profile info. Broadcast on join and on any peer join. */
export interface HelloMessage extends BaseMessage {
  type: 'hello';
  profile: PlayerProfile;
}

/** Client -> host. Sent every simulation tick, addressed to the host only. */
export interface InputMessage extends BaseMessage {
  type: 'input';
  seq: number;
  /** Movement axes, quantized to 2 decimals. */
  mx: number;
  mz: number;
  sprint: boolean;
}

/** Host -> everyone. The authoritative state of the world. */
export interface SnapshotMessage extends BaseMessage {
  type: 'snapshot';
  hostId: string;
  snapshot: WorldSnapshot;
}

/** Voluntary, best-effort departure notice. Absence is also handled. */
export interface ByeMessage extends BaseMessage {
  type: 'bye';
}

export type NetMessage = HelloMessage | InputMessage | SnapshotMessage | ByeMessage;

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/**
 * Trims a snapshot before it goes on the wire.
 *
 * Positions are quantized to millimetres. Clients are not authoritative, so
 * the lost precision cannot accumulate — the next snapshot overwrites it.
 * The simulation itself always keeps full precision.
 *
 * Extension point: this is where a binary codec would go if bandwidth ever
 * matters. Keep the JSON path working; the tests read it.
 */
export function encodeSnapshot(snapshot: WorldSnapshot): WorldSnapshot {
  return {
    tick: snapshot.tick,
    rngState: snapshot.rngState,
    players: snapshot.players.map((p) => ({
      ...p,
      x: quantize(p.x),
      z: quantize(p.z),
      vx: quantize(p.vx, 2),
      vz: quantize(p.vz, 2),
      heading: quantize(p.heading, 2),
    })),
    pickups: snapshot.pickups.map((p) => ({
      ...p,
      x: quantize(p.x),
      z: quantize(p.z),
    })),
  };
}

// ---------------------------------------------------------------------------
// Decoding / validation
// ---------------------------------------------------------------------------

/**
 * Every byte here arrives from an unauthenticated peer over a data channel.
 *
 * There is no server to sanitise it, so the parser is total: anything that
 * does not match the schema exactly comes back as `null` and gets dropped.
 * Never widen these guards to "fix" a message you cannot parse — fix the
 * sender, or bump `PROTOCOL_VERSION`.
 */
export function decodeMessage(raw: unknown): NetMessage | null {
  if (!isRecord(raw)) return null;
  if (raw['v'] !== PROTOCOL_VERSION) return null;

  switch (raw['type']) {
    case 'hello':
      return decodeHello(raw);
    case 'input':
      return decodeInput(raw);
    case 'snapshot':
      return decodeSnapshot(raw);
    case 'bye':
      return { v: PROTOCOL_VERSION, type: 'bye' };
    default:
      return null;
  }
}

function decodeHello(raw: Record<string, unknown>): HelloMessage | null {
  const profile = raw['profile'];
  if (!isRecord(profile)) return null;
  const name = profile['name'];
  const color = profile['color'];
  if (typeof name !== 'string' || typeof color !== 'string') return null;

  return {
    v: PROTOCOL_VERSION,
    type: 'hello',
    profile: { name: name.slice(0, 24), color: sanitizeColor(color) },
  };
}

function decodeInput(raw: Record<string, unknown>): InputMessage | null {
  const seq = raw['seq'];
  const mx = raw['mx'];
  const mz = raw['mz'];
  if (!isFiniteNumber(seq) || !isFiniteNumber(mx) || !isFiniteNumber(mz)) return null;
  if (seq < 0) return null;

  return {
    v: PROTOCOL_VERSION,
    type: 'input',
    seq: Math.floor(seq),
    mx: clampAxis(mx),
    mz: clampAxis(mz),
    sprint: raw['sprint'] === true,
  };
}

function decodeSnapshot(raw: Record<string, unknown>): SnapshotMessage | null {
  const hostId = raw['hostId'];
  const snapshot = raw['snapshot'];
  if (typeof hostId !== 'string' || !isRecord(snapshot)) return null;

  const tick = snapshot['tick'];
  const rngState = snapshot['rngState'];
  const players = snapshot['players'];
  const pickups = snapshot['pickups'];
  if (!isFiniteNumber(tick) || !isFiniteNumber(rngState)) return null;
  if (!Array.isArray(players) || !Array.isArray(pickups)) return null;

  const decodedPlayers = [];
  for (const entry of players) {
    const player = decodePlayer(entry);
    if (!player) return null;
    decodedPlayers.push(player);
  }

  const decodedPickups = [];
  for (const entry of pickups) {
    const pickup = decodePickup(entry);
    if (!pickup) return null;
    decodedPickups.push(pickup);
  }

  return {
    v: PROTOCOL_VERSION,
    type: 'snapshot',
    hostId,
    snapshot: {
      tick: Math.floor(tick),
      rngState: rngState >>> 0,
      players: decodedPlayers,
      pickups: decodedPickups,
    },
  };
}

function decodePlayer(raw: unknown): WorldSnapshot['players'][number] | null {
  if (!isRecord(raw)) return null;
  const { id, name, color } = raw;
  if (typeof id !== 'string' || typeof name !== 'string' || typeof color !== 'string') return null;

  const numbers = ['x', 'z', 'vx', 'vz', 'heading', 'score', 'lastInputSeq'] as const;
  for (const key of numbers) {
    if (!isFiniteNumber(raw[key])) return null;
  }

  const input = decodeHeldInput(raw['input']);
  if (!input) return null;

  return {
    id,
    name: name.slice(0, 24),
    color: sanitizeColor(color),
    x: raw['x'] as number,
    z: raw['z'] as number,
    vx: raw['vx'] as number,
    vz: raw['vz'] as number,
    heading: raw['heading'] as number,
    score: Math.floor(raw['score'] as number),
    lastInputSeq: Math.floor(raw['lastInputSeq'] as number),
    input,
  };
}

/** The held input carried inside a snapshot's player record. */
function decodeHeldInput(raw: unknown): PlayerInput | null {
  if (!isRecord(raw)) return null;
  const seq = raw['seq'];
  const moveX = raw['moveX'];
  const moveZ = raw['moveZ'];
  if (!isFiniteNumber(seq) || !isFiniteNumber(moveX) || !isFiniteNumber(moveZ)) return null;
  if (seq < 0) return null;

  return {
    seq: Math.floor(seq),
    moveX: clampAxis(moveX),
    moveZ: clampAxis(moveZ),
    sprint: raw['sprint'] === true,
  };
}

function decodePickup(raw: unknown): WorldSnapshot['pickups'][number] | null {
  if (!isRecord(raw)) return null;
  if (!isFiniteNumber(raw['id']) || !isFiniteNumber(raw['x']) || !isFiniteNumber(raw['z'])) {
    return null;
  }
  if (!isFiniteNumber(raw['respawnTick'])) return null;

  return {
    id: Math.floor(raw['id']),
    x: raw['x'],
    z: raw['z'],
    active: raw['active'] === true,
    respawnTick: Math.floor(raw['respawnTick']),
  };
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clampAxis(value: number): number {
  return value < -1 ? -1 : value > 1 ? 1 : value;
}

/** Only `#rgb` / `#rrggbb` survives; anything else becomes a neutral grey. */
function sanitizeColor(value: string): string {
  return /^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$/.test(value) ? value : '#9aa0a6';
}
