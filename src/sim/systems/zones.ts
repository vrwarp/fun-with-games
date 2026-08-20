import { distanceSq2 } from '../../shared/math.js';
import type { StepContext } from '../step.js';
import { TEAM_NONE, type PlayerState } from '../types.js';
import { isKnockedOut } from './effects.js';
import { isRoundActive } from './phase.js';

/**
 * Zone occupancy and scoring.
 *
 * - `hill`: king of the hill. The sole occupant (free-for-all) or the sole
 *   occupying team owns it and earns `hillScorePerSecond`; a contested hill
 *   pays nobody. Ownership lives in `ZoneRuntimeState` so every peer can
 *   render it.
 * - `checkpoint`: race gates crossed in `order`. Completing the full circuit
 *   increments `lap` and pays `lapScore` — set `phases.targetScore` to the
 *   number of laps to make it a race.
 *
 * `goal` zones are consumed by the ball system and `base` zones by the item
 * system; this file ignores both.
 */
export function updateZones(ctx: StepContext): void {
  if (ctx.config.zones.length === 0) return;
  const active = isRoundActive(ctx.phase, ctx.config);

  updateHills(ctx, active);
  if (active) updateCheckpoints(ctx);
}

function updateHills(ctx: StepContext, active: boolean): void {
  const payTick = ctx.tick > 0 && ctx.tick % ctx.config.tickRate === 0;
  const perSecond = ctx.config.zoneRules.hillScorePerSecond;

  ctx.config.zones.forEach((spec, zoneId) => {
    if (spec.kind !== 'hill') return;
    const runtime = ctx.zones[zoneId];
    if (!runtime) return;

    const occupants = playersInside(ctx, spec.x, spec.z, spec.radius);
    const previousOwnerId = runtime.ownerId;
    const previousOwnerTeam = runtime.ownerTeam;

    if (occupants.length === 0) {
      runtime.ownerId = '';
      runtime.ownerTeam = TEAM_NONE;
    } else if (ctx.config.teams.count >= 2) {
      const team = occupants[0]?.team ?? TEAM_NONE;
      const contested = occupants.some((player) => player.team !== team);
      runtime.ownerTeam = contested ? TEAM_NONE : team;
      runtime.ownerId = '';
    } else {
      runtime.ownerId = occupants.length === 1 ? (occupants[0]?.id ?? '') : '';
      runtime.ownerTeam = TEAM_NONE;
    }

    const ownerChanged =
      runtime.ownerId !== previousOwnerId || runtime.ownerTeam !== previousOwnerTeam;
    if (ownerChanged && (runtime.ownerId !== '' || runtime.ownerTeam !== TEAM_NONE)) {
      ctx.out.push({
        type: 'zoneCaptured',
        zoneId,
        ownerId: runtime.ownerId,
        ownerTeam: runtime.ownerTeam,
      });
    }

    if (!active || !payTick || perSecond <= 0) return;

    if (runtime.ownerTeam !== TEAM_NONE) {
      ctx.teamScores[runtime.ownerTeam] = (ctx.teamScores[runtime.ownerTeam] ?? 0) + perSecond;
      // The occupants share the credit on their personal scores too.
      for (const player of occupants) player.score += perSecond;
    } else if (runtime.ownerId !== '') {
      const owner = occupants.find((player) => player.id === runtime.ownerId);
      if (owner) owner.score += perSecond;
    }
  });
}

function updateCheckpoints(ctx: StepContext): void {
  const checkpoints = ctx.config.zones.filter((zone) => zone.kind === 'checkpoint');
  if (checkpoints.length === 0) return;
  const circuit = checkpoints.length;

  for (const player of ctx.players) {
    if (isKnockedOut(player, ctx.tick)) continue;

    const next = checkpoints.find((zone) => zone.order === player.checkpoint);
    if (!next) continue;
    if (distanceSq2(player.x, player.z, next.x, next.z) > next.radius * next.radius) continue;

    player.checkpoint += 1;
    if (player.checkpoint >= circuit) {
      player.checkpoint = 0;
      player.lap += 1;
      player.score += ctx.config.zoneRules.lapScore;
      ctx.out.push({ type: 'lapCompleted', playerId: player.id, lap: player.lap });
    }
  }
}

function playersInside(ctx: StepContext, x: number, z: number, radius: number): PlayerState[] {
  const radiusSq = radius * radius;
  return ctx.players.filter(
    (player) =>
      !isKnockedOut(player, ctx.tick) && distanceSq2(player.x, player.z, x, z) <= radiusSq,
  );
}
