## What and why

<!-- What changed, and what problem it solves. One or two sentences is fine. -->

## Modules touched

<!-- From docs/MODULES.md. This is how parallel work stays untangled. -->

- [ ] shared
- [ ] sim-core (`world.ts`, `types.ts`, `config.ts`, `rng.ts`)
- [ ] sim-systems
- [ ] net-protocol
- [ ] net-session
- [ ] net-transports
- [ ] render
- [ ] ui
- [ ] bootstrap (`main.ts`)
- [ ] assets
- [ ] ci
- [ ] docs

**Shared files edited:** <!-- e.g. src/sim/types.ts (appended a field) — or "none" -->

## Checks

- [ ] `npm run verify` passes
- [ ] `npm run test:e2e` passes, or is not applicable to this change
- [ ] Works on mobile: every new action is reachable by touch, touch targets
      are ≥ 44px, and the layout survives a phone viewport
- [ ] New mutable simulation state is included in `WorldSnapshot`
- [ ] `PROTOCOL_VERSION` bumped if any wire shape changed
- [ ] New assets have licence metadata and `npm run assets:verify` passes
- [ ] Docs updated if this invalidated any

## Notes for reviewers

<!-- Trade-offs, things you deliberately left out, anything you are unsure of.
     If you changed the order of operations in World.step(), say so here —
     it changes simulation results. -->
