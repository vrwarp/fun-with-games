# CLAUDE.md

Instructions for Claude Code (and any other agent) working in this repository.

This is a **starter kit**, not a finished game. Its job is to make the next
thousand commits cheap: keep the seams clean, keep the tests fast, and keep the
rules below intact even when a shortcut would be quicker.

> **Asked to "make a game"? Read [`docs/RECIPES.md`](./docs/RECIPES.md) first.**
> Sixteen playable modes already exist behind `?mode=` (tag, infection,
> arena, knockout, soccer, ctf, hill, race, crown, rush, gather, platformer,
> skirmish, dungeon, grandprix, street), and a library of config-driven
> systems — phases/rounds, teams, hp/combat, projectiles, tag roles, a ball
> with goals, zones, carryable flags/crowns, timed status effects, power-ups,
> gravity/jumping, car handling with circuits, and bots — means most new games
> are **a preset, not new code**. The reference is
> [`docs/GAME_KIT.md`](./docs/GAME_KIT.md). Do not rebuild any of this.
>
> **Racing is covered too.** `?mode=grandprix` is a full Formula-style race —
> grid start, three laps, slipstream, DRS, tyre wear and a pit lane — and
> `?mode=street` is a shorter one seen from above. A circuit is a list of
> control points; see the "authoring a circuit" recipe before writing any.
>
> **2D and 2.5D are already covered.** `src/sim` is a _plane_ — it has no
> camera and no perspective — so 2D is the native model, not a port. Add
> `&view=topdown`, `&view=iso` or `&view=side` (optionally `&sprites=1`) to
> ANY mode's URL. Do not write a second engine for 2D; change the view.

---

## 1. Orientation

A peer-to-peer arena engine with a library of composable game systems, playable
in 3D, 2.5D or 2D, on foot or in a car. The default mode is a shard-collecting
sandbox; fifteen more modes ship with it.

| Concern    | Choice                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------- |
| Rendering  | Babylon.js 9 (`@babylonjs/core`, deep imports); 3D, isometric, top-down and side views      |
| Networking | [Trystero](https://github.com/dmotz/trystero) — WebRTC, decentralized signalling over Nostr |
| Authority  | Host-authoritative, host _elected_ (lowest peer id), auto-migrating                         |
| Build      | Vite 7 + TypeScript 5.9 (strict, `noUncheckedIndexedAccess`)                                |
| Tests      | Vitest (headless sim + net) and Playwright (browser)                                        |
| Deploy     | GitHub Pages, on push to `main`                                                             |
| Targets    | Desktop **and mobile browsers** — see §7, this is a hard constraint                         |

Read `docs/ARCHITECTURE.md` before your first non-trivial change.

---

## 2. Commands

```bash
npm install

npm run dev              # dev server at http://localhost:5173
npm run build            # typecheck + production build
npm run preview          # serve the production build

npm test                 # unit + integration (fast: ~1s, no browser)
npm run test:watch       # the loop to work in
npm run test:coverage    # enforces coverage thresholds
npm run test:e2e         # Playwright (builds first; slow)

npm run lint             # ESLint, including the layering rules
npm run typecheck        # tsc across app, tests and scripts
npm run format           # Prettier, write

npm run assets:generate  # regenerate procedural art (commit the result)
npm run assets:fetch     # download catalogued third-party art
npm run assets:verify    # manifest + licence check (runs in CI)

npm run verify           # everything CI runs, except e2e
```

**Before you say you are done: `npm run verify` must pass.** Run
`npm run test:e2e` too if you touched anything under `src/render/`, `src/ui/`,
`src/main.ts`, or the transports — it covers desktop _and_ a phone
(`--project=mobile-chrome` for just the mobile suite).

### Playing multiplayer locally

You do not need two machines or an internet connection. Append
`?net=broadcast` and open two tabs — peers find each other over
`BroadcastChannel`:

```
http://localhost:5173/?net=broadcast&room=test&mode=tag
```

Drop `?net=broadcast` to use real WebRTC over the public relay network.
`?bots=3` (or the host's **+ Bot** HUD button) fills the room with in-sim
bots, so every mode is demoable with one human.

Racing needs a circuit, so it is worth seeing first:

```
http://localhost:5173/?net=broadcast&room=gp&mode=grandprix&bots=3
```

Useful query parameters: `room`, `mode`, `bots`, `view`, `sprites`, `name`,
`color`, `net=broadcast`, `autojoin=1`, `mute=1`, `log=debug`. The mode is part
of the transport room name, so peers running different rules never meet;
`view` and `sprites` are presentation-only and deliberately are NOT, so one
player can watch a match top-down while another plays it in 3D. Views are
`follow`, `first` (cockpit), `iso`, `topdown` and `side`.

**None of the player-facing ones are URL-only.** Room, mode, name, colour and
camera are in the lobby; camera, sprites, sound and bots are in the in-game
**Settings** panel (`src/ui/settings.ts`) and change immediately, without a
reload. A parameter is for _sharing a link_, not for operating the game —
nobody edits a query string mid-race, and on a phone nobody can. If you add an
option, add it to one of those two surfaces in the same change.

Presentation settings are remembered per device (`src/ui/preferences.ts`,
`localStorage`). Precedence is **URL, then stored, then the mode's default**: a
link describes the game someone was invited to, and their own settings fill in
the rest.

---

## 3. Architecture rules

The dependency arrow points one way and **ESLint enforces it** — a violation
fails CI, it is not a review opinion:

```
shared  <-  sim  <-  net  <-  render / ui  <-  main
```

| Layer        | May import             | Must never import                   |
| ------------ | ---------------------- | ----------------------------------- |
| `src/shared` | nothing in `src/`      | everything else                     |
| `src/sim`    | `shared`               | Babylon, DOM, `net`, `render`, `ui` |
| `src/net`    | `shared`, `sim`        | Babylon, `render`, `ui`             |
| `src/render` | `shared`, `sim`, `net` | —                                   |
| `src/ui`     | `shared`, `net`        | —                                   |

### The rule that matters most

**`src/sim` is pure, deterministic, headless TypeScript.** No Babylon, no DOM,
no clocks, no `Math.random()`, no network. It is a function of
`(seed, config, inputs)`.

This is not stylistic tidiness. It is what buys:

- a full 3-peer multiplayer session, with latency and packet loss, tested in
  **~1 second** in Node;
- a desync reproducible from a seed and an input log;
- a renderer that can be rewritten without touching gameplay.

If you find yourself wanting a Babylon type or `Date.now()` inside `src/sim`,
the design is wrong. Pass the value in, or put the code in `src/render`.

Concretely, inside `src/sim` the linter rejects `Math.random()`, `Date.now()`,
`new Date()`, `window`, `document`, and `performance`. Use `Rng` from
`@/sim/rng.ts` and derive time from the tick number.

### Determinism checklist

When touching simulation code:

- Iterate players via `world.players()` (or `ctx.players` inside a system) —
  sorted by id. Never `Map` order: insertion order differs per peer, float
  addition is not associative, and the result is a desync nobody can
  reproduce.
- All randomness through the seeded `Rng`, whose state is captured in
  snapshots. (Bots deliberately use none — their wander targets are hashed
  from the bot id and a tick epoch — so bot decisions can never perturb the
  shared stream.)
- **Any new mutable state must be added to `WorldSnapshot`** (and
  `applySnapshot`, `checksum`, and the protocol validators — the full ritual
  is a checklist in `docs/RECIPES.md`). If it is not snapshotted, it silently
  diverges between host and clients.
  `tests/unit/sim/world.snapshot.test.ts` is the guard rail — its config
  turns EVERY system on; keep it that way when adding one. Do not weaken it.
- **Presentation is not simulation.** Camera view and sprite style live in
  `src/render` and never enter `SimConfig`. If a "visual" choice changes what
  the rules do — a side-scroller's one-lane constraint, gravity — then it IS
  simulation and belongs in the config, synced like everything else.
- **Prefer not creating state at all.** Timed per-player state is an effect
  (`addEffect` — the effects map is already snapshotted, transmitted and
  checksummed); anything derivable from the tick number should be computed,
  not stored.

---

## 4. How to develop a feature

0. **Check the kit first.** `docs/GAME_KIT.md` lists what already exists;
   `docs/RECIPES.md` has worked, compile-ready recipes (new mode preset, dash
   ability, freeze tag, storm circle, melee, new effects). Most game requests
   are a Tier-0 URL or a Tier-1 preset — minutes, not hours.
1. **Find the layer.** Gameplay rule → `src/sim`. Wire format → `src/net`.
   Anything visual → `src/render` / `src/ui`. If it spans layers, it is
   probably two changes.
2. **Write the headless test first.** Simulation changes are testable in
   milliseconds; use that. `SessionHarness` (`tests/helpers/harness.ts`) gives
   you a full multi-peer session with configurable latency and packet loss;
   `tests/helpers/factories.ts` builds players, inputs, snapshots and step
   contexts.
3. **Implement behind the existing seams.** Add a new file rather than
   widening an existing one where you reasonably can.
4. **Snapshot it** if it is mutable simulation state (see above) — or avoid
   new state entirely: timed per-player state is one `addEffect()` call, and
   anything derivable from the tick needs no state at all.
5. **Run `npm run verify`.**
6. **Update the docs you invalidated.** A stale `docs/NETWORKING.md` costs the
   next agent more than your feature saved.

### Worked example: adding a gameplay mechanic

Say you are adding a dash ability. Because the kit already carries a generic
action-button bitfield in `PlayerInput` and timed state as effects, this is
**simulation-only** — full walkthrough with code in `docs/RECIPES.md`:

- `src/sim/config.ts` — add `dashImpulse`, `dashCooldownTicks` (flat keys).
- `src/sim/systems/dash.ts` — new file: read
  `player.input.buttons & BUTTON_SECONDARY`, `applyImpulse()` along the
  heading, `addEffect(player, 'dashcd', …)` for the cooldown.
- `src/sim/world.ts` — one call in the `step()` pipeline.
- Touch affordance: enable the secondary on-screen button (`TouchButtons` in
  `main.ts`). The keyboard (`E`/`K`) already works. A keyboard-only ability
  is unreachable on a phone, which is the primary target (§7).
- Tests: a unit test for the mechanic; the snapshot/protocol suites need no
  changes because no new state shape was introduced.

Note what you did _not_ have to touch: `types.ts`, `protocol.ts` (no version
bump — buttons already travel), prediction, the renderer, the transports, the
HUD. That is the layering plus the kit doing their jobs.

---

## 5. Working in parallel with other agents

This repo is set up so several agents can work at once without stepping on each
other. Full protocol in `docs/PARALLEL_AGENTS.md`; the essentials:

- **Claim a module, not a file list.** Ownership map: `docs/MODULES.md`.
  Two agents inside the same directory will conflict; two agents in `src/sim`
  and `src/render` will not.
- **Branch per task**: `claude/<short-topic>-<id>`. Never commit to `main`.
- **Prefer new files.** A new system in `src/sim/systems/` merges cleanly; a
  40-line insertion into `world.ts` does not.
- **Shared files are coordination points.** These are the ones several agents
  will want at once — keep diffs to them small and additive, and mention them
  in your PR description:
  - `src/sim/types.ts`, `src/sim/config.ts`
  - `src/sim/world.ts` (the `step()` pipeline is explicitly ordered on purpose
    — determinism requires a fixed order, so do not convert it to a registry)
  - `src/sim/presets.ts`, `src/shared/modes.ts` (one entry per mode — append)
  - `src/sim/track.ts` (circuit geometry — read by sim, presets and render)
  - `src/net/protocol.ts`
  - `public/assets/manifest.json` (regenerate; never hand-edit)
- **Never renumber or reuse `PROTOCOL_VERSION`.** If two agents both need a
  bump, the second rebases and takes the next integer.
- **Do not "fix" another module to make yours work.** File it, or put an
  adapter in your own layer.

---

## 6. Testing expectations

Three tiers, in the order you should reach for them:

| Tier        | Location             | Speed  | Use for                              |
| ----------- | -------------------- | ------ | ------------------------------------ |
| Unit        | `tests/unit/`        | ~1 s   | Rules, math, protocol parsing        |
| Integration | `tests/integration/` | ~1 s   | Whole multiplayer sessions, headless |
| E2E         | `tests/e2e/`         | ~2 min | Babylon renders, DOM is wired        |

Rules of thumb:

- **Anything expressible headlessly must be tested headlessly.** Reaching for
  Playwright to test a gameplay rule is a design smell — the rule belongs in
  `src/sim`, where it is 100× faster to test.
- Use `SessionHarness` for anything multi-peer. It has a virtual clock:
  `harness.advance(2000)` is 2000 simulated milliseconds and takes
  microseconds. **Never `setTimeout`/`sleep` in a test.**
  `harness.hostWorld()` returns the authoritative world — teleport players
  onto each other there instead of simulating minutes of travel.
- `tests/helpers/factories.ts` builds players, inputs, snapshots and step
  contexts for surgical single-system tests.
- `tests/unit/sim/presets.test.ts` sweeps EVERY game mode through
  determinism + snapshot-restore checks, so a new preset is covered the
  moment it is registered.
- Seed everything. `MemoryNetwork` takes a seed for its jitter and drop
  decisions so a failure reproduces exactly.
- Coverage thresholds are enforced on `src/sim`, `src/net`, `src/shared`
  (85% lines/statements/functions, 75% branches). The render layer is
  deliberately excluded — e2e covers it.
- E2E multiplayer uses `?net=broadcast`, not live WebRTC. CI has no public
  relay and no UDP egress; a test that depends on those fails for reasons
  unrelated to the change under review.

See `docs/TESTING.md`.

---

## 7. Mobile-first — this is the primary target

**The phone is the design target, not a port.** Desktop is the enhancement.
Treat this as a constraint on every change: a feature that is only reachable
with a keyboard, or that drops the frame rate on a mid-range Android, is not
done.

The distinction matters. "Works on mobile" gets you a desktop game you can
technically operate with a thumb. "Designed for mobile" means the default
experience assumes a phone, and the things that only make sense with a mouse
and a big screen are the special cases. Concretely, that shaped:

- **The camera follows the direction of travel by itself.** A manual-only
  camera needs a second thumb to drag — on the hand holding the device. Any
  drag or wheel still takes over for a few seconds
  (`MANUAL_CAMERA_HOLD_SECONDS`), so it never fights a player who wants to look
  around.
- **Portrait gets its own framing.** A phone viewport is narrow, so the camera
  pulls back and tilts further down; otherwise a third of the screen is sky and
  you walk into things you never saw. Applied on orientation flips only —
  mobile browsers fire `resize` constantly as the URL bar retracts, and
  resetting a player's zoom mid-game would be maddening.
- **`src/ui/styles.css` is mobile-first.** Base rules are the phone. Larger
  screens are `min-width` blocks at the bottom. Do not add `max-width`
  overrides — that makes mobile a pile of exceptions, and exceptions rot.
- **Options are controls, not query strings.** Everything a player might want
  to change mid-game lives in the Settings panel, reachable from a 44px gear
  beside Credits. Only presentation goes in there: anything that changes the
  _rules_ has to be agreed with the other peers, so it belongs to the room and
  stays in the lobby. A settings menu that could quietly desync a match would
  be a trap.
- **Setup UI collapses on a phone.** The HUD panel holds the room code, the
  goal line, the invite link, the bot controls and the connection status —
  all of which matter while setting a game up and none of which are worth a
  corner of the track while playing. On a coarse pointer it starts collapsed
  to its handle (room code + score), which is a 59% smaller footprint; the
  handle is a 44px tap target that opens it again. Desktop starts expanded.
- **It installs.** Web app manifest, generated maskable icons, standalone
  display, `theme-color`, safe-area insets, and a screen wake lock so the
  display does not sleep while a player stands still.

What this means in practice:

- **Every action needs a touch affordance.** Keyboard bindings are an
  addition, never the only way in. `src/render/touch.ts` owns the on-screen
  thumbstick and `src/render/buttons.ts` the on-screen action buttons (shown
  only in modes that use them — `usesPrimaryAction` in the mode metadata);
  `mergeIntents()` in `src/render/input.ts` combines devices, so a new
  control means adding a source, not branching on device type.
- **Both input paths must produce the same `InputIntent`.** Nothing below
  `src/render` knows or cares how the player moved — the simulation, the wire
  protocol and prediction are all device-agnostic. Keep it that way; do not
  add a `isMobile` flag to `PlayerInput`. New abilities ride the existing
  `buttons` bitfield (`BUTTON_PRIMARY`/`BUTTON_SECONDARY`) — no wire change.
- **Abilities fire along the facing direction.** Projectiles aim where you
  run. A phone has no aiming thumb; keep new abilities aim-free too.
- **Touch targets ≥ 44px.** Anything smaller is genuinely hard to hit with a
  thumb, and the mobile e2e suite asserts it for the join button.
- **Watch the frame budget.** Phones report device pixel ratios of 3, which is
  9× the fragments. The renderer caps the effective ratio at 2 and halves the
  shadow map on coarse pointers. If you add a post-process or a second light,
  check it on the mobile project before calling it done.
- **Layout must survive a notch and a retracting URL bar.** Use `dvh` rather
  than `vh`, and `env(safe-area-inset-*)` for anything pinned to an edge.
- **Inputs at 16px minimum.** iOS zooms the page when focusing anything
  smaller, and the player cannot zoom back out.
- **`touch-action: none`** on any element that handles drags, or the browser
  claims the gesture for scrolling and your pointer stream dies mid-drag.
- **Controls must read against arbitrary game content.** The thumbstick sits
  over the 3D scene, so it carries its own contrast — an opaque fill, a bright
  rim and a dark outer shadow. A control that vanishes over a pale obstacle is
  a broken control.
- **Icons are generated, not committed as binaries.**
  `npm run assets:generate` draws them via `scripts/lib/png.mjs`. An icon in a
  diff is something no reviewer can check.

Verify with `npm run test:e2e` — the `mobile-chrome` project runs against a
`Pixel 5` device descriptor (real touch events, phone viewport), not a narrow
desktop window. A narrow window would pass while the game stayed unplayable,
because what actually breaks on a phone is input, not layout.

Analog stick magnitude is carried through: a half-pushed stick moves at half
speed (`integratePlayer` scales acceleration and the speed cap by the input
vector's length; keyboard input is always magnitude 1). Still open, if you
want it: richer haptics and a service worker for offline play.

---

## 8. Assets

**The game must always run with no art at all.** Procedural geometry is the
baseline; models are an enhancement that fails soft. Never make a code path
depend on a file that might not be there.

- `npm run assets:generate` — procedural glTF, no network, no licence
  questions, deterministic output. Commit what it writes.
- `npm run assets:fetch` — downloads what `assets/sources.json` catalogues into
  the gitignored `public/assets/vendor/`.
- Every asset needs recorded licence metadata. `assets:verify` fails CI without
  it, and `ATTRIBUTION.md` is generated from it.

Full guidance, including where to find CC0 art and how to generate it:
`docs/ASSETS.md`.

---

## 9. Gotchas

- **Deep-import Babylon** (`@babylonjs/core/Meshes/meshBuilder.js`), never the
  package root. Some features additionally need a side-effect import to
  register a scene component — shadows are the classic one, and the failure
  mode is silent (no shadows, no error).
- **`verbatimModuleSyntax` is on.** Type-only imports need `import type`.
- **`.js` extensions in relative imports**, even from `.ts` files.
- **`exactOptionalPropertyTypes` is on.** `{ foo: undefined }` is not assignable
  to `{ foo?: string }`. Use conditional spread:
  `...(x !== undefined ? { foo: x } : {})`.
- **`noUncheckedIndexedAccess` is on.** `array[0]` is `T | undefined`.
- The **e2e debug handle** `window.__FWG__` is declared in
  `tests/e2e/globals.d.ts` and defined in `src/main.ts`. Keep them in sync.
- Peer ids decide host election. In tests, name peers so the intended host
  sorts first (`alpha` beats `bravo`).

---

## 10. Git

- Branch from `main`, named `claude/<topic>-<id>`.
- Commit messages: imperative subject, and say _why_ when it is not obvious.
- `npm run verify` before pushing.
- Do not commit `dist/`, `coverage/`, `public/assets/vendor/`, or
  `test-results/`.
- Do open a PR only when asked to.
