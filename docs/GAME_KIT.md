# The Game Kit — reference

Everything in `src/sim/systems/` that a game can be assembled from. Each
system is **driven entirely by its section of `SimConfig`** and is inert at
the defaults — turning things on is how you make a game. For step-by-step
walkthroughs, read [`RECIPES.md`](./RECIPES.md); this file is the reference.

**The one-sentence summary: most new games are a config, not new code.**

## The eleven built-in modes

Every mode is a named `SimConfig` preset in `src/sim/presets.ts` with display
metadata in `src/shared/modes.ts`. Launch any of them with `?mode=<id>` (the
lobby also has a picker). Two tabs, zero setup:

```
http://localhost:5173/?net=broadcast&room=demo&mode=tag
```

| id          | Game                                       | Systems it exercises                    |
| ----------- | ------------------------------------------ | --------------------------------------- |
| `gather`    | Endless shard sandbox (the default)        | pickups                                 |
| `rush`      | Timed shard race, first to 25              | phases                                  |
| `tag`       | Classic tag — don't be it                  | tag, phases                             |
| `infection` | Tag spreads; survivors score               | tag(spread), phases                     |
| `hill`      | King of the hill; shots shove, never hurt  | zones(hill), projectiles, phases        |
| `race`      | Checkpoint laps, first to 3                | zones(checkpoint), phases               |
| `arena`     | FFA blaster fight, first to 10 KOs         | projectiles, combat, powerups           |
| `knockout`  | 3 lives, last one standing                 | projectiles, combat(lives)              |
| `soccer`    | 2 teams push a ball into goals, first to 5 | teams, ball, zones(goal)                |
| `ctf`       | Capture the flag with blasters, first to 3 | teams, items(flag), zones(base), combat |
| `crown`     | Hold the crown to score, steal by touch    | items(crown), phases                    |

`?bots=N` fills the room with bots on launch; the host's HUD also has a
"+ Bot" button. Bots understand every system and are deliberately beatable.

## Systems

Pipeline order inside `World.step()` (fixed on purpose — determinism):

```
phase → bot inputs → movement → player collisions → combat(respawns) → tag
      → projectiles → ball → items → zones → pickups → effect pruning
```

### Phases — `systems/phase.ts`, config `phases`

The match state machine: `lobby → countdown → playing → ended → countdown…`.
Entering `countdown` resets the round (scores, hp, positions, ball, items,
projectiles, zone ownership, pickups). Win conditions checked while playing:

- `targetScore` reached (team score when teams exist, else player score);
- last player standing (when `combat.lives > 0`);
- everyone infected (when `tag.variant === 'spread'`);
- `playTicks` expired → highest score wins, ties are a draw.

Winner lands in `phase.winnerId` / `phase.winnerTeam`; the HUD shows it.
`isMovementLocked(phase)` is true during `countdown`/`ended` — movement obeys
it automatically. `isRoundActive(phase, config)` gates scoring; systems
already call it, and warm-up play in the lobby is free and scoreless.

With `phases.enabled: false` the id is pinned to `playing` forever — the
sandbox default.

### Effects — `systems/effects.ts`, no config section

Timed statuses on players: `effects: Record<effectId, expiryTick>`. Active
while `tick < expiry`. **Adding a new effect id is not a protocol change** —
snapshots, wire codec and checksum carry the whole map.

| id       | behaviour (already wired in)                                  |
| -------- | ------------------------------------------------------------- |
| `speed`  | × `powerups.speedMultiplier` movement                         |
| `shield` | blocks damage and tags                                        |
| `frozen` | cannot move                                                   |
| `stun`   | cannot move                                                   |
| `ko`     | out of play; respawns when it expires (combat system)         |
| `safe`   | cannot be tagged, damaged or robbed (grace after tag/spawn)   |
| `reload` | cannot fire until it expires                                  |
| `carry`  | × `itemRules.carrySpeedMultiplier` (refreshed while carrying) |

API: `addEffect(player, id, untilTick)` (extends, never shortens),
`hasEffect`, `clearEffect`, `effectRemaining`, `isImmobilized`, `isProtected`,
`isKnockedOut`, `movementScale`. The render layer shows: it-glow, frozen tint,
KO fade, protection blink (`entities.ts#applyStatus`); the effect ids reach it
through `RenderPlayer.effects`.

### Combat — `systems/combat.ts`, config `combat`

`applyDamage(ctx, target, amount, byId)` is the single entry point — call it
from any system (projectiles do). Zero hp → `ko` effect until
`respawnTicks` later, then respawn at the spawn ring with `safe` protection.
`lives > 0` turns it into elimination: the last KO never expires and the phase
system ends the round. `koScore` pays the attacker (and their team).

### Projectiles — `systems/projectiles.ts`, config `projectiles`

Hold `BUTTON_PRIMARY` to fire in your facing direction (on a phone: the way
you are running — no aim thumb needed). Cooldown via the `reload` effect.
Shots are absorbed by walls and obstacles, always knock targets back, and
deal damage only while a round is active and combat is enabled — lobby
shoot-outs are harmless. No friendly fire in team modes.

### Tag — `systems/tag.ts`, config `tag`

Self-healing role assignment: whenever a round is active, at least 2 players
exist and nobody is it, one is picked (world RNG — deterministic). Touch
transfers (`variant: 'transfer'`) or spreads (`'spread'`). The **tagger**
gets `safe` grace so the tag cannot bounce straight back. Survivors earn
`survivorScorePerSecond`; `tagScore` optionally pays per tag.
`role === ROLE_IT` marks the it/infected player everywhere (HUD, renderer).

### Ball — `systems/ball.ts`, config `ball`

One arcade ball: touching kicks it away from you (plus half your momentum),
walls/obstacles bounce with `restitution`, friction stops it. A `goal` zone
belongs to the team defending it (`zone.team`); the ball entering scores for
the other team, credits the last toucher (unless it was an own goal), resets
the ball to centre. Needs `teams.count: 2`.

### Zones — config `zones` (list of `ZoneSpec`) + `zoneRules`

Static circles on the floor; what each does is its `kind`:

- `hill` — sole occupant (or sole occupying team) owns it and earns
  `hillScorePerSecond`; contested pays nobody. Ownership is in
  `ZoneRuntimeState` and rendered as the disc's colour.
- `checkpoint` — race gates crossed in `order` (0,1,2…). A full circuit is a
  lap: `lapScore` points. Set `phases.targetScore` to laps-to-win. The local
  player's next gate glows.
- `goal` — see ball. `base` — see items.

### Items — config `items` (list of `ItemSpec`) + `itemRules`

Carryable objects that follow their carrier and drop on KO:

- `flag` (has a `team`): enemies take it by touch; your own dropped flag
  returns home when you touch it (or after `returnTicks`). Carry it into one
  of your `base` zones → `deliverScore`.
- `crown` (neutral): anyone takes it, **touching the carrier steals it**
  (grace: `stealGraceTicks`), holding pays `carryScorePerSecond`.

Carriers get the `carry` effect (slower) and render with the item overhead.

### Bots — `systems/bots.ts`, config `bots`

`world.addBot()` / `removeBot()` (host-only via `session.addBot()`). Bots are
ordinary players with `isBot: true`, simulated inside `step()`, so they
survive host migration through the snapshot. The behaviour reads the config:
chase/flee in tag, push the ball at the enemy goal, fetch and deliver flags,
hunt and shoot in arena, run checkpoints, collect pickups, wander. Pure
functions of world state — **no RNG stream use**, so bots never perturb arena
generation. `bots.speedMultiplier` keeps them beatable.

Bot ids start `zz-bot-` so they sort after real peer ids and never win host
election (they are not peers at all).

### Pickups — `systems/pickups.ts`, config `pickupWeights` + `powerups`

Four kinds, chosen by weight at world creation: `score` (points), `speed`,
`shield` (timed effects), `heal` (hp). Rendered in distinct colours
(gold/cyan/purple/green).

### Teams — config `teams`

`count: 2` assigns joiners to the smallest team. `teamScores` accumulates
KOs, goals, deliveries, hill seconds and score pickups; the phase system
checks it for the win. Team names/colours for the UI live in
`TEAM_INFO` (`src/shared/modes.ts`).

## The state-carrying contract

If you add **any mutable simulation state** — a field on a player, a new
entity list — it must appear in ALL of:

1. `src/sim/types.ts` — the state type and `WorldSnapshot`;
2. `World`: initialisation, `snapshot()`, `applySnapshot()`, `checksum()`;
3. `src/net/protocol.ts` — encode (quantize floats) and validate (assume the
   sender is hostile), and bump `PROTOCOL_VERSION`;
4. `src/net/view.ts` + `ClientView.sample()` — if the renderer or HUD needs
   to see it.

`tests/unit/sim/world.snapshot.test.ts` (every system on) and
`tests/unit/sim/presets.test.ts` (every mode, 300 ticks, restore, resume)
fail if you miss step 2. Protocol tests fail on step 3.

**Timed state should be an effect** (one map entry) rather than a new field —
then steps 1–4 are already done.

## Inputs and buttons

`PlayerInput.buttons` is a bitfield: `BUTTON_PRIMARY` (Space / `J` / the
on-screen **A** button) and `BUTTON_SECONDARY` (`E` / `K` / **B**, currently
unused — reserved for your ability). Wiring order for a new ability:

1. Read the bit in your system: `player.input.buttons & BUTTON_SECONDARY`.
2. Show the button on phones: set `usesPrimaryAction` /
   `usesSecondaryAction` in the mode's metadata. Nothing else — the wire,
   prediction, touch and keyboard already carry both bits.

Movement axes carry analog magnitude: half-stick is half speed. The
`sprint` flag comes from Shift or pushing the stick to its rim.

## Sound and haptics

`src/render/audio.ts` synthesises every sound with WebAudio (no files):
score blips, power-ups, tags, KOs, goals, laps, countdown ticks, "GO!", the
round-end fanfare. The announcer classifies each announcement with an
`AnnouncerCue`, and `main.ts` maps cues to sounds and vibration — to give a
new mechanic audio, emit a cue from the announcer (or reuse one). `?mute=1`
silences everything for quiet demos.

## Events vs. state diffing

`world.events` (`SimEvents`) fire **only on the host** — the peer stepping
the authoritative world. Use them for headless tests and host-side logic.
Anything the player must SEE on every screen is driven by state:
`src/ui/announcer.ts` diffs successive `RenderState`s (roles, effects,
team scores, crown possession, phase) into toasts, and the HUD renders phase,
timers, team scores and vitals directly from `RenderState`. Extend those two
files when a new thing needs announcing.

## Mode metadata and URLs

`src/shared/modes.ts` holds id, title, tagline, goal line,
`usesPrimaryAction`, and `suggestedPlayers` per mode — the lobby picker, HUD
goal line and touch buttons read it. The mode id is appended to the transport
room name (`main.ts#createTransport`), so peers with different configs can
never meet — that guarantee is what keeps prediction sane. A unit test pins
metadata ids and preset ids together.
