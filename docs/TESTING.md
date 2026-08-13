# Testing

## The bet this project makes

Most multiplayer bugs are logic bugs, and logic bugs are cheap to catch — _if_
the logic can run without a browser.

So the simulation and the netcode are headless by construction, and the test
suite that matters runs in **about one second**:

```
tests/unit         200 tests
tests/integration   ← full multi-peer sessions, latency, packet loss
                   ~1.1s total, no browser
tests/e2e           31 tests, ~3 minutes, real Chromium (desktop + phone)
```

That ratio is the point. A test you run on every save catches things a
two-minute suite never will, because you never run the two-minute suite on
every save.

## The three tiers

| Tier        | Location             | Runner     | Speed  | For                                                  |
| ----------- | -------------------- | ---------- | ------ | ---------------------------------------------------- |
| Unit        | `tests/unit/`        | Vitest     | ~1 s   | Rules, math, protocol parsing, prediction            |
| Integration | `tests/integration/` | Vitest     | ~1 s   | Whole sessions: election, migration, loss            |
| End-to-end  | `tests/e2e/`         | Playwright | ~3 min | Babylon renders, DOM is wired, two real tabs, phones |

Playwright runs two projects:

| Project         | Specs                              | Device                                   |
| --------------- | ---------------------------------- | ---------------------------------------- |
| `chromium`      | everything except `mobile.spec.ts` | Desktop Chrome                           |
| `mobile-chrome` | `mobile.spec.ts`                   | `Pixel 5` — touch events, phone viewport |

Run one with `npm run test:e2e -- --project=mobile-chrome`.

**Anything expressible headlessly must be tested headlessly.** Reaching for
Playwright to test a gameplay rule is a design smell: the rule belongs in
`src/sim`, where testing it is 100× faster and 100× more reliable.

## `SessionHarness` — the tool you will use most

`tests/helpers/harness.ts` gives you a complete multiplayer session in-process:
real `NetSession` instances, real host election, real snapshots, real
prediction — over a virtual clock with configurable latency, jitter and packet
loss.

```ts
const harness = new SessionHarness({
  latencyMs: 80,
  jitterMs: 40,
  dropRate: 0.2,
  networkSeed: 4321, // seeded: failures reproduce exactly
});

harness.join('alpha'); // peer ids decide host election — lowest wins
harness.join('bravo');

harness.setIntent('bravo', 1, 0);
harness.advance(4000); // 4 simulated seconds; runs in microseconds

expect(harness.host()?.id).toBe('alpha');
expect(harness.state('alpha').players).toHaveLength(2);
```

Useful members: `join`, `drop` (abrupt, like a closed tab), `leave` (graceful,
sends `bye`), `setIntent`, `advance`, `host`, `state`, `score`, `network`.

### Rules

- **Never `setTimeout` or sleep.** Time only moves when you call `advance()`.
  A test that waits on the wall clock is a test that flakes in CI.
- **Name peers deliberately.** Host election is lexicographic, so `alpha` hosts
  and `bravo` does not. Write the test so the intended host sorts first.
- **Seed the network.** `networkSeed` fixes which packets drop, so a red test
  is reproducible rather than "sometimes".

## What is already covered

| Area                                                                   | Where                             |
| ---------------------------------------------------------------------- | --------------------------------- |
| Movement, collision, sliding, degenerate cases                         | `unit/sim/movement.test.ts`       |
| Pickups, respawn, contested collection                                 | `unit/sim/pickups.test.ts`        |
| Snapshot round-trip fidelity                                           | `unit/sim/world.snapshot.test.ts` |
| Determinism, replay, split-and-resume                                  | `unit/sim/determinism.test.ts`    |
| Protocol parsing incl. hostile input                                   | `unit/net/protocol.test.ts`       |
| Host election, virtual network                                         | `unit/net/transport.test.ts`      |
| Prediction, reconciliation, interpolation                              | `unit/net/prediction.test.ts`     |
| Sessions: 1/2/3 peers, late joiners, loss, migration, malicious peers  | `integration/session.test.ts`     |
| Lobby, rendering, HUD, keyboard                                        | `e2e/smoke.spec.ts`               |
| Two real tabs: discovery, roster, migration, isolation                 | `e2e/multiplayer.spec.ts`         |
| Phone: thumbstick, one-handed follow-camera, portrait framing, install | `e2e/mobile.spec.ts`              |
| Asset manifest parsing and attribution rules                           | `unit/shared/manifest.test.ts`    |

## Two tests that are load-bearing

Some tests exist to check a feature. These two exist to protect the
architecture, and weakening them to make a change pass would be a mistake.

### `world.snapshot.test.ts` — "keeps simulating identically after a restore"

Asserts that applying a snapshot to a fresh world produces something that keeps
behaving identically, not merely something that _looks_ the same right now.

This caught a real bug during initial development: `World` held each player's
pending input in a side table rather than in player state, so snapshots
restored positions but not intents. A restored world drifted away from its
source within a few ticks — exactly the kind of desync that is agonising to
diagnose from a bug report. The fix was to move `input` into `PlayerState`.

**If you add mutable simulation state, add it to `WorldSnapshot`.** This test
is how you find out you forgot.

### `determinism.test.ts` — "diverges when a single input differs"

A determinism test that cannot fail is worthless. This one perturbs one input
on one tick and asserts the checksums _stop_ matching, proving the other three
determinism assertions are actually sensitive.

## Writing new tests

**Simulation** — construct a `World` with a small bespoke config. Do not reach
for `DEFAULT_SIM_CONFIG`; a 4×4 arena with one pickup makes the assertion
obvious.

```ts
const world = new World({
  seed: 7,
  config: makeSimConfig({ arenaHalfExtentX: 8, obstacleCount: 0, pickupCount: 1 }),
});
```

Watch out for the arena edge: a player accelerating for 300 ticks in a small
arena hits the wall, which zeroes their velocity. A speed-cap assertion in that
setup passes vacuously. `movement.test.ts` keeps a separate `openConfig` with a
5000-unit arena for exactly this reason.

**Networking** — use `SessionHarness`. Drop to a bare `MemoryNetwork` only when
testing the transport itself.

**Rendering** — Playwright. Assert via `data-testid` and the read-only
`window.__FWG__` handle (declared in `tests/e2e/globals.d.ts`), which exposes
`selfId`, `hostId`, `isHost`, `peerCount`, `tick`, `playerCount`, `players`,
`fps` and the camera's `cameraAlpha`/`cameraRadius`/`cameraBeta`. It makes "the peers connected" distinguishable from "the HUD
happened to update", and `players` lets a test assert that someone actually
moved rather than that a control merely exists.

Prefer `expect.poll` over fixed waits:

```ts
await expect.poll(() => page.evaluate(() => window.__FWG__.tick)).toBeGreaterThan(30);
```

### Gotcha: a stale preview server

`playwright.config.ts` sets `reuseExistingServer: !process.env.CI`, so a
`vite preview` you started by hand will be reused — **serving whatever build
was current when you started it**. The symptom is a batch of new tests failing
against code you can see is correct, usually with `undefined` where a new
`window.__FWG__` field should be.

If that happens, stop the stray server and re-run. Note that
`pkill -f "vite preview"` is a trap: the pattern matches the shell command
running it, so it kills your own session. Match on the listening port instead,
or just use a different port for ad-hoc previews.

### Why the mobile suite uses a device descriptor

Mobile is a hard requirement (see `CLAUDE.md` §7), and the thing that actually
breaks on a phone is **input**, not layout. A narrow desktop window would pass
every layout assertion while the game remained completely unplayable, because
there is no keyboard.

So `mobile.spec.ts` runs under the `Pixel 5` descriptor — real touch events, a
mobile user agent, a phone viewport — and its central test drags the on-screen
thumbstick and asserts the player actually moved. That is the assertion that
would have caught the original keyboard-only build.

### Why e2e multiplayer uses BroadcastChannel

`?net=broadcast` swaps the WebRTC transport for a same-browser one. It
exercises everything above the transport seam — election, snapshots, roster
sync, prediction, host migration — while depending on no public relay and no
UDP egress. Running those tests over live WebRTC would mean failures caused by
relay weather rather than by the change under review.

The layer this cannot reach is the Trystero adapter itself, which is a thin
wrapper over a third-party library. That is a deliberate, stated gap.

## Coverage

Enforced on `src/sim`, `src/net`, `src/shared`: 85% lines, statements and
functions; 75% branches. Currently ~96% lines.

The render layer is excluded on purpose — it needs a GPU, and e2e covers it.
`transports/trystero.ts` and `transports/broadcast.ts` are excluded for the
same reason.

Do not chase the number by testing getters. If coverage drops because you added
a branch nobody exercises, the question is whether that branch should exist.

## CI

`.github/workflows/ci.yml` runs four independent jobs on every push and PR:

| Job       | What                                                           |
| --------- | -------------------------------------------------------------- |
| `quality` | format, lint (incl. layering rules), typecheck, asset licences |
| `test`    | unit + integration with coverage thresholds                    |
| `build`   | production build, and that generated assets are up to date     |
| `e2e`     | Playwright in Chromium                                         |

They are parallel rather than chained so a lint error and a failing test show
up in the same run instead of one hiding the other — which matters when several
agents share CI.

Each job is guarded so the workflow runs **once** per commit. Pushing a branch
and opening a pull request from it would otherwise fire the whole thing twice on
the same SHA; the push run's checks already attach to the pull request, so the
second run costs double and makes two software-rendered WebGL suites compete for
runners. Forks have no push run, so their pull requests still run everything.

Locally, `npm run verify` runs everything except e2e.
