import { clamp, clampMagnitude2, distanceSq2 } from '../../shared/math.js';
import { tickDeltaSeconds } from '../config.js';
import type { StepContext } from '../step.js';
import { TEAM_NONE } from '../types.js';
import { isKnockedOut } from './effects.js';
import { isRoundActive } from './phase.js';

/**
 * A single pushable ball, for soccer-likes.
 *
 * Deliberately arcade physics: touching the ball kicks it away from you (plus
 * some of your own momentum), walls and obstacles bounce it with restitution,
 * and friction bleeds it to a stop. No spin, no vertical axis — readable on a
 * phone screen and cheap to keep deterministic.
 *
 * Goals are zones of kind `goal`: the ball entering a goal scores for the
 * OTHER team (`zone.team` defends it), then the ball resets to centre.
 */
export function updateBall(ctx: StepContext): void {
  const rules = ctx.config.ball;
  const ball = ctx.ball;
  if (!rules.enabled || !ball) return;

  const dt = tickDeltaSeconds(ctx.config);

  // Kicks first, so a kick this tick moves the ball this tick.
  const touchRange = ctx.config.playerRadius + rules.radius;
  const touchRangeSq = touchRange * touchRange;
  for (const player of ctx.players) {
    if (isKnockedOut(player, ctx.tick)) continue;
    const distSq = distanceSq2(player.x, player.z, ball.x, ball.z);
    if (distSq > touchRangeSq) continue;

    let nx: number;
    let nz: number;
    if (distSq > 1e-12) {
      const dist = Math.sqrt(distSq);
      nx = (ball.x - player.x) / dist;
      nz = (ball.z - player.z) / dist;
    } else {
      // Dead centre: kick along the player's facing so the result is defined.
      nx = Math.sin(player.heading);
      nz = Math.cos(player.heading);
    }

    ball.vx = nx * rules.kickImpulse + player.vx * 0.5;
    ball.vz = nz * rules.kickImpulse + player.vz * 0.5;
    ball.lastTouchId = player.id;

    // Separate so the ball is not re-kicked every tick while overlapping.
    ball.x = player.x + nx * (touchRange + 0.01);
    ball.z = player.z + nz * (touchRange + 0.01);
  }

  // Integrate with friction.
  const decay = Math.max(0, 1 - rules.friction * dt);
  ball.vx *= decay;
  ball.vz *= decay;
  const capped = clampMagnitude2(ball.vx, ball.vz, rules.maxSpeed);
  ball.vx = capped.x;
  ball.vz = capped.y;
  ball.x += ball.vx * dt;
  ball.z += ball.vz * dt;

  bounceOffWalls(ctx, dt);
  bounceOffObstacles(ctx);
  checkGoals(ctx);
}

function bounceOffWalls(ctx: StepContext, _dt: number): void {
  const ball = ctx.ball;
  if (!ball) return;
  const rules = ctx.config.ball;
  const limitX = ctx.config.arenaHalfExtentX - rules.radius;
  const limitZ = ctx.config.arenaHalfExtentZ - rules.radius;

  if (ball.x < -limitX) {
    ball.x = -limitX;
    ball.vx = Math.abs(ball.vx) * rules.restitution;
  } else if (ball.x > limitX) {
    ball.x = limitX;
    ball.vx = -Math.abs(ball.vx) * rules.restitution;
  }

  if (ball.z < -limitZ) {
    ball.z = -limitZ;
    ball.vz = Math.abs(ball.vz) * rules.restitution;
  } else if (ball.z > limitZ) {
    ball.z = limitZ;
    ball.vz = -Math.abs(ball.vz) * rules.restitution;
  }
}

function bounceOffObstacles(ctx: StepContext): void {
  const ball = ctx.ball;
  if (!ball) return;
  const rules = ctx.config.ball;

  for (const o of ctx.obstacles) {
    const nearestX = clamp(ball.x, o.x - o.halfX, o.x + o.halfX);
    const nearestZ = clamp(ball.z, o.z - o.halfZ, o.z + o.halfZ);
    const dx = ball.x - nearestX;
    const dz = ball.z - nearestZ;
    const distSq = dx * dx + dz * dz;
    if (distSq >= rules.radius * rules.radius || distSq < 1e-12) continue;

    const dist = Math.sqrt(distSq);
    const nx = dx / dist;
    const nz = dz / dist;
    ball.x = nearestX + nx * rules.radius;
    ball.z = nearestZ + nz * rules.radius;

    const into = ball.vx * nx + ball.vz * nz;
    if (into < 0) {
      ball.vx -= (1 + rules.restitution) * into * nx;
      ball.vz -= (1 + rules.restitution) * into * nz;
    }
  }
}

function checkGoals(ctx: StepContext): void {
  const ball = ctx.ball;
  if (!ball) return;
  if (ctx.config.teams.count < 2) return;

  for (const zone of ctx.config.zones) {
    if (zone.kind !== 'goal') continue;
    if (distanceSq2(ball.x, ball.z, zone.x, zone.z) > zone.radius * zone.radius) continue;

    if (isRoundActive(ctx.phase, ctx.config) && zone.team !== TEAM_NONE) {
      // `zone.team` defends this goal; everyone else shares the score. With
      // two teams that is simply "the other team".
      const scoringTeam = ctx.config.teams.count === 2 ? 1 - zone.team : TEAM_NONE;
      if (scoringTeam !== TEAM_NONE) {
        const score = ctx.config.zoneRules.goalScore;
        ctx.teamScores[scoringTeam] = (ctx.teamScores[scoringTeam] ?? 0) + score;

        // Personal credit for the scorer — unless it was an own goal.
        const scorer = ctx.players.find((player) => player.id === ball.lastTouchId);
        if (scorer && scorer.team === scoringTeam) scorer.score += score;

        ctx.out.push({ type: 'goalScored', team: scoringTeam, byId: ball.lastTouchId });
      }
    }

    ball.x = 0;
    ball.z = 0;
    ball.vx = 0;
    ball.vz = 0;
    ball.lastTouchId = '';
  }
}
