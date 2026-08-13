# Architecture

## The one idea

**The game simulation knows nothing about rendering or networking.**

`src/sim` is plain TypeScript: no Babylon, no DOM, no clock, no sockets, no
`Math.random()`. A world is a pure function of `(seed, config, inputs)`.

Everything else in this document follows from that, and so does most of what
makes the project pleasant to extend:

- A three-peer session with 80 ms latency and 20% packet loss is a **Node unit
  test that runs in about a second**. No browser, no WebRTC, no flake.
- A desync is reproducible from a seed and an input log.
- The renderer is replaceable. Delete `src/render`, write a 2D canvas version
  against the same `RenderState`, and every simulation test still passes.
- Agents can work in `sim` and `render` simultaneously without conflicts.

The layering is enforced by ESLint (`eslint.config.js`), not by convention:
`src/sim` importing `@babylonjs/*` is a build failure.

## Layers

```
┌──────────────────────────────────────────────┐
│ main.ts        bootstrap, frame loop         │
├──────────────────────────────────────────────┤
│ ui/            DOM overlay: lobby, HUD       │
│ render/        Babylon: scene, meshes, input │
├──────────────────────────────────────────────┤
│ net/           transport, protocol, session, │
│                prediction & interpolation    │
├──────────────────────────────────────────────┤
│ sim/           the game itself (headless)    │
├──────────────────────────────────────────────┤
│ shared/        math, events, logging         │
└──────────────────────────────────────────────┘
```

Dependencies point downward only.

### `src/shared`

Leaf utilities: 2D math, a typed `Emitter`, a level-filtered logger. Depends on
nothing.

### `src/sim` — the game

| File                  | Responsibility                                       |
| --------------------- | ---------------------------------------------------- |
| `world.ts`            | State container and the fixed-step `step()` pipeline |
| `config.ts`           | Every tunable number                                 |
| `types.ts`            | `PlayerState`, `PickupState`, `WorldSnapshot`, …     |
| `rng.ts`              | Seeded, serializable PRNG                            |
| `systems/arena.ts`    | Seed-derived obstacles and spawn points              |
| `systems/movement.ts` | Integration and collision resolution                 |
| `systems/pickups.ts`  | Collection and respawn                               |

`World.step()` advances exactly one tick (30 Hz). The order of operations
inside it is deliberate and load-bearing: change it and every peer's arena
changes with it.

Two properties are non-negotiable:

1. **Sorted iteration.** `world.players()` returns players ordered by id.
   `Map` iteration order is insertion order, which differs per peer; floating
   point addition is not associative; the result would be an unreproducible
   desync.
2. **Complete snapshots.** `WorldSnapshot` captures _all_ mutable state,
   including the RNG stream position and each player's held input. Anything
   left out diverges silently.

The second point has teeth: during initial development, `World` kept pending
inputs in a side table on the class rather than in player state. Snapshots
therefore restored positions but not intents, and a restored world drifted
away from its source within a few ticks. `tests/unit/sim/world.snapshot.test.ts`
caught it. That test is a guard rail — do not weaken it to make a change pass.

### `src/net` — making it multiplayer

| File                      | Responsibility                                          |
| ------------------------- | ------------------------------------------------------- |
| `transport.ts`            | The `Transport` seam, plus `electHost`                  |
| `transports/trystero.ts`  | Real WebRTC (production)                                |
| `transports/broadcast.ts` | `BroadcastChannel` — two tabs, one browser, no network  |
| `transports/memory.ts`    | In-process virtual-clock network (tests)                |
| `protocol.ts`             | Wire messages, encoding, and hostile-input validation   |
| `prediction.ts`           | `ClientView`: prediction, reconciliation, interpolation |
| `session.ts`              | `NetSession`: ties it together, runs the tick loop      |
| `view.ts`                 | `RenderState` — the only thing the renderer consumes    |

`Transport` is the seam that makes the whole thing testable. Three
implementations, one interface; swapping them is the only difference between a
live game and an integration test.

Details in [`NETWORKING.md`](./NETWORKING.md).

### `src/render` and `src/ui`

`Renderer` owns the Babylon engine, scene, camera and lights, and projects
`RenderState` onto meshes each frame. `EntityViews` does the mesh
bookkeeping — create, update, dispose.

The projection is strictly one-way. Nothing reads a mesh position to answer a
gameplay question; the simulation is the only source of truth. That is what
keeps the renderer swappable and gameplay testable headlessly.

The UI is plain DOM over the canvas, not Babylon GUI: lighter, styleable with
CSS, and reachable from Playwright by `data-testid`.

Input devices also live here: `KeyboardInput` and `TouchInput` (an on-screen
thumbstick, because the phone is the primary target). Both emit the same
`InputIntent`, merged by `mergeIntents()`, so every layer below `src/render` is
completely unaware of how the player moved. `device.ts` holds the optional
platform niceties — screen wake lock, haptics — each written to degrade to
nothing where unsupported.

The camera follows the player's direction of travel on its own, and frames the
arena differently in portrait. Both exist so the game is playable one-handed;
see `CLAUDE.md` §7.

## The frame loop

```
requestAnimationFrame
  └─ read keyboard + thumbstick ──► session.setIntent(x, z, sprint)
  └─ session.update(now)
       └─ while (accumulated >= 33.3ms)          // fixed 30 Hz timestep
            ├─ build PlayerInput from intent
            ├─ ClientView.recordInput(input)     // predict locally, now
            └─ host?  world.step() + broadcast snapshot every 2 ticks
               client? send input to host
  └─ session.sample(now)  ────────► RenderState
  └─ renderer.renderFrame(state, dt)
  └─ hud.update(state, status)
```

Simulation rate is fixed and independent of frame rate. The host and clients
run the same loop; only the branch inside differs.

## Data flow

```
input ────► PlayerInput ─► [host] World.step() ─► WorldSnapshot
                                                       │
                        ┌──────────────────────────────┘
                        ▼
                  ClientView  ──►  RenderState  ──►  meshes + HUD
              (predict, reconcile,
               interpolate)
```

Note that the host renders through `ClientView` as well, feeding itself its own
snapshots. One rendering path for everyone, so there is one thing to reason
about and one thing to test.

## Extension points

Places designed to be extended, with the seam already in place:

| Want to…                           | Do this                                                                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Add a gameplay mechanic            | New file in `src/sim/systems/`, call it from `World.step()` — and give it a touch affordance, not just a key               |
| Add an input device                | New module in `src/render/`, fold it into `mergeIntents()`                                                                 |
| Add a networked field              | Add to `PlayerState` **and** `WorldSnapshot`, validate in `protocol.ts`, bump `PROTOCOL_VERSION`                           |
| Change the wire format             | Replace the codec in `protocol.ts`; JSON in, binary out                                                                    |
| Use a different signalling network | Swap the import in `transports/trystero.ts` (`@trystero-p2p/mqtt`, …)                                                      |
| Use a real server                  | Write a `Transport` over WebSocket; nothing above it changes                                                               |
| Replace the renderer               | Write against `RenderState`; `src/sim` and `src/net` are untouched                                                         |
| Add physics                        | `@babylonjs/havok` in `src/render` for visuals only, **or** a deterministic solver in `src/sim` — never both authoritative |
| Add art                            | `public/assets/manifest.json` — see [`ASSETS.md`](./ASSETS.md)                                                             |

## Deliberate non-goals

Things left out on purpose, so that a future agent does not "fix" them by
accident:

- **Lockstep networking.** One dropped packet stalls every player. Rejected in
  favour of host authority; see [`NETWORKING.md`](./NETWORKING.md).
- **Rollback netcode.** Needs a rewindable simulation and per-frame state
  history. Excellent for fighting games, poor value for a free-roaming arena.
- **Anti-cheat.** The host is trusted. In a serverless peer-to-peer game the
  host is another player, and there is no way around that without a server.
  Documented, not solved.
- **An ECS.** At this entity count, plain arrays and a sorted map are faster to
  read and faster to run. Introduce one when profiling says so, not before.
- **Server-side persistence.** No backend exists. Progress lives for the
  duration of a room.
