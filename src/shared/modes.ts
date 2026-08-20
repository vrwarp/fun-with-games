/**
 * Game-mode metadata: ids, display names, one-line rules.
 *
 * This is pure data with no dependencies so that every layer may read it —
 * the lobby lists modes, the HUD explains the goal, `main.ts` resolves the
 * `?mode=` query parameter, and `src/sim/presets.ts` maps each id to a full
 * `SimConfig`. Keep the two files' id lists identical; a unit test checks.
 */

export type GameModeId =
  | 'gather'
  | 'rush'
  | 'tag'
  | 'infection'
  | 'hill'
  | 'race'
  | 'arena'
  | 'knockout'
  | 'soccer'
  | 'ctf'
  | 'crown';

export interface GameModeInfo {
  readonly id: GameModeId;
  readonly title: string;
  /** One sentence for the lobby's mode picker. */
  readonly tagline: string;
  /** How you win, phrased for the player. Shown in the HUD. */
  readonly goal: string;
  /** Whether the mode uses the primary action button (shows it on touch). */
  readonly usesPrimaryAction: boolean;
  /** Suggested minimum players — the lobby hints to add bots below this. */
  readonly suggestedPlayers: number;
}

export const DEFAULT_MODE_ID: GameModeId = 'gather';

export const GAME_MODES: readonly GameModeInfo[] = [
  {
    id: 'gather',
    title: 'Shard Gather',
    tagline: 'The endless sandbox — collect shards forever.',
    goal: 'Collect shards. No timer, no winner, just vibes.',
    usesPrimaryAction: false,
    suggestedPlayers: 1,
  },
  {
    id: 'rush',
    title: 'Shard Rush',
    tagline: 'Timed shard race — first to 25 or most when time runs out.',
    goal: 'First to 25 shards wins the round.',
    usesPrimaryAction: false,
    suggestedPlayers: 2,
  },
  {
    id: 'tag',
    title: 'Tag',
    tagline: 'One player is IT. Don’t be that player.',
    goal: 'Score ticks up while you are NOT it. Highest score when time runs out wins.',
    usesPrimaryAction: false,
    suggestedPlayers: 3,
  },
  {
    id: 'infection',
    title: 'Infection',
    tagline: 'Tag spreads. Survive the horde.',
    goal: 'Survivors earn points every second. Round ends when everyone is infected.',
    usesPrimaryAction: false,
    suggestedPlayers: 3,
  },
  {
    id: 'hill',
    title: 'King of the Hill',
    tagline: 'Hold the centre circle — and blast rivals off it.',
    goal: 'Stand alone on the hill to score; shots shove but never hurt. First to 45 wins.',
    usesPrimaryAction: true,
    suggestedPlayers: 2,
  },
  {
    id: 'race',
    title: 'Checkpoint Race',
    tagline: 'Lap the arena through the glowing gates.',
    goal: 'Hit the checkpoints in order. First to 3 laps wins.',
    usesPrimaryAction: false,
    suggestedPlayers: 2,
  },
  {
    id: 'arena',
    title: 'Blaster Arena',
    tagline: 'Free-for-all blaster fight with power-ups.',
    goal: 'Knock players out to score. First to 10 KOs wins.',
    usesPrimaryAction: true,
    suggestedPlayers: 2,
  },
  {
    id: 'knockout',
    title: 'Knockout',
    tagline: 'Three lives. Last one standing.',
    goal: 'Everyone has 3 lives. Be the last player standing.',
    usesPrimaryAction: true,
    suggestedPlayers: 2,
  },
  {
    id: 'soccer',
    title: 'Shardball',
    tagline: 'Two teams, one ball, two goals.',
    goal: 'Push the ball into the enemy goal. First team to 5 wins.',
    usesPrimaryAction: false,
    suggestedPlayers: 4,
  },
  {
    id: 'ctf',
    title: 'Capture the Flag',
    tagline: 'Steal their flag, defend your own, blasters hot.',
    goal: 'Carry the enemy flag back to your base. First team to 3 captures wins.',
    usesPrimaryAction: true,
    suggestedPlayers: 4,
  },
  {
    id: 'crown',
    title: 'Crown Keeper',
    tagline: 'Grab the crown, keep the crown.',
    goal: 'Hold the crown to score every second. Touch the carrier to steal it. First to 30 wins.',
    usesPrimaryAction: false,
    suggestedPlayers: 3,
  },
];

/** Team display info, indexed by team number. Two teams are supported today. */
export const TEAM_INFO: readonly { readonly name: string; readonly color: string }[] = [
  { name: 'Blue', color: '#3a86ff' },
  { name: 'Red', color: '#ef476f' },
];

export function isGameModeId(value: string | null | undefined): value is GameModeId {
  return GAME_MODES.some((mode) => mode.id === value);
}

export function modeInfo(id: GameModeId): GameModeInfo {
  const info = GAME_MODES.find((mode) => mode.id === id);
  if (!info) throw new Error(`unknown game mode: ${id}`);
  return info;
}
