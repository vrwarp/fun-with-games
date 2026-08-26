import { quantize } from '../shared/math.js';
import {
  BUTTON_MASK,
  TEAM_NONE,
  type BallState,
  type EffectMap,
  type ItemState,
  type PhaseState,
  type PickupKind,
  type PlayerInput,
  type PlayerProfile,
  type ProjectileState,
  type TyreState,
  type WorldSnapshot,
  type ZoneRuntimeState,
} from '../sim/types.js';

/**
 * Bump on any breaking change to the message shapes below.
 *
 * Peers with mismatched versions ignore each other's traffic rather than
 * half-parsing it. In a decentralized game there is no server to upgrade, so
 * two versions of the client WILL meet in the wild.
 *
 * v2: game kit — buttons in inputs; phase, teams, ball, projectiles, items,
 * zones and per-player kit fields in snapshots.
 * v3: vertical axis — heights and vertical velocity for players, pickups,
 * projectiles and items, plus jump bookkeeping.
 * v4: racing — per-player lap timing (lap start, last lap, best lap).
 * v5: tyre stacks as bodies — positions and velocities in snapshots.
 * v6: one body per TYRE, not per stack — same entry shape, three entries per
 * stack spot (`tyres` replaces `tyreStacks`), so the rosters differ and the
 * versions must not meet.
 */
export const PROTOCOL_VERSION = 6;

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
  /** Action button bitfield (`BUTTON_*`), masked with `BUTTON_MASK`. */
  buttons: number;
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
// Hostile-input ceilings
// ---------------------------------------------------------------------------

/**
 * Upper bounds on collection sizes in a snapshot. Snapshots come from an
 * unauthenticated peer; without ceilings a hostile host could make every
 * client validate (and then simulate) a million projectiles.
 */
const MAX_PLAYERS = 64;
const MAX_PICKUPS = 256;
const MAX_PROJECTILES = 256;
const MAX_ITEMS = 32;
const MAX_ZONES = 64;
const MAX_TYRES = 768;
const MAX_TEAMS = 16;
const MAX_EFFECTS = 16;
const EFFECT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,23}$/;

const PICKUP_KINDS: readonly PickupKind[] = ['score', 'speed', 'shield', 'heal'];
const PHASE_IDS = ['lobby', 'countdown', 'playing', 'ended'] as const;

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
    phase: { ...snapshot.phase },
    players: snapshot.players.map((p) => ({
      ...p,
      x: quantize(p.x),
      z: quantize(p.z),
      y: quantize(p.y),
      vx: quantize(p.vx, 2),
      vz: quantize(p.vz, 2),
      vy: quantize(p.vy, 2),
      heading: quantize(p.heading, 2),
      effects: { ...p.effects },
      input: { ...p.input },
    })),
    pickups: snapshot.pickups.map((p) => ({
      ...p,
      x: quantize(p.x),
      z: quantize(p.z),
      y: quantize(p.y),
    })),
    teamScores: [...snapshot.teamScores],
    ball: snapshot.ball
      ? {
          ...snapshot.ball,
          x: quantize(snapshot.ball.x),
          z: quantize(snapshot.ball.z),
          vx: quantize(snapshot.ball.vx, 2),
          vz: quantize(snapshot.ball.vz, 2),
        }
      : null,
    projectiles: snapshot.projectiles.map((p) => ({
      ...p,
      x: quantize(p.x),
      z: quantize(p.z),
      y: quantize(p.y),
      vx: quantize(p.vx, 2),
      vz: quantize(p.vz, 2),
    })),
    items: snapshot.items.map((i) => ({
      ...i,
      x: quantize(i.x),
      z: quantize(i.z),
      y: quantize(i.y),
    })),
    zones: snapshot.zones.map((z) => ({ ...z })),
    // Centimetres are plenty for a 1.6-metre prop, and the coarser grid keeps
    // a parked wall of them cheap on the wire — every value is a short "0".
    tyres: snapshot.tyres.map((s) => ({
      x: quantize(s.x, 2),
      z: quantize(s.z, 2),
      vx: quantize(s.vx, 2),
      vz: quantize(s.vz, 2),
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
      return decodeSnapshotMessage(raw);
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
  const buttons = raw['buttons'];
  if (!isFiniteNumber(buttons)) return null;

  return {
    v: PROTOCOL_VERSION,
    type: 'input',
    seq: Math.floor(seq),
    mx: clampAxis(mx),
    mz: clampAxis(mz),
    sprint: raw['sprint'] === true,
    buttons: Math.floor(buttons) & BUTTON_MASK,
  };
}

function decodeSnapshotMessage(raw: Record<string, unknown>): SnapshotMessage | null {
  const hostId = raw['hostId'];
  const snapshot = raw['snapshot'];
  if (typeof hostId !== 'string' || !isRecord(snapshot)) return null;

  const decoded = decodeWorldSnapshot(snapshot);
  if (!decoded) return null;

  return { v: PROTOCOL_VERSION, type: 'snapshot', hostId, snapshot: decoded };
}

/** Exported for tests: the full snapshot validator. */
export function decodeWorldSnapshot(snapshot: Record<string, unknown>): WorldSnapshot | null {
  const tick = snapshot['tick'];
  const rngState = snapshot['rngState'];
  if (!isFiniteNumber(tick) || !isFiniteNumber(rngState)) return null;

  const phase = decodePhase(snapshot['phase']);
  if (!phase) return null;

  const players = decodeArray(snapshot['players'], MAX_PLAYERS, decodePlayer);
  const pickups = decodeArray(snapshot['pickups'], MAX_PICKUPS, decodePickup);
  const projectiles = decodeArray(snapshot['projectiles'], MAX_PROJECTILES, decodeProjectile);
  const items = decodeArray(snapshot['items'], MAX_ITEMS, decodeItem);
  const zones = decodeArray(snapshot['zones'], MAX_ZONES, decodeZone);
  const tyres = decodeArray(snapshot['tyres'], MAX_TYRES, decodeTyre);
  if (!players || !pickups || !projectiles || !items || !zones || !tyres) return null;

  const teamScores = decodeTeamScores(snapshot['teamScores']);
  if (!teamScores) return null;

  const rawBall = snapshot['ball'];
  let ball: BallState | null = null;
  if (rawBall !== null && rawBall !== undefined) {
    ball = decodeBall(rawBall);
    if (!ball) return null;
  }

  return {
    tick: Math.floor(tick),
    rngState: rngState >>> 0,
    phase,
    players,
    pickups,
    teamScores,
    ball,
    projectiles,
    items,
    zones,
    tyres,
  };
}

function decodeArray<T>(
  raw: unknown,
  maxLength: number,
  decodeOne: (entry: unknown) => T | null,
): T[] | null {
  if (!Array.isArray(raw) || raw.length > maxLength) return null;
  const out: T[] = [];
  for (const entry of raw) {
    const decoded = decodeOne(entry);
    if (!decoded) return null;
    out.push(decoded);
  }
  return out;
}

function decodePhase(raw: unknown): PhaseState | null {
  if (!isRecord(raw)) return null;
  const id = raw['id'];
  if (typeof id !== 'string' || !(PHASE_IDS as readonly string[]).includes(id)) return null;
  const endTick = raw['endTick'];
  const round = raw['round'];
  const winnerTeam = raw['winnerTeam'];
  const winnerId = raw['winnerId'];
  if (!isFiniteNumber(endTick) || !isFiniteNumber(round) || !isFiniteNumber(winnerTeam)) {
    return null;
  }
  if (typeof winnerId !== 'string') return null;

  return {
    id: id as PhaseState['id'],
    endTick: Math.floor(endTick),
    round: Math.floor(round),
    winnerId: winnerId.slice(0, 64),
    winnerTeam: clampTeam(winnerTeam),
  };
}

function decodePlayer(raw: unknown): WorldSnapshot['players'][number] | null {
  if (!isRecord(raw)) return null;
  const { id, name, color } = raw;
  if (typeof id !== 'string' || typeof name !== 'string' || typeof color !== 'string') return null;

  const numbers = [
    'x',
    'z',
    'y',
    'vx',
    'vz',
    'vy',
    'heading',
    'score',
    'team',
    'role',
    'hp',
    'lives',
    'checkpoint',
    'lap',
    'lapStartTick',
    'lastLapTicks',
    'bestLapTicks',
    'jumps',
    'lastInputSeq',
  ] as const;
  for (const key of numbers) {
    if (!isFiniteNumber(raw[key])) return null;
  }

  const input = decodeHeldInput(raw['input']);
  if (!input) return null;

  const effects = decodeEffects(raw['effects']);
  if (!effects) return null;

  return {
    id,
    name: name.slice(0, 24),
    color: sanitizeColor(color),
    x: raw['x'] as number,
    z: raw['z'] as number,
    y: raw['y'] as number,
    vx: raw['vx'] as number,
    vz: raw['vz'] as number,
    vy: raw['vy'] as number,
    heading: raw['heading'] as number,
    score: Math.floor(raw['score'] as number),
    team: clampTeam(raw['team'] as number),
    role: Math.floor(raw['role'] as number),
    hp: Math.floor(raw['hp'] as number),
    lives: Math.floor(raw['lives'] as number),
    checkpoint: Math.floor(raw['checkpoint'] as number),
    lap: Math.floor(raw['lap'] as number),
    // Lap times are durations: a negative one would render as a nonsense
    // "-3.4s best lap", so the floor is 0 ("none yet") rather than a reject.
    lapStartTick: Math.max(0, Math.floor(raw['lapStartTick'] as number)),
    lastLapTicks: Math.max(0, Math.floor(raw['lastLapTicks'] as number)),
    bestLapTicks: Math.max(0, Math.floor(raw['bestLapTicks'] as number)),
    grounded: raw['grounded'] === true,
    jumps: Math.floor(raw['jumps'] as number),
    jumpLatch: raw['jumpLatch'] === true,
    isBot: raw['isBot'] === true,
    effects,
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
  const buttons = raw['buttons'];
  if (!isFiniteNumber(seq) || !isFiniteNumber(moveX) || !isFiniteNumber(moveZ)) return null;
  if (!isFiniteNumber(buttons)) return null;
  if (seq < 0) return null;

  return {
    seq: Math.floor(seq),
    moveX: clampAxis(moveX),
    moveZ: clampAxis(moveZ),
    sprint: raw['sprint'] === true,
    buttons: Math.floor(buttons) & BUTTON_MASK,
  };
}

function decodeEffects(raw: unknown): EffectMap | null {
  if (!isRecord(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length > MAX_EFFECTS) return null;

  const effects: EffectMap = {};
  for (const key of keys) {
    if (!EFFECT_ID_PATTERN.test(key)) return null;
    const value = raw[key];
    if (!isFiniteNumber(value) || value < 0) return null;
    effects[key] = Math.floor(value);
  }
  return effects;
}

function decodePickup(raw: unknown): WorldSnapshot['pickups'][number] | null {
  if (!isRecord(raw)) return null;
  if (!isFiniteNumber(raw['id']) || !isFiniteNumber(raw['x']) || !isFiniteNumber(raw['z'])) {
    return null;
  }
  if (!isFiniteNumber(raw['y'])) return null;
  if (!isFiniteNumber(raw['respawnTick'])) return null;
  const kind = raw['kind'];
  if (typeof kind !== 'string' || !(PICKUP_KINDS as readonly string[]).includes(kind)) return null;

  return {
    id: Math.floor(raw['id']),
    x: raw['x'],
    z: raw['z'],
    y: raw['y'],
    kind: kind as PickupKind,
    active: raw['active'] === true,
    respawnTick: Math.floor(raw['respawnTick']),
  };
}

function decodeTeamScores(raw: unknown): number[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_TEAMS) return null;
  const scores: number[] = [];
  for (const entry of raw) {
    if (!isFiniteNumber(entry)) return null;
    scores.push(Math.floor(entry));
  }
  return scores;
}

function decodeBall(raw: unknown): BallState | null {
  if (!isRecord(raw)) return null;
  for (const key of ['x', 'z', 'vx', 'vz'] as const) {
    if (!isFiniteNumber(raw[key])) return null;
  }
  const lastTouchId = raw['lastTouchId'];
  if (typeof lastTouchId !== 'string') return null;

  return {
    x: raw['x'] as number,
    z: raw['z'] as number,
    vx: raw['vx'] as number,
    vz: raw['vz'] as number,
    lastTouchId: lastTouchId.slice(0, 64),
  };
}

function decodeTyre(raw: unknown): TyreState | null {
  if (!isRecord(raw)) return null;
  for (const key of ['x', 'z', 'vx', 'vz'] as const) {
    if (!isFiniteNumber(raw[key])) return null;
  }
  return {
    x: raw['x'] as number,
    z: raw['z'] as number,
    vx: raw['vx'] as number,
    vz: raw['vz'] as number,
  };
}

function decodeProjectile(raw: unknown): ProjectileState | null {
  if (!isRecord(raw)) return null;
  for (const key of ['id', 'team', 'x', 'z', 'y', 'vx', 'vz', 'bornTick'] as const) {
    if (!isFiniteNumber(raw[key])) return null;
  }
  const ownerId = raw['ownerId'];
  if (typeof ownerId !== 'string') return null;

  return {
    id: Math.floor(raw['id'] as number),
    ownerId: ownerId.slice(0, 64),
    team: clampTeam(raw['team'] as number),
    x: raw['x'] as number,
    z: raw['z'] as number,
    y: raw['y'] as number,
    vx: raw['vx'] as number,
    vz: raw['vz'] as number,
    bornTick: Math.floor(raw['bornTick'] as number),
  };
}

function decodeItem(raw: unknown): ItemState | null {
  if (!isRecord(raw)) return null;
  for (const key of ['id', 'x', 'z', 'y', 'returnTick'] as const) {
    if (!isFiniteNumber(raw[key])) return null;
  }
  const carrierId = raw['carrierId'];
  if (typeof carrierId !== 'string') return null;

  return {
    id: Math.floor(raw['id'] as number),
    x: raw['x'] as number,
    z: raw['z'] as number,
    y: raw['y'] as number,
    carrierId: carrierId.slice(0, 64),
    returnTick: Math.floor(raw['returnTick'] as number),
    atHome: raw['atHome'] === true,
  };
}

function decodeZone(raw: unknown): ZoneRuntimeState | null {
  if (!isRecord(raw)) return null;
  if (!isFiniteNumber(raw['id']) || !isFiniteNumber(raw['ownerTeam'])) return null;
  const ownerId = raw['ownerId'];
  if (typeof ownerId !== 'string') return null;

  return {
    id: Math.floor(raw['id']),
    ownerTeam: clampTeam(raw['ownerTeam']),
    ownerId: ownerId.slice(0, 64),
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

/** Teams are small non-negative indices; anything else becomes TEAM_NONE. */
function clampTeam(value: number): number {
  const team = Math.floor(value);
  return team >= 0 && team < MAX_TEAMS ? team : TEAM_NONE;
}

/** Only `#rgb` / `#rrggbb` survives; anything else becomes a neutral grey. */
function sanitizeColor(value: string): string {
  return /^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$/.test(value) ? value : '#9aa0a6';
}
