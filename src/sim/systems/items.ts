import { distanceSq2 } from '../../shared/math.js';
import type { ItemSpec } from '../config.js';
import type { StepContext } from '../step.js';
import { TEAM_NONE, type ItemState, type PlayerState } from '../types.js';
import { supportHeight } from './arena.js';
import { addEffect, isKnockedOut, isProtected } from './effects.js';
import { isRoundActive } from './phase.js';

/**
 * Carryable items: flags (capture the flag) and crowns (keep-away).
 *
 * - A **flag** belongs to a team. Enemies pick it up by touching it; touching
 *   your own dropped flag sends it home. Carrying an enemy flag into one of
 *   your own `base` zones delivers it for `deliverScore`.
 * - A **crown** is neutral. Anyone may take it, touching the carrier steals
 *   it, and holding it pays `carryScorePerSecond`.
 *
 * A carrier gets the `carry` effect (refreshed every tick) so movement slows
 * by `carrySpeedMultiplier`, and `safe` for `stealGraceTicks` after taking, so
 * possession cannot ping-pong within a single collision. Dropping happens on
 * knock-out; dropped items snap home after `returnTicks`.
 */
export function updateItems(ctx: StepContext): void {
  if (ctx.items.length === 0) return;
  const active = isRoundActive(ctx.phase, ctx.config);

  for (const item of ctx.items) {
    const spec = ctx.config.items[item.id];
    if (!spec) continue;

    if (item.carrierId !== '') {
      updateCarried(ctx, item, spec, active);
    }
    if (item.carrierId === '') {
      updateLoose(ctx, item, spec);
    }
  }
}

// ---------------------------------------------------------------------------

function updateCarried(ctx: StepContext, item: ItemState, spec: ItemSpec, active: boolean): void {
  const carrier = ctx.players.find((player) => player.id === item.carrierId);

  // Carrier vanished (left the room) or got knocked out: drop on the spot.
  if (!carrier || isKnockedOut(carrier, ctx.tick)) {
    drop(ctx, item, carrier ?? null);
    return;
  }

  item.x = carrier.x;
  item.z = carrier.z;
  item.y = carrier.y;
  item.atHome = false;
  // Refreshed each tick rather than open-ended, so a stale entry can never
  // outlive the carry (snapshots stay truthful).
  addEffect(carrier, 'carry', ctx.tick + 2);

  if (spec.kind === 'crown') {
    stealOnContact(ctx, item, carrier);
    if (active) scoreCrown(ctx, carrier);
    return;
  }

  // Flag: deliver by standing in one of your own bases.
  if (active && isInOwnBase(ctx, carrier)) {
    const score = ctx.config.itemRules.deliverScore;
    carrier.score += score;
    if (carrier.team >= 0 && carrier.team < ctx.teamScores.length) {
      ctx.teamScores[carrier.team] = (ctx.teamScores[carrier.team] ?? 0) + score;
    }
    ctx.out.push({ type: 'itemDelivered', itemId: item.id, playerId: carrier.id, score });
    sendHome(ctx, item, spec);
  }
}

function updateLoose(ctx: StepContext, item: ItemState, spec: ItemSpec): void {
  // Timed auto-return for dropped items.
  if (!item.atHome && item.returnTick > 0 && ctx.tick >= item.returnTick) {
    sendHome(ctx, item, spec);
  }

  const reach = ctx.config.playerRadius + 0.6;
  const reachSq = reach * reach;

  for (const player of ctx.players) {
    if (isKnockedOut(player, ctx.tick)) continue;
    if (distanceSq2(player.x, player.z, item.x, item.z) > reachSq) continue;
    if (ctx.config.platform.enabled && Math.abs(player.y - item.y) >= ctx.config.playerHeight) {
      continue;
    }

    if (spec.kind === 'flag' && spec.team !== TEAM_NONE) {
      if (player.team === spec.team) {
        // Your own flag: touching it returns it (no effect while at home).
        if (!item.atHome) sendHome(ctx, item, spec);
        continue;
      }
    }

    take(ctx, item, player);
    return;
  }
}

function stealOnContact(ctx: StepContext, item: ItemState, carrier: PlayerState): void {
  const reach = ctx.config.playerRadius * 2 + 0.2;
  const reachSq = reach * reach;
  if (isProtected(carrier, ctx.tick)) return;

  for (const player of ctx.players) {
    if (player.id === carrier.id) continue;
    if (isKnockedOut(player, ctx.tick)) continue;
    if (distanceSq2(player.x, player.z, carrier.x, carrier.z) > reachSq) continue;

    take(ctx, item, player);
    return;
  }
}

function scoreCrown(ctx: StepContext, carrier: PlayerState): void {
  const perSecond = ctx.config.itemRules.carryScorePerSecond;
  if (perSecond <= 0) return;
  if (ctx.tick === 0 || ctx.tick % ctx.config.tickRate !== 0) return;
  carrier.score += perSecond;
  if (carrier.team >= 0 && carrier.team < ctx.teamScores.length) {
    ctx.teamScores[carrier.team] = (ctx.teamScores[carrier.team] ?? 0) + perSecond;
  }
}

function isInOwnBase(ctx: StepContext, player: PlayerState): boolean {
  return ctx.config.zones.some(
    (zone) =>
      zone.kind === 'base' &&
      zone.team === player.team &&
      distanceSq2(player.x, player.z, zone.x, zone.z) <= zone.radius * zone.radius,
  );
}

function take(ctx: StepContext, item: ItemState, player: PlayerState): void {
  item.carrierId = player.id;
  item.returnTick = 0;
  item.atHome = false;
  item.x = player.x;
  item.z = player.z;
  item.y = player.y;
  addEffect(player, 'safe', ctx.tick + ctx.config.itemRules.stealGraceTicks);
  ctx.out.push({ type: 'itemTaken', itemId: item.id, playerId: player.id });
}

function drop(ctx: StepContext, item: ItemState, carrier: PlayerState | null): void {
  const carrierId = item.carrierId;
  item.carrierId = '';
  item.returnTick = ctx.tick + ctx.config.itemRules.returnTicks;
  item.atHome = false;
  if (carrier) {
    item.x = carrier.x;
    item.z = carrier.z;
    item.y = carrier.y;
  }
  ctx.out.push({ type: 'itemDropped', itemId: item.id, playerId: carrierId });
}

function sendHome(ctx: StepContext, item: ItemState, spec: ItemSpec): void {
  item.x = spec.homeX;
  item.z = spec.homeZ;
  item.y = ctx.config.platform.enabled
    ? supportHeight(spec.homeX, spec.homeZ, 0.5, ctx.obstacles, Number.POSITIVE_INFINITY)
    : 0;
  item.carrierId = '';
  item.returnTick = 0;
  item.atHome = true;
}
