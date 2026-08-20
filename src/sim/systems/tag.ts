import { distanceSq2 } from '../../shared/math.js';
import type { StepContext } from '../step.js';
import { ROLE_IT, ROLE_NONE } from '../types.js';
import { addEffect, isKnockedOut, isProtected } from './effects.js';
import { isRoundActive } from './phase.js';

/**
 * Tag and infection.
 *
 * One player is "it" (`role === ROLE_IT`). Touching a non-it player passes
 * the role on (`variant: 'transfer'`) or spreads it (`variant: 'spread'` —
 * infection). A freshly tagged player gets the `safe` effect for a moment so
 * the tag cannot bounce straight back.
 *
 * Scoring is survival: everyone who is not it earns
 * `survivorScorePerSecond`, so at the end of a timed round the player who
 * spent the least time as it wins. `tagScore` optionally rewards the tagger.
 *
 * The system self-heals: whenever a round is active and nobody is it (round
 * just started, or the it player left), it picks one at random — which also
 * makes it the single place initial roles are assigned.
 */
export function updateTag(ctx: StepContext): void {
  const rules = ctx.config.tag;
  if (!rules.enabled) return;
  if (!isRoundActive(ctx.phase, ctx.config)) return;

  ensureSomeoneIsIt(ctx);
  transferOnContact(ctx);
  scoreSurvivors(ctx);
}

function ensureSomeoneIsIt(ctx: StepContext): void {
  if (ctx.players.length < 2) return;
  if (ctx.players.some((player) => player.role === ROLE_IT)) return;

  const eligible = ctx.players.filter((player) => !isKnockedOut(player, ctx.tick));
  if (eligible.length === 0) return;

  const chosen = ctx.rng.pick(eligible);
  chosen.role = ROLE_IT;
  ctx.out.push({ type: 'playerTagged', playerId: chosen.id, byId: '' });
}

function transferOnContact(ctx: StepContext): void {
  const rules = ctx.config.tag;
  // Collision resolution separates players to exactly 2r, so the tag reach
  // needs a little slack beyond that or contact would never register.
  const reach = ctx.config.playerRadius * 2 + 0.2;
  const reachSq = reach * reach;

  for (let i = 0; i < ctx.players.length; i++) {
    for (let j = i + 1; j < ctx.players.length; j++) {
      const a = ctx.players[i];
      const b = ctx.players[j];
      if (!a || !b) continue;

      const aIt = a.role === ROLE_IT;
      const bIt = b.role === ROLE_IT;
      if (aIt === bIt) continue;

      const tagger = aIt ? a : b;
      const target = aIt ? b : a;
      if (isProtected(target, ctx.tick)) continue;
      if (isKnockedOut(tagger, ctx.tick)) continue;
      if (distanceSq2(a.x, a.z, b.x, b.z) > reachSq) continue;

      target.role = ROLE_IT;
      if (rules.variant === 'transfer') tagger.role = ROLE_NONE;
      // Grace goes to the TAGGER: they are standing right next to the new
      // "it" and would otherwise be tagged straight back next tick.
      addEffect(tagger, 'safe', ctx.tick + rules.graceTicks);
      tagger.score += rules.tagScore;
      ctx.out.push({ type: 'playerTagged', playerId: target.id, byId: tagger.id });
    }
  }
}

function scoreSurvivors(ctx: StepContext): void {
  const perSecond = ctx.config.tag.survivorScorePerSecond;
  if (perSecond <= 0) return;
  if (ctx.tick === 0 || ctx.tick % ctx.config.tickRate !== 0) return;
  // Nobody scores before roles exist (the first eligible tick assigns them).
  if (!ctx.players.some((player) => player.role === ROLE_IT)) return;

  for (const player of ctx.players) {
    if (player.role === ROLE_IT) continue;
    if (isKnockedOut(player, ctx.tick)) continue;
    player.score += perSecond;
  }
}
