import type { StepContext } from '../step.js';
import { NEVER_TICK, type PlayerId, type PlayerState } from '../types.js';
import { addEffect, clearEffect, isProtected } from './effects.js';
import { spawnPosition } from './arena.js';

/**
 * Health, knockouts, respawns and elimination.
 *
 * Combat itself is deliberately generic: damage comes from other systems
 * (projectiles today; melee, hazards or explosions tomorrow) which call
 * `applyDamage`. This system's per-tick job is only to respawn players whose
 * KO has expired.
 *
 * A knocked-out player carries the `ko` effect, whose expiry tick IS the
 * respawn moment. Elimination (out of lives) is a `ko` that never expires;
 * the phase system starts the next round, which clears it.
 */

/**
 * Applies damage, KO'ing the player when hp reaches zero.
 * Returns true when the hit landed (not shielded / already out / warm-up).
 */
export function applyDamage(
  ctx: StepContext,
  target: PlayerState,
  amount: number,
  byId: PlayerId,
): boolean {
  const rules = ctx.config.combat;
  if (!rules.enabled) return false;
  if (isProtected(target, ctx.tick)) return false;

  target.hp -= amount;
  if (target.hp > 0) return true;

  target.hp = 0;
  if (rules.lives > 0) {
    target.lives = Math.max(0, target.lives - 1);
  }

  const eliminated = rules.lives > 0 && target.lives === 0;
  addEffect(target, 'ko', eliminated ? NEVER_TICK : ctx.tick + rules.respawnTicks);
  target.vx = 0;
  target.vz = 0;

  // The attacker scores the KO — including eliminations.
  if (byId !== target.id) {
    const attacker = ctx.players.find((player) => player.id === byId);
    if (attacker) {
      attacker.score += rules.koScore;
      if (attacker.team >= 0 && attacker.team < ctx.teamScores.length) {
        ctx.teamScores[attacker.team] = (ctx.teamScores[attacker.team] ?? 0) + rules.koScore;
      }
    }
  }

  ctx.out.push({ type: 'playerKnockedOut', playerId: target.id, byId });
  return true;
}

/** Respawns players whose KO timer has run out. Call once per tick. */
export function updateCombat(ctx: StepContext): void {
  if (!ctx.config.combat.enabled) return;

  ctx.players.forEach((player, index) => {
    const koUntil = player.effects['ko'];
    if (koUntil === undefined || ctx.tick < koUntil) return;

    clearEffect(player, 'ko');
    player.hp = ctx.config.combat.maxHp;
    const spawn = spawnPosition(ctx.config, index);
    player.x = spawn.x;
    player.z = spawn.z;
    player.vx = 0;
    player.vz = 0;
    addEffect(player, 'safe', ctx.tick + ctx.config.combat.spawnProtectionTicks);
    ctx.out.push({ type: 'playerRespawned', playerId: player.id });
  });
}
