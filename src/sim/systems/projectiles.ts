import { distanceSq2 } from '../../shared/math.js';
import { tickDeltaSeconds } from '../config.js';
import type { StepContext } from '../step.js';
import { BUTTON_PRIMARY, type PlayerState, type ProjectileState } from '../types.js';
import { isBlocked } from './arena.js';
import { addEffect, hasEffect, isImmobilized, isProtected } from './effects.js';
import { applyImpulse } from './movement.js';
import { applyDamage } from './combat.js';
import { isMovementLocked, isRoundActive } from './phase.js';

/**
 * Straight-line projectiles fired with the primary action button.
 *
 * Players fire in the direction they are facing (their `heading`), which on a
 * phone means "the way you are running" — no aiming thumb required. Hits
 * always knock the target back; they only deal damage while a round is
 * actually being played (and only when combat is enabled), so warm-up
 * shoot-outs are harmless fun.
 *
 * Projectile ids are derived from `tick * 64 + shooter index`, which is
 * unique without needing an id counter in the snapshot.
 */
export function updateProjectiles(ctx: StepContext): void {
  const rules = ctx.config.projectiles;
  if (!rules.enabled) return;

  spawnFromInputs(ctx);
  moveAndCollide(ctx);
}

function spawnFromInputs(ctx: StepContext): void {
  const rules = ctx.config.projectiles;
  if (isMovementLocked(ctx.phase)) return;

  ctx.players.forEach((player, index) => {
    if ((player.input.buttons & BUTTON_PRIMARY) === 0) return;
    if (isImmobilized(player, ctx.tick)) return;
    if (hasEffect(player, 'reload', ctx.tick)) return;
    if (ctx.projectiles.length >= rules.maxLive) return;

    const dirX = Math.sin(player.heading);
    const dirZ = Math.cos(player.heading);
    const muzzle = ctx.config.playerRadius + rules.radius + 0.1;

    const projectile: ProjectileState = {
      id: ctx.tick * 64 + index,
      ownerId: player.id,
      team: player.team,
      x: player.x + dirX * muzzle,
      z: player.z + dirZ * muzzle,
      vx: dirX * rules.speed,
      vz: dirZ * rules.speed,
      bornTick: ctx.tick,
    };

    ctx.projectiles.push(projectile);
    addEffect(player, 'reload', ctx.tick + rules.cooldownTicks);
    ctx.out.push({ type: 'projectileFired', projectileId: projectile.id, ownerId: player.id });
  });
}

function moveAndCollide(ctx: StepContext): void {
  const rules = ctx.config.projectiles;
  const dt = tickDeltaSeconds(ctx.config);
  const dealDamage = isRoundActive(ctx.phase, ctx.config);
  const survivors: ProjectileState[] = [];

  for (const projectile of ctx.projectiles) {
    if (ctx.tick >= projectile.bornTick + rules.lifetimeTicks) continue;

    projectile.x += projectile.vx * dt;
    projectile.z += projectile.vz * dt;

    // Walls and obstacles absorb shots.
    if (
      Math.abs(projectile.x) > ctx.config.arenaHalfExtentX ||
      Math.abs(projectile.z) > ctx.config.arenaHalfExtentZ ||
      isBlocked(projectile.x, projectile.z, rules.radius, ctx.obstacles)
    ) {
      continue;
    }

    const target = findHit(ctx, projectile);
    if (target) {
      const speed = Math.hypot(projectile.vx, projectile.vz);
      if (speed > 0) {
        applyImpulse(
          target,
          (projectile.vx / speed) * rules.knockback,
          (projectile.vz / speed) * rules.knockback,
        );
      }
      if (dealDamage) {
        applyDamage(ctx, target, rules.damage, projectile.ownerId);
      }
      continue;
    }

    survivors.push(projectile);
  }

  ctx.projectiles = survivors;
}

function findHit(ctx: StepContext, projectile: ProjectileState): PlayerState | null {
  const hitRange = ctx.config.projectiles.radius + ctx.config.playerRadius;
  const hitRangeSq = hitRange * hitRange;

  for (const player of ctx.players) {
    if (player.id === projectile.ownerId) continue;
    // No friendly fire in team modes.
    if (projectile.team >= 0 && player.team === projectile.team) continue;
    if (isProtected(player, ctx.tick)) continue;
    if (distanceSq2(player.x, player.z, projectile.x, projectile.z) > hitRangeSq) continue;
    return player;
  }
  return null;
}
