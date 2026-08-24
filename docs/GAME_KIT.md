# The Game Kit — reference

Everything in `src/sim/systems/` that a game can be assembled from. Each
system is **driven entirely by its section of `SimConfig`** and is inert at
the defaults — turning things on is how you make a game. For step-by-step
walkthroughs, read [`RECIPES.md`](./RECIPES.md); this file is the reference.

**The one-sentence summary: most new games are a config, not new code.**

## The sixteen built-in modes

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

Two of them are races with cars rather than runners. They are ordinary presets
too — the new ingredient is a handling model and a centreline:

| id          | Game                                      | Systems it exercises             |
| ----------- | ----------------------------------------- | -------------------------------- |
| `grandprix` | Six laps, slipstream, DRS, tyres and pits | vehicle, track, race, zones(all) |
| `street`    | Five laps of a tight city lap, seen flat  | vehicle, track, race(tow), zones |

The last three ship a non-3D projection. They are ordinary presets — the only
new ingredients are gravity and a camera angle:

| id           | Game                                        | Look                 |
| ------------ | ------------------------------------------- | -------------------- |
| `platformer` | Shard Climb: run, jump, collect off ledges  | 2D side-on, sprites  |
| `skirmish`   | Top-Down Skirmish: blaster duel on a plane  | 2D overhead, sprites |
| `dungeon`    | Isometric Dungeon: infection through a maze | 2.5D isometric       |

`?bots=N` fills the room with bots on launch; the host's HUD also has a
"+ Bot" button. Bots understand every system and are deliberately beatable.

## 2D, 2.5D and 3D

**The simulation has always been a plane.** Positions are `(x, z)`; there is
no perspective, no camera and no third dimension anywhere in `src/sim`. That
means a 2D game is not a port or a special case here — it is the _default_
model, and "3D" is a choice the renderer makes about how to photograph it.

Three independent knobs decide what a game looks like:

| Knob                      | Where                                   | Synced?               |
| ------------------------- | --------------------------------------- | --------------------- |
| **View** (camera framing) | mode metadata `view`, or `?view=`       | No — per player       |
| **Sprites** (art style)   | mode metadata `sprites`, or `?sprites=` | No — per player       |
| **Gravity** (`platform`)  | `SimConfig.platform`                    | **Yes** — it is rules |

### Views — `src/render/views.ts`

| `view`    | Reads as         | Camera                                            | Status     |
| --------- | ---------------- | ------------------------------------------------- | ---------- |
| `first`   | first person     | perspective, in the player's own head             | supported  |
| `iso`     | 2.5D isometric   | orthographic 45° diagonal; chases a car's heading | supported  |
| `follow`  | 3D third-person  | perspective, swings behind you, drag-able         | deprecated |
| `topdown` | flat 2D          | orthographic, almost straight down                | deprecated |
| `side`    | 2D side-scroller | orthographic, level with the z = 0 lane           | deprecated |

**Two of the five are what the game is designed around.** The reason is
steering. A car's axes are read in the car's own frame, so a camera parked at
a fixed angle inverts them every time the car drives back toward it — press
left, watch it go right, for half of every lap. `first` cannot do that (the
eye is bolted to the chassis) and `iso` no longer does either:
`viewFollowsHeading()` orbits it behind a car while leaving it fixed on foot,
where the stick is already camera-relative and a rotating world would only be
disorienting. The projection and down-angle are untouched, so it stays
isometric — a rotating isometric, which is what overhead racing games have
always used.

The other three still work. `?view=` accepts them everywhere, so links already
shared keep resolving, and `viewsFor()` still offers a mode the view it is
defined by — a side-scroller is not a side-scroller from any other angle. What
they no longer get is a place in a picker they are not the default of, or
design attention.

`first` is the one view built differently. `ArcRotateCamera` orbits a target
rather than looking forward from a point, so a cockpit is made by aiming the
target down the road and orbiting from exactly that far back — which lands the
camera on the player's head (`ViewSpec.eye`, and `radius` must equal
`lookahead - forward` or the eye slides out of the car). Nothing about it is
smoothed: a head is bolted to its chassis, and the easing that makes a chase
camera feel operated makes a first-person one feel seasick. The eye sits just
behind the cockpit, where a broadcast puts its onboard camera and for the same
reason — from the driver's actual eyeline the car is a slab across the bottom
of the frame. The local player's name label is hidden (a billboard at zero
distance fills the screen) and so is their body, unless it is a car, because
the nose and front wheels ahead of you are the whole appeal.

View is **presentation only**: it never reaches the simulation and is not part
of the room name, so `?view=topdown` on any mode is always safe — two players
in the same match may legitimately use different projections. That makes it
the fastest demo trick in the kit:

```
?mode=arena&view=iso          # the shooter as 2.5D isometric
?mode=grandprix&view=first    # onboard, from the cockpit
?mode=street&view=first       # the street race from inside the car
?mode=soccer&view=topdown     # deprecated, but still resolves
```

The lobby has a **Camera** picker covering the same ground, and the in-game
**Settings** panel changes it mid-match without a reload — a view you can only
reach by typing a query string is a view a phone player does not have.

Input stays correct in every view automatically **on foot**: movement is
rotated by `cameraYaw`, so "up" is always "away from the camera", and the fixed
views simply have a fixed yaw. A car is the exception and is handled the other
way round — the input stays in the car's frame and the _camera_ moves to match,
which is why the supported views are the two that can do that. Orthographic framing is recomputed on every resize
because Babylon's ortho box is absolute, not aspect-derived.

Manual camera control belongs to `follow` alone — an isometric camera you can
drag off its axis is no longer isometric.

### Sprites — `src/render/textures.ts`

`sprites: true` swaps the 3D capsule for a camera-facing billboard drawn with
a procedurally generated pixel-art texture (tinted per player, nearest-neighbour
sampled, alpha-cut so overlaps do not halo). Status effects still show: they
tint the sprite through `emissiveColor` instead of swapping a diffuse colour.
No binaries are involved, so this works on a fresh clone like everything else.

### Gravity and platforms — `systems/movement.ts`, config `platform`

This one **is** simulation, so it is part of the mode's rules and must match
across peers. With `platform.enabled` false — the default, and the case for
fifteen of the sixteen shipped modes — every player's `y` stays 0 and the
code path is exactly the flat game that existed before the axis did.

Switched on, you get:

- **Gravity and terminal velocity**, integrated after horizontal movement.
- **Jumping** on the button named by `jumpButton`, firing on the press _edge_
  (a held button cannot bunny-hop), with `maxJumps` for double jumps and
  `airControl` weakening mid-air steering.
- **Standable geometry.** Every `Obstacle` spans `[baseY, top]`. Ground-level
  boxes are walls you can also stand on; a `baseY` above 0 is a floating
  platform you can jump onto _and walk under_. `SimConfig.platforms` lists
  hand-placed ones (a platformer level is exactly that list).
- **Heights on everything that needs one**: shards rest on whatever surface is
  beneath them and cannot be grabbed through a floor, shots fly level so
  storeys do not shoot each other, carried items ride their carrier.
- **`lockZ`** pins players to the z = 0 lane and discards depth input, which
  is what makes a side-scroller genuinely two-dimensional.

Not vertical, on purpose: the **ball** and **zones** stay on the ground plane.
Soccer and king-of-the-hill are ground games, and giving them a Y axis would
buy complexity nobody asked for. If you need a bouncing ball, that is a real
feature — write it, do not fake it.

⚠️ **One conflict to know about:** `platform.jumpButton` defaults to
`'primary'`, which is also the fire button. A mode that wants both jumping and
shooting must set `jumpButton: 'secondary'` (and `usesSecondaryAction: true`
in its metadata), or one press will do both.

## Systems

Pipeline order inside `World.step()` (fixed on purpose — determinism):

```
phase → bot inputs → movement → player collisions → combat(respawns) → tag
      → projectiles → ball → items → zones → race → pickups → effect pruning
```

### Racecraft — `systems/race.ts`, `systems/zones.ts`, `systems/bots.ts`

Four things that decide whether a race reads as a race, each of them a number
you can measure rather than an opinion.

**A lap ends at the line.** `trackGates` puts gate 0 at track distance 0 for
exactly that reason, and `checkpoint` counts gates cleared this lap — running
0 … _circuit_ rather than wrapping, so "back at the line having done the lap"
cannot be confused with "sat on the grid". Counting the wrap as the car leaves
the _last_ gate instead takes that final section off the lap counter, off every
lap time, and off where the chequered flag falls; on a nine-gate circuit that
is a ninth of the race.

**The slipstream has to be earned.** Being near a car is not being in its tow:
a wake sits directly behind, so `race.slipstreamAlignment` requires the pair to
be pointed the same way — true down a straight, false through a corner, where
the follower is beside the wake rather than in it. Without it the tow is simply
on for most of a lap, and a tow that is always on is everyone's top speed.

**Bots have styles.** `botStyle()` hashes the bot's id into a corner
confidence, a lift margin and a tyre life at which that driver starts looking
for the pit entry. Hashed rather than drawn from the RNG, deliberately: the
shared random stream is simulation state, and a bot consuming from it would
make every other outcome depend on how many bots happened to be in the room.
The confidence is spread _around_ the traction limit rather than under it, so
some drivers do run wide — a field where nobody makes a mistake is a field
nobody can catch.

**Bots can also rejoin and pit**, which sounds minor and is not. A bot aims a
lookahead distance up the centreline; off the road, that aim point is also off
the road, so a stranded car drives happily parallel to the tarmac for the rest
of the race. Off-track it therefore aims at the road itself, at a fixed short
distance and a steady throttle — the cornering model must not be asked to do
the steering there, because it reads the bend over the aim distance and an aim
distance that short reads as a hairpin whatever the road is doing.

**Tyre wear is a gradient, not a cliff.** Wear is a function of time, so a
stint the race can outlast leaves cars on dead rubber — and a car on dead
rubber cannot corner, leaves the road, and cannot get back. `grandprix` sets a
stint a little longer than the race for that reason: the car is about a third
worse at the flag than at the lights, and nobody is ever driving on nothing.
Measured across three seeds, a stint the race outlasts puts the field in the
scenery 32% of the time; one that outlasts the race puts it there 5%, which is
what it is with no wear at all.

> **Still open.** A _mandatory_ pit stop is not there yet, and cannot be until
> the pit AI is better than it is: bots find the entry by proximity, so whether
> one makes it in is partly luck. Wear that bites hard enough to force a stop
> therefore strands the field. The natural next step is wear that depends on
> how hard the car is driven rather than on the clock, so that an aggressive
> driver needs a stop and a smooth one does not — which is the strategy layer,
> and is its own piece of work.

### Engine sound — `src/render/enginesound.ts`

Synthesised, like every other sound here — no samples, no network. An engine
is a good fit for that because it genuinely _is_ a periodic noise source: the
firing frequency of a running engine is `rpm / 60 × cylinders / 2`, so a
sawtooth at that frequency with its harmonics shaped by a filter is not an
impression of an engine, it is the same construction.

Three things make it read as an engine rather than a tone:

- **Pitch follows RPM, not road speed.** Those differ because of the gearbox,
  and the difference is the whole sound of accelerating: the note climbs, drops
  on the shift, climbs again. `gearFor()` spreads six ratios so low gears are
  short and high ones long. Tie pitch straight to speed and you get a siren.
- **Load shapes the timbre.** A car pulling hard and a car coasting are at the
  same RPM and sound nothing alike, so the filter opens with load and closes on
  a lift. Load is measured, not read: a rival's throttle is not transmitted
  (and should not be), but how its speed is changing says the same thing.
- **Doppler is computed.** WebAudio used to do this and both
  `PannerNode.setVelocity` and `AudioListener.dopplerFactor` were **removed**
  from the spec and from browsers, so `dopplerRatio()` applies
  `f' = f (c + vr) / (c + vs)` to the oscillator frequency directly. Only
  motion _along the line between the two_ counts, which is why a car crossing
  your path is briefly unshifted — the moment its pitch audibly falls through.

Rivals get an HRTF `PannerNode`; your own car does not, because you never move
relative to your own engine and it has no direction to come from. The listener
rides on **the car, not the camera** — an isometric camera sits 34 units back,
and hearing the race from up there would put a rival alongside you a
bus-length away — while its orientation comes from the camera so that left and
right match the screen. The scene is left-handed and WebAudio is not, so every
z is negated on the way across.

Voices are capped at the nearest few and culled beyond 90 units: HRTF panning
is not free and a phone is the primary target.

### Contact — `systems/movement.ts`, config `collision`

Overlapping players are always pushed apart. Whether the contact also _costs_
anything is `collision.enabled`, and it is **off by default**: you should not
be able to shoulder-barge a rival into a wall in `tag`, so every non-racing
mode keeps separation alone.

Turned on, a touch gets the physics an impact actually has. Masses are equal —
a grid of identical cars is what the racing modes are — which collapses the
impulse to a clean half-and-half exchange.

| Key           | What it decides                                                                                                                                           |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `restitution` | Bounciness. 0 is a dead thud that leaves the pair travelling together; 1 is a snooker ball. Cars want the thud end.                                       |
| `friction`    | Sideways bite. 0 lets rivals slide past each other for free; above 0 running wheel-to-wheel scrubs both cars.                                             |
| `spin`        | Yaw from that bite. A body is a disc, so a blow through the centre cannot spin it — but a scrape drags one flank and not the other, and that is a torque. |

This runs on the host only. A client predicting its own car cannot see where
anyone else is this tick, so the impulse arrives with the next snapshot — the
right trade, because a shunt is exactly the moment a player expects to be
shoved around by the world, and predicting it against a stale rival position
would invent contacts that never happened.

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
| `tow`    | × `race.slipstreamMultiplier` (refreshed while in the tow)    |
| `drs`    | × `race.drsMultiplier` while the wing is open                 |
| `drsok`  | the wing may be opened (HUD/renderer only; no behaviour)      |
| `tyre`   | remaining tyre life; its duration IS the wear                 |

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
- `drs` — a stretch where a car within `race.drsGapSeconds` of the one ahead
  may open its wing. `pit` — the pit lane: speed is capped at
  `race.pitSpeedLimit` inside it and tyres are refitted.

### Items — config `items` (list of `ItemSpec`) + `itemRules`

Carryable objects that follow their carrier and drop on KO:

- `flag` (has a `team`): enemies take it by touch; your own dropped flag
  returns home when you touch it (or after `returnTicks`). Carry it into one
  of your `base` zones → `deliverScore`.
- `crown` (neutral): anyone takes it, **touching the carrier steals it**
  (grace: `stealGraceTicks`), holding pays `carryScorePerSecond`.

Carriers get the `carry` effect (slower) and render with the item overhead.

### Bots — `systems/bots.ts`, config `bots`

Bots jump when gravity is on: they hop obstacles in their path, reach for
shards resting above them, and hop when they stall against their target. The
logic is deliberately crude — a bot that reliably makes progress beats a
clever one that occasionally strands itself on a ledge.

`world.addBot()` / `removeBot()` (host-only via `session.addBot()`). Bots are
ordinary players with `isBot: true`, simulated inside `step()`, so they
survive host migration through the snapshot. The behaviour reads the config:
chase/flee in tag, push the ball at the enemy goal, fetch and deliver flags,
hunt and shoot in arena, run checkpoints, collect pickups, wander. Pure
functions of world state — **no RNG stream use**, so bots never perturb arena
generation. `bots.speedMultiplier` keeps them beatable.

Bot ids start `zz-bot-` so they sort after real peer ids and never win host
election (they are not peers at all).

**Bots and players write to the same control contract**, and that is a
correctness measure rather than tidiness. `moveX`/`moveZ` mean two different
things depending on the mode — a direction in the world on foot, steering and
throttle in the car's own frame with `vehicle.enabled` — and the choice used to
be made independently in `systems/bots.ts` and in `main.ts`. Two answers to one
question is a bug that cannot be caught: whichever half is wrong passes every
test the other half runs, so an inverted player stick sails through a green bot
suite and only a human at a phone ever finds out.

`src/sim/controls.ts` now owns it. `usesVehicleAxes(config)` is the single
predicate (the render layer asks it to decide whether to rotate a device's axes
by the camera yaw); `axesForDirection()` turns a wanted world direction into
whichever pair of axes the mode reads; `INPUT_DEADZONE` is one floor rather
than one per device. Because it is pure `src/sim`, a headless test can drive a
NON-bot player through the very same function a thumb reaches —
`tests/unit/sim/controls.test.ts` races one round a circuit and checks that
inverting the lock, or swapping the two axes, stops it dead.

### Pickups — `systems/pickups.ts`, config `pickupWeights` + `powerups`

Four kinds, chosen by weight at world creation: `score` (points), `speed`,
`shield` (timed effects), `heal` (hp). Rendered in distinct colours
(gold/cyan/purple/green).

### Teams — config `teams`

`count: 2` assigns joiners to the smallest team. `teamScores` accumulates
KOs, goals, deliveries, hill seconds and score pickups; the phase system
checks it for the win. Team names/colours for the UI live in
`TEAM_INFO` (`src/shared/modes.ts`).

### Racing — `systems/vehicle.ts`, `systems/race.ts`, `track.ts`

The one place the kit swaps its movement model. With `vehicle.enabled` the
stick stops being a direction and becomes **two separate controls in the car's
own frame**:

```
  moveX  −1 … +1   steering, full left to full right
  moveZ  +1 … −1   throttle, then coast at 0, then brake and reverse
```

They are independent, which is the point — a driver holds a steering angle
through a corner while deciding separately how much throttle to carry, and a
single "point there" vector cannot express that. Because the axes are read in
the car's frame rather than the camera's, **driving is identical in every
view**, and a chase camera's own lag cannot feed back into the steering.

Independent axes need independent _controls_, or the separation is theoretical.
On a phone a car therefore gets `src/render/driving.ts` in place of the
thumbstick: a horizontal steering track under one thumb, throttle and brake
pedals under the other, and the mode's action buttons stacked above the pedals
rather than fighting them for the corner. One stick cannot express two
independent axes on a phone, because holding a steering angle while lifting off
means pinning a thumb to a diagonal and keeping it there.

**Both pedals are analog, and they read travel rather than pressure.** A screen
has no pressure to sense, so asking for it would be a fiction — but a pedal was
never really a pressure sensor either. It is a thing you push further or less
far, and how far a thumb has slid up the control is exactly that: measurable,
and drawn as a fill so the player can see what they are asking for. Pressing
anywhere is worth a firm floor, so jabbing the throttle still just works;
sliding to the far edge is worth all of it. In the simulation `brakeDecel` and
the reverse creep scale with it, which is what makes trail braking real rather
than a word in a comment — the friction circle spends the tyres on stopping
first, so easing the brake hands the front end back the grip it was using.

**The pedals also drive the phone's motor** (`src/render/haptics.ts`).
`navigator.vibrate` has no amplitude — the motor is on or off — so intensity is
a duty cycle: the throttle keeps one cadence and spends more of each period
switched on the further it is down, while the brake is discrete knocks that get
faster _and_ longer. Two different sensations on purpose, because a driver has
to tell them apart without looking, and two weights of the same buzz are
indistinguishable through a phone case. It is driven from the PEDALS rather
than from the car's acceleration: what a driver feels through a pedal is their
own foot, which answers the instant they press at the weight they pressed —
reading it off the car would arrive late, say nothing during a wheelspin, and
buzz through a shunt nobody asked for. Absent on desktop and on iOS Safari, so
it fails soft, and the Settings toggle hides itself where there is no motor.

**The stick sets the angle of the front wheels, not a rate of turn.** What the
car then does about it is geometry — the standard kinematic bicycle model:

```
  omega = speed * tan(steerAngle) / wheelbase
```

Using that rather than adding the stick straight onto the heading is the
difference between a car and a tank, and three things stop being special cases
that have to be written down and start being consequences:

- **A parked car does not rotate.** Turning the wheel of a stationary car turns
  the wheels; it has to roll before any of that becomes a change of direction.
- **The radius of a corner is set by the lock, not the speed.** Hold an angle
  and the car traces the same arc at any speed, which is why a corner has a
  right gear rather than a right amount of steering.
- **Reversing swings the nose the other way.** `speed` is signed, so the yaw
  is too, and backing out of a barrier steers the way it does in a car park.
  That last one is what makes a spun car recoverable now that steering on the
  spot does nothing: the driver reverses out, exactly as they would in life.

| Key             | What it decides                                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `wheelbase`     | Distance between the axles. Longer is stabler and turns wider; it is the `L` above and nothing else reads it.                                                      |
| `maxSteerAngle` | Radians of lock at full stick. With the wheelbase this fixes the tightest circle the car can describe — `L / tan(angle)`.                                          |
| `steerFalloff`  | Fraction of that lock the rack winds off by top speed. Not understeer: the driver is never denied an angle they could hold, the stick simply asks for less of one. |

`steerFalloff` exists because full lock at racing speed asks for a radius no
car could hold. Without it the top half of the control's travel would do
nothing but plough, and the usable part would be a sliver of thumb travel — a
control problem, not a physics one, which is why it is separate from the tyres.

The handling on top is a **traction limit**, not a set of fiats. Speed exists
only along the car's own axis (no strafing), and everything else follows from
one number, `vehicle.tyreGrip` — the most lateral acceleration the tyres can
make:

| Key              | What it decides                                                                                                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tyreGrip`       | Peak lateral acceleration. Holding a line costs `speed × yawRate`, so the same steering angle grips slowly and lets go fast. 0 keeps the old proportional `grip` scrub.                |
| `frontGrip`      | How much more yaw the rack may ask for than the tyres can hold. 1 is pure understeer — the front washes out and the car goes straight on. Above 1 leaves rope to provoke a slide with. |
| `frictionCircle` | How much braking steals from cornering. Trail braking and power oversteer both live here.                                                                                              |
| `selfAlign`      | How fast the caster pulls a sliding car straight, in proportion to slip angle. Makes a slide catchable rather than terminal.                                                           |
| `weightFront`    | Share of the car's weight over the front axle at rest. The static balance.                                                                                                             |
| `weightTransfer` | How much of the weight moves between the axles at the limit. Where trail braking, power oversteer and lift-off oversteer all come from.                                                |

**The car has two axles, and the weight moves between them.** Each carries a
share of the load, makes lateral grip in proportion to that share, and spends
some of it lengthways — braking split by load the way a brake bias does, drive
all to the rear. The two always sum to `tyreGrip`, so the split decides balance
rather than how much grip exists. `frontGrip` and `selfAlign` are multipliers
on those per-axle numbers now, not the numbers themselves: the front axle caps
how much of the rack's request the car will honour, and the rear axle is what
the aligning moment pulls with.

That one change is why the following are not written down anywhere. Taking one
corner at one steering angle from one entry speed, on the `grandprix` preset,
and varying only the pedal:

```
  full throttle   turned 0.292   slip -0.04   runs wide — front load 0.15
  lift            turned 0.841   slip -0.42   rotates three times as much
  trail brake     turned 0.842   slip -0.44   most rotation, controlled
  full brake      turned 0.659   slip -1.11   rear unweighted, steps out
```

Because of this, **the throttle and brakes are resolved before the steering**
inside `steerVehicle`. The pedal decides where the weight is, the weight
decides what the front axle can do, and the front axle decides how much lock
the car honours; reading a load the pedal had not been consulted about would
put that chain a tick behind the driver.

Whatever the tyres cannot erase survives as sideways velocity — that surplus
**is** the drift, and it unwinds through `selfAlign`, which scales with how
fast the car is _rolling_: the aligning moment comes from the tyres turning, so
a car barely moving has none.

**Every one of those forces is scaled by `gripFraction` — surface times wear —
and there is exactly one such function on purpose.** All four contact patches
share one grip budget, so if a single term forgets to ask, it ends up fighting
the others. That is not hypothetical: the aligning moment used to be a flat
config number, so on grass a full-strength caster pulled against a
third-strength front axle. They balanced at about twelve degrees of slip and
stayed there — nose cocked into the corner, car travelling dead straight, full
lock doing nothing at all. It reads to a driver as the steering having simply
stopped working. Any new tyre force has to come through `gripFraction` too.

The speed limit is likewise on the **car**, not on its nose. The throttle only
ever reads and tops up the forward component, so without a check on the
resultant a sliding car carries its sideways velocity untaxed — at forty
degrees of slip that is a third over the limit, and the engine feeds it every
tick, so a slide _accelerates_. It is bled rather than clamped, and both
components together, so losing a tow does not put a wall of air in front of
you and the direction of travel is untouched.

Two details there are load-bearing, and getting either wrong makes the car
undrivable rather than merely wrong. Engine braking and drag are scaled by how
much of the car's motion is along its own nose, because a car travelling
sideways is not rolling and there is nothing for them to work against. And the
aligning rotation is clamped to the slip angle it is correcting. Without the
first, engine braking pins the forward component at zero every tick, which
holds the slip angle at a right angle — the largest input the aligning moment
can be given — and the car then spins indefinitely with nothing the driver can
do about it. It reads as the steering being stuck. Grass and worn rubber scale
the limit down, so both let go sooner.

Every rotation re-expresses the velocity in the frame it produced. Turning the
car must never turn its momentum with it — that difference is the entire
distinction between steering and teleporting, and getting it wrong pins the car
sideways for ever.

`slipAngle(player)` is the angle between where a car points and where it is
going: zero on rails, large in a drift, signed toward the side it is sliding.

Bots read the same limit rather than a hand-tuned lift: the road ahead turns
through some angle over the distance they look down it, so its radius is one
divided by the other, and they drive to `sqrt(grip × radius)`. They therefore
re-learn every circuit for free when the grip changes — on worn tyres, on the
grass, or when a preset is retuned.

It hangs off `integratePlayer`, so it runs inside client prediction too. That
is deliberate: a car is fast enough that an unpredicted metre is a visible one.

**The circuit is one closed centreline** (`SimConfig.trackPath`) plus a
half-width. `src/sim/track.ts` derives everything else from it — whether a car
is on the tarmac, how far round the lap it is, the racing line a bot follows,
and the starting grid. Off-track is grass, not a wall: `track.offTrackSpeed`
and `offTrackGrip` make it slow and slippery, which is forgiving on a thumb.

**Kerbs sit inside the track limits**, which is the whole point of them:
`track.kerbWidth` is a band measured inward from the edge where you keep most
of your grip (`kerbGrip`) but the car will not sit still (`kerbShake`). Riding
one straightens a corner at the cost of stability, which is the trade a real
kerb offers. The shake is a function of how far along the circuit the car IS
rather than of the tick, so a parked car on a kerb sits still, every peer
computes the identical kick for the identical metre, and a snapshot restore
lands on the same number.

**A shunt is remembered.** With `collision.damageSeconds` a hard enough contact
leaves both cars with a `bent` effect that costs grip while it lasts —
`damageThreshold` keeps racing wheel-to-wheel free, and severity is expressed
as DURATION rather than depth, because a timed effect is the one shape of
per-player state that is already snapshotted, transmitted and checksummed.
Both cars, always: damage landing only on the car that was hit would make a
lunge down the inside free for whoever lunged, which is the behaviour it
exists to price. It wears off on purpose — one shunt on lap one should cost a
stint, not the race.

Those two are deliberately **not** set to the same severity, and the asymmetry
is the design. `offTrackSpeed` is harsh (0.4–0.45) because losing speed costs a
driver time — a penalty they can see, understand, and drive out of.
`offTrackGrip` is mild (0.6) because losing grip costs them _control_, and a car
that will not answer the wheel does not read as a mistake being punished; it
reads as the controls having broken. Run wide and you should lose the lap, not
the car.

Circuits are authored as **control points** and rounded by `smoothTrack`
(Chaikin corner-cutting) into the centreline both layers use. A raw polyline
corner changes direction all at once, which leaves an unreachable pinch on the
inside and folds anything offset by half the road width — the tarmac's own edge.
Two rules when authoring: keep each turn at or under about 40° with segments of
nine units or more, and leave a road's width of run-off inside the arena.
`tests/unit/sim/track.test.ts` checks both, the way the platformer's tests
check jump heights.

`systems/race.ts` adds the rules on top, none of which carry state:

- **Running order** from laps, gates and distance to the next gate. Ranked that
  way rather than by one distance-round-the-lap number, because that number has
  to wrap somewhere and "somewhere" is the start/finish line.
- **Slipstream**: the closest car ahead within `slipstreamRange` grants `tow`.
- **DRS**: inside a `drs` zone, within `drsGapSeconds` of the car ahead, the
  wing arms (`drsok`) and the button opens it (`drs`). Gaps are measured along
  the centreline, so they are racing gaps, not radii.
- **Tyres**: a set is the `tyre` effect, whose remaining duration is its life.
  Fresh rubber is fitted whenever the race is not running and inside a `pit`
  zone — which is the trade: a slow lane in exchange for grip.

Lap times (`lapStartTick`, `lastLapTicks`, `bestLapTicks`) are the only new
state in any of it, because history is the one thing a tick number cannot be
asked for afterwards. `raceStandings` is projected into `RenderState` by
`ClientView`, so the HUD gets positions and intervals without importing `sim`.

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
first on-screen button) and `BUTTON_SECONDARY` (`E` / `K` / the second,
currently unused — reserved for your ability). Wiring order for a new ability:

1. Read the bit in your system: `player.input.buttons & BUTTON_SECONDARY`.
2. Show the button on phones: set `usesPrimaryAction` /
   `usesSecondaryAction` in the mode's metadata. Nothing else — the wire,
   prediction, touch and keyboard already carry both bits.
3. Name it: `primaryLabel` / `secondaryLabel` in the same metadata. The
   defaults are **A** and **B**, which say a button exists but not what it
   does — on a phone the button is the only affordance the player gets, so
   `'Jump'` or `'Fire'` is worth the one line. Keep it to one short word; the
   button is a 4rem circle and anything longer than about five characters
   stops fitting. `tests/unit/shared/modes.test.ts` enforces both the
   coverage and the length.

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
