# Recipes — building a game on the kit, fast

This file is the playbook for turning "let's make X" into a running game with
the least code and the fewest mistakes. It is ordered by effort:

- **Tier 0 — zero code.** The game already exists; it is a URL.
- **Tier 1 — a preset.** New rules from existing systems: one entry in two
  files, ~10 minutes.
- **Tier 2 — a new mechanic.** New simulation code, done the way the kit
  expects: worked recipes below, ~30–60 minutes each.

Read [`GAME_KIT.md`](./GAME_KIT.md) for what each system does. Read the
checklists at the bottom **before** touching simulation state.

---

## Tier 0 — games you already have

```
npm run dev
```

| Want                 | Open                              |
| -------------------- | --------------------------------- |
| Tag                  | `http://localhost:5173/?mode=tag` |
| Infection / zombies  | `?mode=infection`                 |
| Shooter free-for-all | `?mode=arena`                     |
| Last one standing    | `?mode=knockout`                  |
| Soccer               | `?mode=soccer`                    |
| Capture the flag     | `?mode=ctf`                       |
| King of the hill     | `?mode=hill`                      |
| Lap race             | `?mode=race`                      |
| Keep-away            | `?mode=crown`                     |
| Timed shard race     | `?mode=rush`                      |

Multiplayer without a second machine: add `&net=broadcast&room=demo` and open
two tabs. Opponents without a second player: add `&bots=3`, or tap **+ Bot**
in the HUD (host only). Skip the lobby with `&autojoin=1`.

**Demo tip:** the phone experience is the point of this project. Run
`npm run dev -- --host`, open the LAN URL on a phone, and the thumbstick,
auto-camera and action button are already there.

---

## Tier 1 — a new game as a preset

Most "new games" are a new combination of systems. Three edits, no new logic:

### Worked example: "Sharks and Minnows"

One shark (it) hunts; minnows score by surviving; speed pickups everywhere;
90-second rounds. That is tag with different numbers:

**1. `src/shared/modes.ts`** — add the id and the card players see:

```ts
export type GameModeId = /* … existing … */ | 'sharks';

// in GAME_MODES:
{
  id: 'sharks',
  title: 'Sharks & Minnows',
  tagline: 'One shark. Everyone else swims for it.',
  goal: 'Survive to score. The shark converts minnows on touch.',
  usesPrimaryAction: false,
  suggestedPlayers: 3,
},
```

**2. `src/sim/presets.ts`** — add the config:

```ts
sharks: {
  tag: { enabled: true, variant: 'spread', graceTicks: 60 },
  phases: { enabled: true, minPlayers: 3, playTicks: seconds(90) },
  playerMaxSpeed: 10,            // everyone is faster — pure chaos
  pickupCount: 8,
  pickupWeights: { score: 0, speed: 1, shield: 0, heal: 0 },
},
```

**3. Run `npm test`.** `tests/unit/sim/presets.test.ts` sweeps _every_ mode id
through 300 deterministic ticks plus a snapshot round-trip, so your new mode
is covered the moment it exists. The lobby picker, `?mode=sharks`, bots and
the HUD goal line all pick it up automatically.

That is the whole change. Some more one-preset games to steal:

| Game            | Preset sketch                                                                                                                                                                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Juggernaut      | `tag` transfer + `combat`+`projectiles`; being it is good: `tag: { tagScore: 0, survivorScorePerSecond: 0 }`, give it hill-style points via a `hill` zone only it can... simpler: `zoneRules.hillScorePerSecond` + small hill, it fights to hold it |
| Golden goal     | `soccer` with `phases: { targetScore: 1 }` — first goal wins the round                                                                                                                                                                              |
| Hoarders        | `gather` + `phases` + `combat`+`projectiles`: KO drops nothing but stops the collector — attrition race                                                                                                                                             |
| Team hill       | `hill` + `teams: { count: 2 }` — the zone system already scores teams                                                                                                                                                                               |
| Team blasters   | `arena` + `teams: { count: 2 }` — team KO totals win (no friendly fire, already handled)                                                                                                                                                            |
| Snail race      | `race` + `playerMaxSpeed: 5`, no obstacles, tiny checkpoints                                                                                                                                                                                        |
| Crown of thorns | `crown` + `combat`+`projectiles`: shoot the carrier to make them drop it (KO drops are built in)                                                                                                                                                    |

Numbers to remember: ticks are 1/30s — use the `seconds(n)` helper already in
`presets.ts`. Zone/item coordinates must fit the arena (`±24` by default).

---

## Tier 2 — new mechanics, the worked recipes

Each recipe lists every file it touches. They are written against the current
code and compile as shown. **Write the headless test first or alongside** —
`npm run test:watch` gives you a sub-second loop.

### Recipe: a dash ability on the secondary button

The button, wire format, prediction and touch UI already exist — a dash is
pure simulation. Files: `config.ts`, one new system, `world.ts`, `main.ts`
(one flag), a test.

**1. `src/sim/config.ts`** — two flat tunables (flat keys merge with zero
ceremony):

```ts
// in SimConfig:
/** Dash: impulse in world units/second. 0 disables the dash. */
readonly dashImpulse: number;
readonly dashCooldownTicks: number;

// in DEFAULT_SIM_CONFIG:
dashImpulse: 0,
dashCooldownTicks: 45,
```

**2. `src/sim/systems/dash.ts`** — new file:

```ts
import type { StepContext } from '../step.js';
import { BUTTON_SECONDARY } from '../types.js';
import { addEffect, hasEffect, isImmobilized } from './effects.js';
import { applyImpulse } from './movement.js';
import { isMovementLocked } from './phase.js';

/** A burst of speed in the facing direction, on the secondary button. */
export function updateDash(ctx: StepContext): void {
  if (ctx.config.dashImpulse <= 0 || isMovementLocked(ctx.phase)) return;

  for (const player of ctx.players) {
    if ((player.input.buttons & BUTTON_SECONDARY) === 0) continue;
    if (isImmobilized(player, ctx.tick)) continue;
    if (hasEffect(player, 'dashcd', ctx.tick)) continue;

    applyImpulse(
      player,
      Math.sin(player.heading) * ctx.config.dashImpulse,
      Math.cos(player.heading) * ctx.config.dashImpulse,
    );
    addEffect(player, 'dashcd', ctx.tick + ctx.config.dashCooldownTicks);
  }
}
```

The cooldown is an **effect**, so it is snapshotted, transmitted, checksummed
and predicted with zero extra work. The impulse survives the speed cap because
`integratePlayer` lets over-cap speed bleed off gradually.

**3. `src/sim/world.ts`** — one call, after `resolvePlayerCollisions`:

```ts
updateDash(ctx); //       burst movement before combat interactions
```

**4. Show the button on phones** — in `main.ts`, the `TouchButtons`
construction: `new TouchButtons(app, { primary: mode.usesPrimaryAction, secondary: true })`
(or add a `usesSecondaryAction` field to `GameModeInfo` next to
`usesPrimaryAction` and thread it through — 3 lines). Keyboard `E`/`K`
already works.

**5. Test** (`tests/unit/sim/dash.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import { makeSimConfig } from '@/sim/config.js';
import { BUTTON_SECONDARY } from '@/sim/types.js';
import { World } from '@/sim/world.js';

it('dashes forward and then cools down', () => {
  const world = new World({
    seed: 1,
    config: makeSimConfig({ obstacleCount: 0, pickupCount: 0, dashImpulse: 15 }),
  });
  const p = world.addPlayer('a', { name: 'a', color: '#fff' });
  Object.assign(p, { x: 0, z: 0, heading: 0 }); // facing +Z
  world.setInput('a', { seq: 1, moveX: 0, moveZ: 0, sprint: false, buttons: BUTTON_SECONDARY });

  world.step();
  const speedAfterDash = Math.hypot(p.vx, p.vz);
  expect(speedAfterDash).toBeGreaterThan(10);

  // Held button must not chain-dash during the cooldown.
  world.step();
  expect(Math.hypot(p.vx, p.vz)).toBeLessThanOrEqual(speedAfterDash);
});
```

No snapshot work (the cooldown is an effect), no protocol work (buttons
already travel). `npm run verify` and you are done.

### Recipe: freeze tag

Extends the tag system: tagged players freeze in place; teammates unfreeze
them by touch; the it player wins by freezing everyone.

1. **`src/sim/config.ts`** — widen the variant:
   `readonly variant: 'transfer' | 'spread' | 'freeze';`
2. **`src/sim/systems/tag.ts`** — in `transferOnContact`, for `'freeze'`:
   the target gets `addEffect(target, 'frozen', NEVER_TICK)` and KEEPS
   `role: ROLE_NONE`; the it player keeps `ROLE_IT`. Add a second pass:
   a non-frozen, non-it player touching a frozen one clears the effect
   (`clearEffect(other, 'frozen')`) and grants both brief `safe`.
3. **`src/sim/systems/phase.ts`** — win condition next to the infection one:
   variant `'freeze'` and every non-it player frozen → `endRound(ctx, itId, TEAM_NONE)`.
4. **Scoring**: `survivorScorePerSecond` already skips immobilized players?
   It does not — add `if (hasEffect(player, 'frozen', ctx.tick)) continue;`
   to `scoreSurvivors`.
5. Preset `freeze` (metadata + preset entry, as in Tier 1), test like
   `tag.test.ts` — force roles, teleport, assert the frozen effect and the
   unfreeze.

The `frozen` effect already stops movement, renders as an ice tint, and
announces itself ("❄ Frozen!") — steps you do NOT have to write.

### Recipe: a shrinking storm circle (battle-royale pressure)

Key trick: the radius is **derived from the tick**, so there is _no new
mutable state_ — no snapshot, protocol or checksum work at all.

1. **`src/sim/config.ts`** flat keys: `stormStartTicks`, `stormShrinkTicks`
   (0 disables), `stormDamagePerSecond`.
2. **`src/sim/systems/storm.ts`**:

```ts
import { distance2 } from '../../shared/math.js';
import type { SimConfig } from '../config.js';
import type { StepContext } from '../step.js';
import { applyDamage } from './combat.js';
import { isRoundActive } from './phase.js';

/** Current safe radius — a pure function of the tick, so nothing to snapshot. */
export function stormRadius(config: SimConfig, tick: number): number {
  const full = Math.min(config.arenaHalfExtentX, config.arenaHalfExtentZ);
  if (config.stormShrinkTicks <= 0) return full;
  const progress = (tick - config.stormStartTicks) / config.stormShrinkTicks;
  const clamped = Math.min(1, Math.max(0, progress));
  return full * (1 - 0.85 * clamped); // never quite zero
}

export function updateStorm(ctx: StepContext): void {
  if (ctx.config.stormShrinkTicks <= 0) return;
  if (!isRoundActive(ctx.phase, ctx.config)) return;
  if (ctx.tick % ctx.config.tickRate !== 0) return; // damage once per second

  const radius = stormRadius(ctx.config, ctx.tick);
  for (const player of ctx.players) {
    if (distance2(player.x, player.z, 0, 0) > radius) {
      applyDamage(ctx, player, ctx.config.stormDamagePerSecond, '');
    }
  }
}
```

3. One call in `world.ts` (after `updateCombat`). Phase-tick note: the round
   starts at a nonzero tick, so measure from round start if rounds repeat —
   store nothing; use `ctx.phase.endTick - config.phases.playTicks` as the
   round's start tick.
4. **Visual** (`src/render/kitviews.ts`): a translucent disc whose scale
   tracks `stormRadius(config, state.tick)` — the renderer may compute it
   because it is a pure function of config + tick, both of which it has.
5. Combine with `knockout` for a real battle royale.

### Recipe: melee swipe instead of projectiles

For a mode where shooting feels wrong (tag with a bat, "bonk"):
copy the shape of `projectiles.ts#spawnFromInputs` into a new
`systems/melee.ts` — on `BUTTON_PRIMARY` + no `reload`: every enemy within
`playerRadius * 3` AND in front (`dot(facing, toTarget) > 0.5`) takes
`applyDamage` + `applyImpulse` knockback; `addEffect(player, 'reload', …)`.
No entity list, so no snapshot work. ~40 lines + a test.

### Recipe: a brand-new effect (e.g. `magnet` that pulls pickups)

1. Grant it somewhere: a pickup kind (`pickupWeights` + a case in
   `updatePickups`), or a zone, or an ability.
2. Implement the behaviour where it acts — e.g. in `updatePickups`, before
   collection: pickups within 6u of a `magnet` player drift toward them
   (mutate `pickup.x/z`… beware: pickup positions ARE snapshotted state, and
   they already are — nothing new to add).
3. That's it. The map carries any id matching `/^[a-z][a-z0-9_-]{0,23}$/`.

### Recipe: painting territory (ambitious — only with time to spare)

A Splatoon-lite needs a tile grid: `paint: Uint8Array`-like state per cell.
That is a NEW snapshotted collection → full checklist below applies (types,
world, protocol with a size ceiling, checksum, RenderState, a renderer that
updates a dynamic texture). Budget 2–3 hours; do it after everything else
works.

---

## Checklists

### Adding a tunable (no new state)

- [ ] Field in `SimConfig` + `DEFAULT_SIM_CONFIG` (flat, or in a section —
      sections also need `SimConfigOverrides` + `makeSimConfig` if new).
- [ ] Read it via `ctx.config` / passed config. Never import the default.

### Adding mutable simulation state (the full ritual)

- [ ] Type + `WorldSnapshot` in `src/sim/types.ts`.
- [ ] `World`: init, `snapshot()`, `applySnapshot()`, `checksum()`.
- [ ] `src/net/protocol.ts`: encode (quantize floats) + hostile validation
      with a size ceiling; bump `PROTOCOL_VERSION` (never reuse a number).
- [ ] `src/net/view.ts` + `ClientView.sample()` if it must be drawn.
- [ ] Turn the system on in `world.snapshot.test.ts`'s kitchen-sink config.
- [ ] `npm test` — the snapshot, determinism and preset sweeps confirm.

**Shortcut that skips this whole list:** timed, per-player state → use an
effect. Derived-from-tick state → compute it, store nothing.

### Adding an input/ability

- [ ] Read `player.input.buttons` in the system (bits already travel).
- [ ] Phone affordance: flip `usesPrimaryAction` in the mode metadata, or add
      the secondary button in `main.ts`. **Keyboard-only is not done** (§7).
- [ ] Cooldowns are `reload`-style effects, not new fields.

### Adding announcements / HUD

- [ ] Visible-to-everyone feedback = diff `RenderState` in
      `src/ui/announcer.ts` (never sim events — those are host-only).
- [ ] Persistent UI (scores, timers, vitals) = `src/ui/hud.ts`, driven only
      by `RenderState` + `HudStatus`.
- [ ] Anything tappable: ≥ 44px, `touch-action: none` if it handles drags.

---

## Layer traps (the mistakes that cost demos)

| Trap                                                   | Instead                                                                    |
| ------------------------------------------------------ | -------------------------------------------------------------------------- |
| `Math.random()` / `Date.now()` in `src/sim`            | `ctx.rng` (snapshotted) or derive from `ctx.tick`. The linter blocks you.  |
| Iterating `Map`s or unsorted arrays in sim             | `ctx.players` is sorted; keep any new collection deterministically ordered |
| New mutable field, forgot the snapshot                 | The ritual above; or make it an effect                                     |
| Gameplay decided in the renderer ("mesh touched mesh") | All rules live in `src/sim`; the renderer only draws `RenderState`         |
| Sim events for player-facing UI                        | They fire on the host only — diff `RenderState` in the announcer           |
| A keyboard-only ability                                | Buttons bitfield + `TouchButtons` — see the dash recipe                    |
| Testing gameplay through Playwright                    | `World` + `SessionHarness` in Vitest; e2e is for rendering and DOM         |
| Editing `DEFAULT_SIM_CONFIG` to tune one mode          | Presets override; the default stays the sandbox                            |
| Widening `decodeMessage` to accept a broken message    | Fix the sender; the parser stays total                                     |

---

## The demo runbook

```bash
npm run dev                    # localhost:5173 — add ?mode=…&bots=…
npm run dev -- --host          # same, reachable from a phone on the LAN
npm run test:watch             # the sub-second loop while writing sim code
npm run verify                 # before saying "done" (format+lint+types+tests+build)
npm run test:e2e               # only when render/ui/main/transports changed
```

Fast sanity for any mode, no browser:

```ts
import { modeConfig } from '@/sim/presets.js';
import { World } from '@/sim/world.js';
const world = new World({ seed: 1, config: modeConfig('yourmode') });
world.addPlayer('a', { name: 'a', color: '#fff' });
world.addBot();
world.stepMany(600);
console.log(
  world.phase,
  world.players().map((p) => [p.id, p.score]),
);
```

Multiplayer sanity: two tabs on `?net=broadcast&room=x&mode=yourmode`.
Host-migration sanity: close the first tab, watch the second take over
(bots included — they ride the snapshot).
