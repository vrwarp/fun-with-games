# CLAUDE.md

Instructions for Claude Code (and any other agent) working in this repository.

This is a **starter kit**, not a finished game. Its job is to make the next
thousand commits cheap: keep the seams clean, keep the tests fast, and keep the
rules below intact even when a shortcut would be quicker.

---

## 1. Orientation

A peer-to-peer 3D arena. Players roam a seeded arena and collect shards.

| Concern    | Choice                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------- |
| Rendering  | Babylon.js 9 (`@babylonjs/core`, deep imports)                                              |
| Networking | [Trystero](https://github.com/dmotz/trystero) — WebRTC, decentralized signalling over Nostr |
| Authority  | Host-authoritative, host _elected_ (lowest peer id), auto-migrating                         |
| Build      | Vite 7 + TypeScript 5.9 (strict, `noUncheckedIndexedAccess`)                                |
| Tests      | Vitest (headless sim + net) and Playwright (browser)                                        |
| Deploy     | GitHub Pages, on push to `main`                                                             |

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
`src/main.ts`, or the transports.

### Playing multiplayer locally

You do not need two machines or an internet connection. Append
`?net=broadcast` and open two tabs — peers find each other over
`BroadcastChannel`:

```
http://localhost:5173/?net=broadcast&room=test
```

Drop `?net=broadcast` to use real WebRTC over the public relay network.

Useful query parameters: `room`, `name`, `color`, `net=broadcast`,
`autojoin=1`, `log=debug`.

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

- Iterate players via `world.players()` — sorted by id. Never `Map` order:
  insertion order differs per peer, float addition is not associative, and the
  result is a desync nobody can reproduce.
- All randomness through the seeded `Rng`, whose state is captured in snapshots.
- **Any new mutable state must be added to `WorldSnapshot`.** If it is not
  snapshotted, it silently diverges between host and clients.
  `tests/unit/sim/world.snapshot.test.ts` is the guard rail — it caught exactly
  this bug during initial development. Do not weaken it.

---

## 4. How to develop a feature

1. **Find the layer.** Gameplay rule → `src/sim`. Wire format → `src/net`.
   Anything visual → `src/render` / `src/ui`. If it spans layers, it is
   probably two changes.
2. **Write the headless test first.** Simulation changes are testable in
   milliseconds; use that. `SessionHarness` (`tests/helpers/harness.ts`) gives
   you a full multi-peer session with configurable latency and packet loss.
3. **Implement behind the existing seams.** Add a new file rather than
   widening an existing one where you reasonably can.
4. **Snapshot it** if it is mutable simulation state (see above).
5. **Run `npm run verify`.**
6. **Update the docs you invalidated.** A stale `docs/NETWORKING.md` costs the
   next agent more than your feature saved.

### Worked example: adding a gameplay mechanic

Say you are adding a dash ability.

- `src/sim/types.ts` — add `dashCooldown: number` to `PlayerState`, and a
  `dash: boolean` to `PlayerInput`.
- `src/sim/config.ts` — add `dashImpulse`, `dashCooldownTicks`.
- `src/sim/systems/movement.ts` — apply it inside `integratePlayer`, so
  prediction and authority stay in agreement automatically.
- `src/net/protocol.ts` — carry and **validate** the new input field; bump
  `PROTOCOL_VERSION` because the shape changed.
- `src/render/input.ts` — bind a key.
- Tests: a unit test for the mechanic, and a `SessionHarness` test that a
  dashing client converges with the host.

Note what you did _not_ have to touch: the renderer, the transports, the HUD.
That is the layering doing its job.

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

## 7. Assets

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

## 8. Gotchas

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

## 9. Git

- Branch from `main`, named `claude/<topic>-<id>`.
- Commit messages: imperative subject, and say _why_ when it is not obvious.
- `npm run verify` before pushing.
- Do not commit `dist/`, `coverage/`, `public/assets/vendor/`, or
  `test-results/`.
- Do open a PR only when asked to.
