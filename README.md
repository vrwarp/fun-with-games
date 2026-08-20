# Fun With Games

A peer-to-peer 3D arena built with **Babylon.js** and **decentralized WebRTC** —
no game server, no signalling server, no accounts.

It is a **starter kit with a game kit inside**: eleven playable modes (tag,
infection, blaster arena, knockout, soccer, capture the flag, king of the
hill, checkpoint racing, crown keep-away, a timed shard rush and an endless
sandbox) built from a library of composable, config-driven systems — match
phases, teams, hp/combat, projectiles, roles, a ball with goals, zones,
carryable items, timed status effects, power-ups and deterministic bots.
Most new games are a preset, not new code; see
[`docs/RECIPES.md`](./docs/RECIPES.md).

```bash
npm install
npm run dev
```

Then open <http://localhost:5173> — the lobby has a mode picker. For
multiplayer without leaving your machine, open two tabs at
<http://localhost:5173/?net=broadcast&room=test&mode=tag>. No second player
handy? Add `&bots=3`.

## What you get

- **A game kit.** Eleven modes out of the box and the systems to build many
  more: rounds and win conditions, teams, combat, projectiles, tag roles,
  ball + goals, hills/checkpoints/bases, flags and crowns, timed effects,
  power-ups, and bots that understand every mode. All simulation-side, all
  deterministic, all covered by headless tests.
- **Real netcode.** Host-authoritative simulation with client-side prediction,
  server reconciliation, entity interpolation, and automatic host migration
  when the host disconnects (bots survive the handover too).
- **Genuinely serverless.** [Trystero](https://github.com/dmotz/trystero)
  handles matchmaking over decentralized relays (Nostr by default); game
  traffic then flows directly browser-to-browser over encrypted WebRTC data
  channels.
- **A headless simulation.** `src/sim` is pure TypeScript — no Babylon, no DOM,
  no clock. Which means multiplayer is testable in Node, in milliseconds.
- **Designed for mobile, not ported to it.** A thumbstick, a camera that
  follows the direction of travel so you can play one-handed, portrait-specific
  framing, mobile-first CSS, safe-area insets, a capped pixel ratio, a screen
  wake lock, and a web app manifest so it installs. Verified by an e2e suite
  that runs on a real touch device profile, not a narrow desktop window.
- **A test suite you will actually run.** 300+ headless tests in a few
  seconds — including a sweep that plays every game mode with bots — plus 39
  Playwright tests that drive two real browser tabs and a phone.
- **Enforced architecture.** The layering is checked by ESLint, so `src/sim`
  physically cannot import Babylon or reach for `Math.random()`.
- **An asset pipeline with no binaries.** Procedural glTF generation, a
  catalogue-driven CC0 downloader, and CI that fails on missing licence
  metadata.
- **CI and deployment.** Four parallel checks on every push; GitHub Pages
  deploy on `main`.

## How it fits together

```
shared  ←  sim  ←  net  ←  render / ui  ←  main
```

Dependencies point one way, and the linter enforces it.

The load-bearing idea is that **the simulation knows nothing about rendering or
networking**. It is a function of `(seed, config, inputs)`. That is what makes
a full multiplayer session testable without a browser, makes a desync
reproducible from a seed and an input log, and lets the renderer be replaced
without touching gameplay.

| Layer        | What lives there                                                       |
| ------------ | ---------------------------------------------------------------------- |
| `src/shared` | Math, typed events, logging                                            |
| `src/sim`    | The game: world, movement, pickups, arena — headless and deterministic |
| `src/net`    | Transports, wire protocol, authority, prediction                       |
| `src/render` | Babylon scene, meshes, follow-camera, input, device APIs               |
| `src/ui`     | DOM overlay: lobby, HUD, credits                                       |

## Commands

```bash
npm run dev              # dev server
npm run build            # typecheck + production build
npm test                 # unit + integration (~1s, no browser)
npm run test:e2e         # Playwright
npm run verify           # everything CI runs, except e2e

npm run assets:generate  # regenerate procedural art
npm run assets:fetch     # download catalogued CC0 art
npm run assets:verify    # manifest + licence check
```

## Playing

Desktop:

| Input                    | Action                              |
| ------------------------ | ----------------------------------- |
| `W` `A` `S` `D` / arrows | Move (relative to the camera)       |
| `Shift`                  | Sprint                              |
| `Space` / `J`            | Primary action (fire, in gun modes) |
| `E` / `K`                | Secondary action (yours to bind)    |
| Drag                     | Orbit the camera                    |
| Scroll                   | Zoom                                |

Mobile — the primary target:

| Input                       | Action                               |
| --------------------------- | ------------------------------------ |
| Thumbstick (bottom left)    | Move — analog: half-push, half speed |
| Push the stick to the rim   | Sprint                               |
| **A** button (bottom right) | Primary action, in modes that use it |
| _nothing_                   | The camera follows you               |
| Drag anywhere else          | Take over the camera                 |
| Pinch                       | Zoom                                 |

Playable one-handed: the camera swings behind your direction of travel by
itself, so you never need a second thumb to see where you are going. Dragging
takes over for a few seconds if you want to look around.

The stick appears automatically on touch devices. Because it is a DOM overlay
rather than a canvas widget, one thumb can steer while another orbits, with no
gesture arbitration.

On Android and iOS you can install it from the browser menu — it runs
fullscreen, with its own icon, and keeps the screen awake while you play.

URL parameters: `room`, `mode`, `bots`, `name`, `color`, `net=broadcast`,
`autojoin=1`, `log=debug`.

## Documentation

| Document                                               | Read it when                                |
| ------------------------------------------------------ | ------------------------------------------- |
| [`CLAUDE.md`](./CLAUDE.md)                             | You are an agent about to change something  |
| [`docs/RECIPES.md`](./docs/RECIPES.md)                 | You want to make a game — start here        |
| [`docs/GAME_KIT.md`](./docs/GAME_KIT.md)               | Reference for modes, systems and effects    |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)       | Before your first non-trivial change        |
| [`docs/NETWORKING.md`](./docs/NETWORKING.md)           | Anything touching multiplayer               |
| [`docs/TESTING.md`](./docs/TESTING.md)                 | Writing tests, or wondering why one is slow |
| [`docs/ASSETS.md`](./docs/ASSETS.md)                   | Adding or generating art                    |
| [`docs/MODULES.md`](./docs/MODULES.md)                 | Picking up a task                           |
| [`docs/PARALLEL_AGENTS.md`](./docs/PARALLEL_AGENTS.md) | Several agents are working at once          |

## Deployment

Pushing to `main` builds and publishes to GitHub Pages. Enable it once under
**Settings → Pages → Source → GitHub Actions**; the workflow resolves the base
path itself, including for custom domains.

## Known limitations

Stated plainly, because a starter kit that pretends to be finished is worse
than one that is honest:

- **The host is trusted.** It is another player, and it can lie about the
  world. Unfixable without a server; non-host peers are already prevented from
  dictating state.
- **No TURN server.** Peers behind symmetric NAT may fail to connect. Add
  `turnConfig` if you need it — TURN is a relay someone has to run.
- **Public relays are best-effort.** Discovery can be slow. Self-host a relay
  for production.
- **Rooms are ephemeral.** No backend, so no persistence beyond a session.
- **The Trystero adapter is not covered by tests.** E2E multiplayer runs over
  `BroadcastChannel` so CI does not depend on public relays or UDP egress.

## Licence

MIT — see [`LICENSE`](./LICENSE). Bundled assets are procedurally generated and
CC0; see [`public/assets/ATTRIBUTION.md`](./public/assets/ATTRIBUTION.md).

The running game has its own credits panel, reachable from the corner of the
HUD. It is generated from the asset manifest, so anything you catalogue is
credited automatically — which is what keeps attribution licences (CC-BY and
similar) satisfied for players, not just in the repository.
