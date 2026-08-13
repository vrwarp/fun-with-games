# Module map

The ownership boundaries agents claim against. If two tasks land in different
rows, they can run in parallel; if they land in the same row, they cannot.

Keep this file current — it is the coordination mechanism, and a stale map is
worse than none.

## Modules

| Module             | Path                                                  | Public API                                      | Depends on                  | Typical work                                                                                     |
| ------------------ | ----------------------------------------------------- | ----------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------ |
| **shared**         | `src/shared/`                                         | `math.ts`, `emitter.ts`, `logger.ts`            | —                           | Utilities. Changes here touch everyone; prefer adding over modifying.                            |
| **sim-core**       | `src/sim/world.ts`, `types.ts`, `config.ts`, `rng.ts` | `World`, `WorldSnapshot`, `SimConfig`           | shared                      | State container, tick pipeline, snapshots. **High-traffic — coordinate.**                        |
| **sim-systems**    | `src/sim/systems/`                                    | one module per system                           | shared, sim-core types      | Movement, pickups, arena. **Best place for parallel gameplay work** — new systems are new files. |
| **net-protocol**   | `src/net/protocol.ts`                                 | `NetMessage`, `decodeMessage`, `encodeSnapshot` | sim types                   | Wire format and validation. **Serialising — one agent at a time.**                               |
| **net-session**    | `src/net/session.ts`, `prediction.ts`, `view.ts`      | `NetSession`, `ClientView`, `RenderState`       | shared, sim, net-protocol   | Authority, prediction, interpolation.                                                            |
| **net-transports** | `src/net/transports/`                                 | `Transport` implementations                     | `transport.ts`              | Trystero, BroadcastChannel, Memory. Independent of each other — **parallel-friendly**.           |
| **render**         | `src/render/`                                         | `Renderer`, `EntityViews`, `KeyboardInput`      | shared, sim types, net view | Babylon scene, meshes, camera, input.                                                            |
| **ui**             | `src/ui/`                                             | `Hud`, `Lobby`, `styles.css`                    | net view                    | DOM overlay. Independent of `render` — **parallel-friendly**.                                    |
| **bootstrap**      | `src/main.ts`, `index.html`                           | —                                               | everything                  | Wiring. Small, and touched by many features. **Coordinate.**                                     |
| **assets**         | `scripts/`, `assets/sources.json`, `public/assets/`   | manifest schema                                 | —                           | Asset generation and catalogue.                                                                  |
| **ci**             | `.github/workflows/`                                  | —                                               | —                           | Pipelines.                                                                                       |
| **docs**           | `docs/`, `CLAUDE.md`, `README.md`                     | —                                               | —                           | Parallel-friendly, one file per agent.                                                           |

## Shared files

Files several agents will plausibly need at once. Not owned by anyone; treat
edits as coordination events, keep diffs minimal and additive, and say so in
your PR description.

| File                          | Why it is contended                 | How to keep merges clean                               |
| ----------------------------- | ----------------------------------- | ------------------------------------------------------ |
| `src/sim/types.ts`            | Every gameplay feature adds a field | Append fields; never reorder or reformat               |
| `src/sim/config.ts`           | Every feature adds a tunable        | Append; group with a comment                           |
| `src/sim/world.ts`            | `step()` is the ordered pipeline    | Add one call at the right position; do not restructure |
| `src/net/protocol.ts`         | Any new networked field             | Add a validator; bump `PROTOCOL_VERSION` once          |
| `src/main.ts`                 | New subsystems need wiring          | Add one call; extract to a helper if it grows          |
| `public/assets/manifest.json` | Generated by two scripts            | **Never hand-edit.** Regenerate and commit             |

### `World.step()` stays explicit

It is tempting to replace the hardcoded system calls with a registry so agents
can add systems without touching a shared file. Don't.

Determinism requires a fixed, known execution order. A registry either
reintroduces the shared file (an ordering array) or makes order depend on
import order and module resolution — which is exactly the class of bug that
produces desyncs nobody can reproduce. An explicit, ordered pipeline that
occasionally causes a one-line merge conflict is the better trade.

## Extension points

Where to add things so the diff stays inside one module:

| Add               | Where                                | Touches                              |
| ----------------- | ------------------------------------ | ------------------------------------ |
| Gameplay mechanic | `src/sim/systems/<name>.ts`          | sim-systems + one line in `world.ts` |
| Tunable           | `src/sim/config.ts`                  | shared file, append only             |
| Networked field   | `types.ts` + `protocol.ts`           | two shared files — announce it       |
| Message type      | `src/net/protocol.ts` + `session.ts` | net-protocol, net-session            |
| Transport         | `src/net/transports/<name>.ts`       | net-transports only                  |
| Visual effect     | `src/render/`                        | render only                          |
| HUD element       | `src/ui/hud.ts`                      | ui only                              |
| Placeholder art   | `scripts/generate-assets.mjs`        | assets only                          |
| Test helper       | `tests/helpers/`                     | tests only                           |
