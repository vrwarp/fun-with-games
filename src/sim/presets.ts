import type { GameModeId } from '../shared/modes.js';
import {
  makeSimConfig,
  type PlatformSpec,
  type SimConfig,
  type SimConfigOverrides,
  type TrackPoint,
  type ZoneSpec,
} from './config.js';
import { smoothTrack, trackLength, trackPoseAt } from './track.js';

/**
 * Named game modes: one `SimConfig` per `GameModeId`.
 *
 * A mode is *only* configuration — which systems are on and their numbers.
 * That is the intended way to make "a different game" out of this kit: start
 * from the closest preset below, tweak, and only write new simulation code
 * when no combination of systems expresses the rule you want.
 * `docs/RECIPES.md` walks through both paths.
 *
 * Every peer in a room must run the same config. `main.ts` guarantees that by
 * putting the mode id into the transport room name, so differently-configured
 * clients never meet.
 */

const seconds = (n: number): number => n * 30; // ticks at the 30 Hz tick rate

/**
 * A hand-authored side-scrolling level: a staircase of ledges climbing to the
 * right, one perch that needs the double jump, then a descent and a final
 * climb.
 *
 * Authored, not generated, because a platformer is the one genre where random
 * geometry does not work: every step has to be jumpable, and "jumpable" is
 * arithmetic, not taste. A jump peaks at `jumpVelocity² / 2·gravity` — with
 * this preset's 12 and 30, that is **2.4 units**, about 4.8 with the double
 * jump. Every rise below is 1.8, comfortably inside a single jump, and the
 * one 3-unit step to the high perch is the only place the double jump is
 * required. Horizontal reach is `2·jumpVelocity / gravity × speed` ≈ 6.4
 * units; the widest gap here is 3.5.
 *
 * Retuning `platform` without re-checking those two numbers is how a level
 * silently becomes unfinishable — `tests/unit/sim/platform.test.ts` pins the
 * height relationship for exactly that reason.
 *
 * `halfZ` is generous so the one-lane player can never miss a platform
 * sideways — in a `lockZ` mode depth is not something the player can get wrong.
 */
const PLATFORMER_LEVEL: readonly PlatformSpec[] = [
  // Opening staircase: three 1.8-unit steps, each a single jump.
  { x: -34, z: 0, halfX: 4, halfZ: 3, baseY: 0, top: 1.8 },
  { x: -24, z: 0, halfX: 3.5, halfZ: 3, baseY: 0, top: 3.6 },
  { x: -15, z: 0, halfX: 3, halfZ: 3, baseY: 0, top: 5.4 },
  // The one place the double jump is mandatory: a 3-unit rise.
  { x: -6, z: 0, halfX: 2.5, halfZ: 3, baseY: 0, top: 8.4 },
  // Descending run of floating ledges — jump down, or walk underneath.
  { x: 2, z: 0, halfX: 3, halfZ: 3, baseY: 6, top: 7 },
  { x: 10, z: 0, halfX: 3, halfZ: 3, baseY: 3.5, top: 4.5 },
  { x: 18, z: 0, halfX: 3.5, halfZ: 3, baseY: 0, top: 2.5 },
  // Final climb, back to single-jump steps.
  { x: 27, z: 0, halfX: 3, halfZ: 3, baseY: 0, top: 4.3 },
  { x: 35, z: 0, halfX: 3.5, halfZ: 3, baseY: 0, top: 6.1 },
  { x: 42, z: 0, halfX: 3, halfZ: 3, baseY: 5, top: 8 },
];

// ---------------------------------------------------------------------------
// Circuits
// ---------------------------------------------------------------------------

/**
 * Evenly spaced timing gates around a circuit, gate 0 on the start/finish line.
 *
 * Generated rather than hand-placed because a gate has to sit ON the racing
 * line to be crossable, and "on the line" is arithmetic the centreline already
 * knows. `radius` is deliberately wider than the road: a car that runs wide
 * still trips the loop, so a mistake costs time instead of stranding the
 * driver at a gate they can no longer reach.
 */
function trackGates(path: readonly TrackPoint[], count: number, radius: number): ZoneSpec[] {
  const length = trackLength(path);
  return Array.from({ length: count }, (_, order) => {
    const pose = trackPoseAt(path, (order * length) / count);
    return { kind: 'checkpoint', x: pose.x, z: pose.z, radius, team: -1, order } as const;
  });
}

/**
 * A permanent road course, as control points in the order it is driven.
 *
 * `smoothTrack` rounds these into the centreline the game uses, so what is
 * written here is the *shape* of the lap rather than the road's own vertices.
 * Read it as a lap: a long main straight, a fast right onto the back straight,
 * a long left sweeper, a chicane that has to be braked for, a hairpin at the
 * far end, and a final corner that spits the car back onto the straight — so
 * the driver arrives at the line with the tow.
 *
 * Point 0 is the start/finish line, which is what makes the grid, the gates
 * and every lap time fall out of the list without another number being
 * written down. It is drawn well down the main straight rather than at a
 * corner exit, because everything behind it is grid.
 *
 * **Two rules when editing.** Keep each turn at or under about 40° with
 * segments of nine units or more: past that the rounded corner ends up tighter
 * than the road is wide, which is a corner nobody can drive and nothing can
 * draw. And keep the whole circuit inside its arena with a road's width to
 * spare. `tests/unit/sim/track.test.ts` checks both.
 */
const AUTODROME_CONTROL: readonly TrackPoint[] = [
  // Main straight, running +X.
  { x: -14, z: -31 }, // start/finish
  { x: 0, z: -31 },
  { x: 12, z: -31 },
  { x: 22, z: -30.5 },
  // Turn 1: a long right onto the back straight.
  { x: 31, z: -29 },
  { x: 38, z: -25 },
  { x: 44, z: -19 },
  { x: 47, z: -11 },
  // Back straight, running +Z.
  { x: 49, z: -2 },
  { x: 49, z: 8 },
  // The long left sweeper across the top of the circuit.
  { x: 46, z: 17 },
  { x: 41, z: 23 },
  { x: 34, z: 27 },
  // Chicane: right, then left, then straight again. Four 40° steps rather
  // than one 90° flick — see the note above the list.
  { x: 24, z: 29 },
  { x: 16, z: 22.5 },
  { x: 9, z: 16 },
  { x: -1, z: 16 },
  { x: -9, z: 22.5 },
  { x: -19, z: 22.5 },
  // Hairpin at the far end: the slowest corner on the circuit.
  { x: -31, z: 27 },
  { x: -41, z: 22 },
  { x: -48, z: 13 },
  { x: -49, z: 3 },
  { x: -47, z: -8 },
  { x: -45, z: -17 },
  // Final corner, back onto the main straight — so a car arrives at the line
  // with a tow, which is what makes the DRS zone on the straight matter.
  { x: -41, z: -24 },
  { x: -36, z: -28 },
  { x: -30, z: -30 },
  { x: -23, z: -31 },
];

/** A tight city lap: short straights, square corners, no room to hide. */
const STREET_CONTROL: readonly TrackPoint[] = [
  { x: -14, z: -18 }, // start/finish
  { x: 0, z: -18 },
  { x: 10, z: -18 },
  { x: 18, z: -16 },
  { x: 23, z: -11 },
  { x: 25, z: -4 },
  { x: 24, z: 4 },
  { x: 20, z: 10 },
  { x: 13, z: 14 },
  { x: 5, z: 13 },
  { x: 0, z: 9 },
  { x: -4, z: 5 }, // the left-right through the old town
  { x: -9, z: 5 },
  { x: -15, z: 9 },
  { x: -22, z: 13 },
  { x: -28, z: 10 },
  { x: -31, z: 3 },
  { x: -31, z: -5 },
  { x: -29, z: -12 },
  { x: -25, z: -16 },
  { x: -20, z: -18 },
];

const AUTODROME = smoothTrack(AUTODROME_CONTROL);
const STREET = smoothTrack(STREET_CONTROL);

const PRESETS: Record<GameModeId, SimConfigOverrides> = {
  /** The untouched sandbox: endless shard collecting. */
  gather: {},

  rush: {
    phases: {
      enabled: true,
      minPlayers: 1,
      playTicks: seconds(90),
      targetScore: 25,
    },
    pickupWeights: { score: 0.85, speed: 0.15, shield: 0, heal: 0 },
  },

  tag: {
    tag: { enabled: true, variant: 'transfer' },
    phases: { enabled: true, minPlayers: 2, playTicks: seconds(90) },
    pickupCount: 6,
    pickupWeights: { score: 0, speed: 1, shield: 0, heal: 0 },
  },

  infection: {
    tag: { enabled: true, variant: 'spread' },
    phases: { enabled: true, minPlayers: 3, playTicks: seconds(75) },
    pickupCount: 6,
    pickupWeights: { score: 0, speed: 1, shield: 0, heal: 0 },
  },

  hill: {
    zones: [{ kind: 'hill', x: 0, z: 0, radius: 4, team: -1, order: 0 }],
    // Blasters with no combat: hits shove but never hurt — the mechanic is
    // knocking rivals OFF the hill. The timer matters: a permanently
    // contested hill pays nobody, so rounds must be able to end on time.
    projectiles: { enabled: true, knockback: 14, cooldownTicks: 24 },
    phases: { enabled: true, minPlayers: 2, targetScore: 45, playTicks: seconds(120) },
    pickupCount: 4,
    pickupWeights: { score: 0, speed: 1, shield: 0, heal: 0 },
  },

  race: {
    zones: [
      { kind: 'checkpoint', x: 16, z: 0, radius: 3.5, team: -1, order: 0 },
      { kind: 'checkpoint', x: 0, z: 16, radius: 3.5, team: -1, order: 1 },
      { kind: 'checkpoint', x: -16, z: 0, radius: 3.5, team: -1, order: 2 },
      { kind: 'checkpoint', x: 0, z: -16, radius: 3.5, team: -1, order: 3 },
    ],
    zoneRules: { lapScore: 1, hillScorePerSecond: 0, goalScore: 0 },
    phases: { enabled: true, minPlayers: 2, targetScore: 3 },
    pickupCount: 6,
    pickupWeights: { score: 0, speed: 1, shield: 0, heal: 0 },
  },

  arena: {
    combat: { enabled: true, maxHp: 3, lives: 0, koScore: 1 },
    projectiles: { enabled: true },
    phases: { enabled: true, minPlayers: 2, playTicks: seconds(120), targetScore: 10 },
    pickupCount: 8,
    pickupWeights: { score: 0, speed: 0.4, shield: 0.3, heal: 0.3 },
  },

  knockout: {
    combat: { enabled: true, maxHp: 3, lives: 3, koScore: 1, respawnTicks: seconds(2) },
    projectiles: { enabled: true },
    phases: { enabled: true, minPlayers: 2 },
    pickupCount: 8,
    pickupWeights: { score: 0, speed: 0.4, shield: 0.3, heal: 0.3 },
  },

  soccer: {
    teams: { count: 2 },
    ball: { enabled: true },
    zones: [
      { kind: 'goal', x: -21, z: 0, radius: 3, team: 0, order: 0 },
      { kind: 'goal', x: 21, z: 0, radius: 3, team: 1, order: 0 },
    ],
    phases: { enabled: true, minPlayers: 2, playTicks: seconds(180), targetScore: 5 },
    pickupCount: 0,
    obstacleCount: 0,
  },

  ctf: {
    teams: { count: 2 },
    items: [
      { kind: 'flag', homeX: -20, homeZ: 0, team: 0 },
      { kind: 'flag', homeX: 20, homeZ: 0, team: 1 },
    ],
    zones: [
      { kind: 'base', x: -20, z: 0, radius: 3, team: 0, order: 0 },
      { kind: 'base', x: 20, z: 0, radius: 3, team: 1, order: 0 },
    ],
    combat: { enabled: true, maxHp: 3, lives: 0, koScore: 0, respawnTicks: seconds(2) },
    projectiles: { enabled: true },
    phases: { enabled: true, minPlayers: 2, playTicks: seconds(240), targetScore: 3 },
    obstacleCount: 8,
    pickupCount: 6,
    pickupWeights: { score: 0, speed: 0.6, shield: 0, heal: 0.4 },
  },

  crown: {
    items: [{ kind: 'crown', homeX: 0, homeZ: 0, team: -1 }],
    phases: { enabled: true, minPlayers: 2, targetScore: 30 },
    pickupCount: 6,
    pickupWeights: { score: 0, speed: 1, shield: 0, heal: 0 },
  },

  // ---- 2D / 2.5D ----------------------------------------------------------
  // The simulation is a plane, so these differ from the modes above only in
  // configuration: gravity on, one lane deep, and a camera angle chosen in
  // the mode metadata. See docs/GAME_KIT.md § "2D, 2.5D and 3D".

  /**
   * A true side-scrolling platformer: run right, jump the gaps, collect
   * shards off the ledges. The level below is authored rather than generated —
   * random boxes do not make a jumpable level.
   */
  platformer: {
    platform: {
      enabled: true,
      lockZ: true,
      gravity: 30,
      // 12 over gravity 30 peaks at 2.4 units — chosen so the level's 1.8
      // steps clear on one jump with margin to spare. See PLATFORMER_LEVEL.
      jumpVelocity: 12,
      maxJumps: 2,
      jumpButton: 'primary',
    },
    platforms: PLATFORMER_LEVEL,
    arenaHalfExtentX: 46,
    arenaHalfExtentZ: 4,
    obstacleCount: 0,
    playerMaxSpeed: 8,
    pickupCount: 22,
    pickupRespawnTicks: 240,
    pickupWeights: { score: 0.85, speed: 0.15, shield: 0, heal: 0 },
    phases: { enabled: true, minPlayers: 1, targetScore: 20, playTicks: seconds(150) },
  },

  /** Flat 2D arena shooter viewed from straight overhead. */
  skirmish: {
    combat: { enabled: true, maxHp: 3, lives: 0, koScore: 1 },
    projectiles: { enabled: true, speed: 18, cooldownTicks: 14 },
    phases: { enabled: true, minPlayers: 2, playTicks: seconds(120), targetScore: 10 },
    arenaHalfExtentX: 20,
    arenaHalfExtentZ: 20,
    obstacleCount: 12,
    pickupCount: 8,
    pickupWeights: { score: 0, speed: 0.4, shield: 0.3, heal: 0.3 },
  },

  // ---- racing -------------------------------------------------------------
  // The one place the kit swaps its movement model: `vehicle.enabled` turns
  // the omnidirectional avatar into something that has to be driven. The rest
  // is ordinary configuration — a centreline, gates generated from it, and
  // three circles that mean "open the wing here" and "change tyres here".

  /**
   * The full Formula weekend: a grid start, six laps, a slipstream, DRS on
   * the two straights, tyres that go off, and a pit lane to fix them in.
   */
  grandprix: {
    vehicle: {
      enabled: true,
      engineAccel: 22,
      // Under the traction limit, not over it: a car cannot brake harder than
      // its tyres can hold, and the old 40 was writing a cheque `tyreGrip`
      // could not cash.
      brakeDecel: 26,
      coastDecel: 13,
      // The rack stays almost fully alive at speed. Understeer is the tyres'
      // job now, and taking the angle away here as well would charge the
      // driver twice for the same corner.
      // A grand prix car: long, and it never has to park, so it runs less
      // lock than a road car. Full lock here is a radius of about six metres,
      // which the tyres can only hold at walking pace — everything faster is
      // grip-limited, which is the point.
      wheelbase: 3.4,
      // Generous lock, lightly trimmed. Measured across a sweep, trimming it
      // harder is strictly worse: the bots then cannot make the corners and
      // spend a quarter of the race in the run-off. What should stop a driver
      // asking for too much is the grip running out, not the rack running out
      // — at speed full lock here demands three times the grip the tyres have,
      // so the car simply understeers, which is the honest answer.
      maxSteerAngle: 0.6,
      steerFalloff: 0.3,
      grip: 8,
      // The number that decides every corner. A car needs v^2/r to hold a
      // line, so 26 buys a radius of about 28 flat out and about 7 at half
      // speed — which is to say the hairpin is takeable and the chicane is
      // not, unless you slow down first.
      tyreGrip: 26,
      frictionCircle: 0.55,
      // Only a little rope. A grand prix car is precise: the drama is in
      // being ON the limit, not in hanging the back out, and the bots hold
      // the road for 98% of a lap at this figure.
      frontGrip: 4.6,
      selfAlign: 3.5,
      weightFront: 0.44,
      weightTransfer: 0.28,
      brakeButton: 'secondary',
    },
    collision: {
      enabled: true,
      restitution: 0.15,
      friction: 0.4,
      spin: 0.03,
      damageSeconds: 0.45,
      damageThreshold: 9,
      damageGrip: 0.78,
    },
    track: {
      enabled: true,
      halfWidth: 6,
      offTrackSpeed: 0.45,
      offTrackGrip: 0.6,
      kerbWidth: 1.1,
      kerbGrip: 0.82,
      kerbShake: 17,
      barrierRunoff: 5,
      gridColumns: 2,
      gridRowSpacing: 5,
    },
    trackPath: AUTODROME,
    race: {
      enabled: true,
      // About four car lengths, which is close enough to be on his gearbox
      // and not so far that the whole field is towing the whole time.
      slipstreamRange: 5,
      slipstreamMultiplier: 1.12,
      // A straight, near enough: past about 16 degrees of angle between the
      // two cars you are alongside the wake rather than in it.
      slipstreamAlignment: 0.96,
      drsGapSeconds: 1,
      drsMultiplier: 1.24,
      drsTicks: seconds(2),
      drsButton: 'primary',
      // A little longer than the race, and that is a deliberate ceiling rather
      // than a target.
      //
      // Six laps is about eighty seconds, so a set lasting two minutes has
      // gone off by roughly a third at the flag: the car is measurably worse
      // at the end than at the start, which is what makes a long run a thing
      // you manage. Shorter stints were tried and are worse, because wear here
      // is purely a function of time — so a stint the race can outlast means
      // cars sitting on dead rubber, and a car on dead rubber cannot corner,
      // leaves the road, and cannot get back. Measured across three seeds,
      // a forty-six second stint puts the field in the scenery 32% of the
      // time; this puts it there 5%, which is what it is with no wear at all.
      tyreStintTicks: seconds(120),
      tyreWornGrip: 0.62,
      tyreWornSpeed: 0.87,
      pitSpeedLimit: 9,
    },
    zones: [
      // The start/finish loop is widened so that it also spans the pit lane
      // beside it — a car that pits still records its lap, exactly as a real
      // timing loop crosses both. It is never drawn (the chequered board
      // stands in for it), so the extra radius costs nothing visually.
      ...trackGates(AUTODROME, 9, 12).map((gate, index) =>
        index === 0 ? { ...gate, radius: 16 } : gate,
      ),
      // DRS on the two straights only, which is where a tow is worth having.
      { kind: 'drs', x: 0, z: -31, radius: 14, team: -1, order: 0 },
      { kind: 'drs', x: 48, z: 0, radius: 12, team: -1, order: 0 },
      // The pit lane runs down the infield beside the main straight, as four
      // overlapping boxes so it reads as a lane rather than as stepping
      // stones. It clears the tarmac by a metre, so nobody catches the
      // limiter by taking the inside line.
      { kind: 'pit', x: -30, z: -19, radius: 4.5, team: -1, order: 0 },
      { kind: 'pit', x: -24, z: -19, radius: 4.5, team: -1, order: 0 },
      { kind: 'pit', x: -18, z: -19, radius: 4.5, team: -1, order: 0 },
      { kind: 'pit', x: -12, z: -19, radius: 4.5, team: -1, order: 0 },
    ],
    zoneRules: { lapScore: 1, hillScorePerSecond: 0, goalScore: 0 },
    phases: {
      enabled: true,
      minPlayers: 2,
      // Long enough that a three-lap race always finishes; the lap count is
      // what actually ends it.
      playTicks: seconds(300),
      targetScore: 6,
      countdownTicks: seconds(4),
    },
    playerMaxSpeed: 27,
    playerRadius: 0.7,
    // Cars bump; they do not shove each other across the circuit.
    playerHeight: 1.1,
    arenaHalfExtentX: 62,
    arenaHalfExtentZ: 42,
    obstacleCount: 0,
    pickupCount: 0,
    bots: { maxCount: 8, speedMultiplier: 0.93 },
  },

  /**
   * A sprint on a tight city lap, seen from above: same cars, no wings, no
   * tyre stops. Five laps, decided on the racing line.
   */
  street: {
    vehicle: {
      enabled: true,
      engineAccel: 24,
      brakeDecel: 24,
      coastDecel: 15,
      // Shorter and turnier than the grand prix car, which is most of why a
      // street circuit suits it.
      wheelbase: 2.6,
      maxSteerAngle: 0.65,
      steerFalloff: 0.3,
      grip: 9,
      // Deliberately looser than the grand prix car: a street race should be
      // sliding about. Measured, this is the difference between a field that
      // is sideways 3% of a lap and one that is sideways 17% of it, with both
      // still keeping all four wheels on the road.
      tyreGrip: 28,
      frictionCircle: 0.6,
      frontGrip: 5,
      selfAlign: 4,
      // A road car sits more evenly and rolls further onto its nose than a
      // downforce car does, so it is both softer and more willing to rotate.
      weightFront: 0.5,
      weightTransfer: 0.32,
      brakeButton: 'secondary',
    },
    collision: { enabled: true, restitution: 0.2, friction: 0.45, spin: 0.04 },
    track: {
      enabled: true,
      halfWidth: 4.5,
      offTrackSpeed: 0.4,
      offTrackGrip: 0.6,
      // A street circuit's kerbs are the real thing rather than a racetrack's
      // sausage: narrower, and they hurt more.
      kerbWidth: 0.8,
      kerbGrip: 0.75,
      kerbShake: 24,
      // No barrier. This circuit doubles back on itself hard enough that any
      // run-off worth the name lays a wall across the next section of road,
      // and a barrier through the tarmac looks far worse than none.
      barrierRunoff: 0,
      gridColumns: 2,
      gridRowSpacing: 4,
    },
    trackPath: STREET,
    race: {
      enabled: true,
      slipstreamRange: 4,
      slipstreamMultiplier: 1.1,
      slipstreamAlignment: 0.96,
      // No straight here is long enough to deserve a wing.
      drsGapSeconds: 0,
      drsButton: 'none',
      tyreStintTicks: 0,
    },
    zones: [...trackGates(STREET, 6, 9)],
    zoneRules: { lapScore: 1, hillScorePerSecond: 0, goalScore: 0 },
    phases: {
      enabled: true,
      minPlayers: 2,
      playTicks: seconds(240),
      targetScore: 5,
      countdownTicks: seconds(4),
    },
    playerMaxSpeed: 20,
    playerRadius: 0.6,
    playerHeight: 1.1,
    arenaHalfExtentX: 38,
    arenaHalfExtentZ: 26,
    obstacleCount: 0,
    pickupCount: 0,
    bots: { maxCount: 8, speedMultiplier: 0.94 },
  },

  /** 2.5D isometric: an infection chase through a cluttered floor plan. */
  dungeon: {
    tag: { enabled: true, variant: 'spread', graceTicks: 45 },
    phases: { enabled: true, minPlayers: 3, playTicks: seconds(90) },
    arenaHalfExtentX: 22,
    arenaHalfExtentZ: 22,
    obstacleCount: 16,
    obstacleMinHalfExtent: 1,
    obstacleMaxHalfExtent: 2.5,
    pickupCount: 10,
    pickupWeights: { score: 0.7, speed: 0.3, shield: 0, heal: 0 },
  },
};

/** The full `SimConfig` for a mode. Every peer in a room must use the same. */
export function modeConfig(id: GameModeId): SimConfig {
  return makeSimConfig(PRESETS[id]);
}

/** Raw overrides for a mode — the starting point when deriving a variant. */
export function modeOverrides(id: GameModeId): SimConfigOverrides {
  return PRESETS[id];
}

export const GAME_MODE_IDS = Object.keys(PRESETS) as GameModeId[];
