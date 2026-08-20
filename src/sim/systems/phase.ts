import type { SimConfig } from '../config.js';
import type { StepContext } from '../step.js';
import { ROLE_NONE, TEAM_NONE, type PhaseId, type PhaseState } from '../types.js';
import { spawnPosition } from './arena.js';

/**
 * The match state machine:
 *
 *   lobby ──(enough players)──► countdown ──(timer)──► playing
 *     ▲                                                   │
 *     └────(too few players)── ended ◄──(win condition)───┘
 *                                │
 *                                └──(timer)──► countdown (next round)
 *
 * Entering `countdown` is when the round is reset: scores, health, positions,
 * ball, items, projectiles, zone ownership. `playing` is when win conditions
 * are watched. `ended` shows the winner, then loops.
 *
 * With `phases.enabled` false the id is pinned to `playing` and this system
 * does nothing — the endless sandbox.
 */

/** True while players may not steer (pre-round countdown, winner screen). */
export function isMovementLocked(phase: PhaseState): boolean {
  return phase.id === 'countdown' || phase.id === 'ended';
}

/**
 * True when gameplay counts: scoring, tagging, damage, laps, goals.
 * Always true when phases are disabled; false during lobby warm-up.
 */
export function isRoundActive(phase: PhaseState, config: SimConfig): boolean {
  return config.phases.enabled ? phase.id === 'playing' : true;
}

export function updatePhase(ctx: StepContext): void {
  const rules = ctx.config.phases;
  if (!rules.enabled) return;

  switch (ctx.phase.id) {
    case 'lobby':
      if (ctx.players.length >= rules.minPlayers) {
        startCountdown(ctx);
      }
      break;

    case 'countdown':
      if (ctx.tick >= ctx.phase.endTick) {
        transition(ctx, 'playing', rules.playTicks > 0 ? ctx.tick + rules.playTicks : 0);
      }
      break;

    case 'playing':
      checkWinConditions(ctx);
      break;

    case 'ended':
      if (ctx.tick >= ctx.phase.endTick) {
        if (ctx.players.length < rules.minPlayers) {
          transition(ctx, 'lobby', 0);
        } else {
          ctx.phase.round += 1;
          startCountdown(ctx);
        }
      }
      break;
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function startCountdown(ctx: StepContext): void {
  resetRound(ctx);
  transition(ctx, 'countdown', ctx.tick + ctx.config.phases.countdownTicks);
}

function transition(ctx: StepContext, id: PhaseId, endTick: number): void {
  ctx.phase.id = id;
  ctx.phase.endTick = endTick;
  if (id === 'countdown') {
    ctx.phase.winnerId = '';
    ctx.phase.winnerTeam = TEAM_NONE;
  }
  ctx.out.push({ type: 'phaseChanged', phase: id, round: ctx.phase.round });
}

/**
 * Puts every mutable bit of round state back to its starting value. Called on
 * entering `countdown`, so each round starts identical no matter what the
 * previous one did.
 */
function resetRound(ctx: StepContext): void {
  const { config } = ctx;

  ctx.players.forEach((player, index) => {
    if (config.phases.resetScoresOnRoundStart) player.score = 0;
    player.hp = config.combat.maxHp;
    player.lives = config.combat.lives;
    player.role = ROLE_NONE;
    player.checkpoint = 0;
    player.lap = 0;
    player.effects = {};
    const spawn = spawnPosition(config, index);
    player.x = spawn.x;
    player.z = spawn.z;
    player.vx = 0;
    player.vz = 0;
  });

  ctx.teamScores.fill(0);

  if (ctx.ball) {
    ctx.ball.x = 0;
    ctx.ball.z = 0;
    ctx.ball.vx = 0;
    ctx.ball.vz = 0;
  }

  ctx.projectiles.length = 0;

  ctx.items.forEach((item, index) => {
    const spec = config.items[index];
    item.x = spec?.homeX ?? 0;
    item.z = spec?.homeZ ?? 0;
    item.carrierId = '';
    item.returnTick = 0;
    item.atHome = true;
  });

  for (const zone of ctx.zones) {
    zone.ownerTeam = TEAM_NONE;
    zone.ownerId = '';
  }

  for (const pickup of ctx.pickups) {
    pickup.active = true;
    pickup.respawnTick = 0;
  }
}

function checkWinConditions(ctx: StepContext): void {
  const rules = ctx.config.phases;
  const teams = ctx.config.teams.count;

  // First to the target score.
  if (rules.targetScore > 0) {
    if (teams >= 2) {
      for (let team = 0; team < ctx.teamScores.length; team++) {
        if ((ctx.teamScores[team] ?? 0) >= rules.targetScore) {
          return endRound(ctx, '', team);
        }
      }
    } else {
      for (const player of ctx.players) {
        if (player.score >= rules.targetScore) {
          return endRound(ctx, player.id, TEAM_NONE);
        }
      }
    }
  }

  // Last one standing (only meaningful with limited lives).
  if (ctx.config.combat.enabled && ctx.config.combat.lives > 0 && ctx.players.length >= 2) {
    const alive = ctx.players.filter((player) => player.lives > 0);
    if (alive.length <= 1) {
      const survivor = alive[0];
      return endRound(ctx, survivor?.id ?? '', survivor?.team ?? TEAM_NONE);
    }
  }

  // Infection: nobody left to infect → round over, highest score wins.
  if (ctx.config.tag.enabled && ctx.config.tag.variant === 'spread' && ctx.players.length >= 2) {
    const anyInfected = ctx.players.some((player) => player.role !== ROLE_NONE);
    const uninfected = ctx.players.filter((player) => player.role === ROLE_NONE);
    if (anyInfected && uninfected.length === 0) {
      return endRound(ctx, bestPlayer(ctx.players), TEAM_NONE);
    }
  }

  // Time up: highest score wins (team score first when teams exist).
  if (rules.playTicks > 0 && ctx.phase.endTick > 0 && ctx.tick >= ctx.phase.endTick) {
    if (teams >= 2) {
      return endRound(ctx, '', bestTeam(ctx.teamScores));
    }
    return endRound(ctx, bestPlayer(ctx.players), TEAM_NONE);
  }
}

function endRound(ctx: StepContext, winnerId: string, winnerTeam: number): void {
  ctx.phase.winnerId = winnerId;
  ctx.phase.winnerTeam = winnerTeam;
  transition(ctx, 'ended', ctx.tick + ctx.config.phases.endTicks);
}

/** Highest-scoring player id, or '' on a tie for first. */
function bestPlayer(players: StepContext['players']): string {
  let best = '';
  let bestScore = -1;
  let tied = false;
  for (const player of players) {
    if (player.score > bestScore) {
      best = player.id;
      bestScore = player.score;
      tied = false;
    } else if (player.score === bestScore) {
      tied = true;
    }
  }
  return tied ? '' : best;
}

/** Highest-scoring team index, or TEAM_NONE on a tie for first. */
function bestTeam(teamScores: readonly number[]): number {
  let best = TEAM_NONE;
  let bestScore = -1;
  let tied = false;
  for (let team = 0; team < teamScores.length; team++) {
    const score = teamScores[team] ?? 0;
    if (score > bestScore) {
      best = team;
      bestScore = score;
      tied = false;
    } else if (score === bestScore) {
      tied = true;
    }
  }
  return tied ? TEAM_NONE : best;
}
