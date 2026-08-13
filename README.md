# Fun With Games

A peer-to-peer 3D arena built with **Babylon.js** and **decentralized WebRTC** —
no game server, no signalling server, no accounts.

It is a **starter kit**. The game itself is small on purpose: roam a seeded
arena, collect shards, outscore the other players. What it is really for is
everything around that — the netcode, the seams, and a test suite that runs a
three-peer multiplayer session with packet loss in about a second.

```bash
npm install
npm run dev
```

Then open <http://localhost:5173>. For multiplayer without leaving your
machine, open two tabs at
<http://localhost:5173/?net=broadcast&room=test>.

## What you get

- **Real netcode.** Host-authoritative simulation with client-side prediction,
  server reconciliation, entity interpolation, and automatic host migration
  when the host disconnects.
- **Genuinely serverless.** [Trystero](https://github.com/dmotz/trystero)
  handles matchmaking over decentralized relays (Nostr by default); game
  traffic then flows directly browser-to-browser over encrypted WebRTC data
  channels.
- **A headless simulation.** `src/sim` is pure TypeScript — no Babylon, no DOM,
  no clock. Which means multiplayer is testable in Node, in milliseconds.
- **A test suite you will actually run.** 172 headless tests in ~1 second,
  plus 17 Playwright tests that drive two real browser tabs.
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
| `src/render` | Babylon scene, meshes, camera, input                                   |
| `src/ui`     | DOM overlay: lobby and HUD                                             |

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

| Input                    | Action                        |
| ------------------------ | ----------------------------- |
| `W` `A` `S` `D` / arrows | Move (relative to the camera) |
| `Shift`                  | Sprint                        |
| Drag                     | Orbit the camera              |
| Scroll                   | Zoom                          |

URL parameters: `room`, `name`, `color`, `net=broadcast`, `autojoin=1`,
`log=debug`.

## Documentation

| Document                                               | Read it when                                |
| ------------------------------------------------------ | ------------------------------------------- |
| [`CLAUDE.md`](./CLAUDE.md)                             | You are an agent about to change something  |
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
