# Working in parallel

How several agents extend this repository at the same time without producing a
merge disaster.

## What actually makes parallel work possible

Not process. Four structural properties, in rough order of how much they buy:

### 1. Enforced layering

`shared ← sim ← net ← render/ui ← main`, checked by ESLint, not by review. An
agent in `src/sim` and an agent in `src/render` cannot break each other,
because the compiler and the linter will not let them reach across.

The rule that carries the most weight: `src/sim` may not import Babylon, the
DOM, the network, or a clock. It is enforced down to
`no-restricted-syntax` bans on `Math.random()` and `Date.now()`.

### 2. Fast, hermetic tests

`npm test` is ~1 second and needs no browser. An agent can verify its own work
in a tight loop instead of pushing to CI and waiting — and, crucially, can
verify _after rebasing onto someone else's change_ without it being a chore.

### 3. Seams instead of shared mutable code

`Transport`, `RenderState`, `WorldSnapshot` and `SimConfig` are contracts. Work
happens behind them. Three transports live side by side and never touch each
other.

### 4. Generated files, not hand-edited ones

`public/assets/manifest.json` and `ATTRIBUTION.md` are produced by scripts and
verified in CI. Two agents adding art do not hand-merge JSON.

## The protocol

### Before you start

1. **Read `docs/MODULES.md`** and identify which module(s) your task lands in.
2. **Check for conflicts.** If another agent is already in your module, either
   pick different work or sequence behind them. Two agents in
   `src/sim/systems/` writing _different_ files is fine; two agents in
   `src/net/protocol.ts` is not.
3. **Declare it.** Open an issue with the Feature template, or state it in your
   first message: which modules you will touch, and which shared files.

### While you work

- **Branch:** `claude/<short-topic>-<id>`, from `main`. Never commit to `main`.
- **Prefer new files.** A new system in `src/sim/systems/` merges cleanly. A
  40-line insertion into `world.ts` does not.
- **Keep shared-file diffs additive.** Append a field; do not reorder, do not
  reformat, do not "tidy while you are in there". A one-line append merges
  automatically; a reformat conflicts with everything.
- **Do not fix another module to make yours work.** File it, or write an
  adapter inside your own layer. Cross-module drive-by fixes are the single
  biggest cause of conflicts.
- **Rebase early and often.** `git fetch origin && git rebase origin/main`.
  Then re-run `npm test` — one second, no excuse.

### Before you finish

```bash
npm run verify        # format, lint, typecheck, test, build
npm run test:e2e      # if you touched render/, ui/, main.ts, or a transport
```

State in your PR description which modules you touched and which shared files
you edited.

## Conflict playbook

| Conflict                                  | Resolution                                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Both appended to `types.ts` / `config.ts` | Keep both. Order is irrelevant.                                                                              |
| Both bumped `PROTOCOL_VERSION`            | Second to merge takes the next integer. Never reuse or renumber.                                             |
| Both added a call in `World.step()`       | Keep both, but **decide the order deliberately** — it changes simulation results. Note the choice in the PR. |
| Both regenerated `manifest.json`          | Discard both versions; re-run `npm run assets:generate` (and `assets:fetch` if relevant) on the merged tree. |
| Both edited `main.ts` wiring              | Keep both calls. If it is getting long, extract a helper — as a separate PR.                                 |
| Snapshot test fails after a merge         | Someone added state without snapshotting it. Fix the state, not the test.                                    |

## Task shapes that parallelise well

Roughly one module each, minimal shared-file contact:

- A new gameplay system (`src/sim/systems/`) — hazards, power-ups, team scoring
- A new transport (`src/net/transports/`) — WebSocket, self-hosted relay
- Visual work (`src/render/`) — particles, post-processing, better lighting
- HUD and menus (`src/ui/`) — scoreboard, settings, credits panel
- Asset work (`scripts/`, `assets/`) — new placeholders, catalogue entries
- Test coverage (`tests/`) — one file per agent
- Documentation (`docs/`) — one file per agent

## Task shapes that do not

Sequence these; do not fan them out:

- **Changing the authority model.** Touches `session.ts`, `protocol.ts`,
  `prediction.ts` and every integration test at once.
- **Changing the snapshot format.** `types.ts`, `world.ts`, `protocol.ts`,
  `prediction.ts`.
- **Renaming or moving modules.** Conflicts with literally everything in
  flight.
- **Reformatting.** Enormous diffs, zero behaviour change, guaranteed
  conflicts. Prettier already runs in CI; if a file is misformatted, that is a
  bug in someone's workflow, not a licence to reformat the tree.
- **Broad dependency upgrades.** Let Dependabot's grouped PRs handle them.

## For the human (or agent) orchestrating

- **Fan out by module, not by file count.** "Add a dash mechanic" and "add a
  particle system" are parallel. "Add a dash mechanic" and "add a slide
  mechanic" both live in movement and are not.
- **Sequence the shared-file work first.** If three features all need a new
  `PlayerState` field, land the field once, then fan out.
- **Give each agent its own worktree** so branches do not fight over the
  working directory:

  ```bash
  git worktree add ../fwg-dash   claude/dash-01
  git worktree add ../fwg-hud    claude/hud-02
  ```

- **Let CI be the arbiter.** The four jobs are independent, so a failure names
  the layer that broke: `quality` is layering or style, `test` is logic,
  `build` is types or stale assets, `e2e` is the browser.
