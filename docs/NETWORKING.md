# Networking

## Choosing a decentralized WebRTC layer

The brief was peer-to-peer multiplayer over a _decentralized_ protocol: no
game server, and no signalling server we have to run.

WebRTC gives browsers direct peer-to-peer data channels, but it cannot
bootstrap itself — two browsers must first exchange session descriptions and
ICE candidates through some third party. That exchange is the only thing that
needs infrastructure, and it is the thing "serverless WebRTC" libraries solve.

### Candidates evaluated

| Library                                               | Signalling                                                                             | Verdict                                                                                                                                    |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **[Trystero](https://github.com/dmotz/trystero)**     | Nostr (default), MQTT, BitTorrent, IPFS, Supabase, Firebase, or a self-hosted WS relay | **Chosen.** Genuinely decentralized by default, one API across every strategy, rooms/actions/presence out of the box, actively maintained. |
| [PeerJS](https://peerjs.com/)                         | Its own broker server                                                                  | Rejected: a central broker is exactly what we are avoiding. Self-hosting one reintroduces the server.                                      |
| [P2PT](https://github.com/subins2000/p2pt)            | Public WebTorrent trackers                                                             | Decentralized, but trackers are a narrower and flakier pool than Nostr relays, and the API is lower level.                                 |
| [NetplayJS](https://github.com/rameshvarun/netplayjs) | Bundled, with rollback netcode                                                         | Opinionated in a way that fights this project: it wants to own the game loop, and rollback is the wrong model here.                        |
| [libp2p](https://libp2p.io/)                          | DHT / circuit relay                                                                    | Powerful and heavy. Bundle size and conceptual overhead are hard to justify for a starter kit.                                             |
| Manual copy-paste SDP                                 | The players                                                                            | No infrastructure at all, and unusable in practice.                                                                                        |

### Why Trystero

- **Decentralized by default.** The Nostr strategy spreads signalling across
  hundreds of independent public relays. No single operator to depend on.
- **Signalling only.** Once peers are connected, game traffic flows directly
  browser-to-browser over WebRTC data channels, end-to-end encrypted, and never
  touches a relay again.
- **Strategy is one import.** `trystero` (Nostr) can become
  `@trystero-p2p/mqtt`, `@trystero-p2p/torrent`, or a self-hosted
  `@trystero-p2p/ws-relay` without changing a line of calling code.
- **Right level of abstraction.** Rooms, presence, and namespaced actions —
  and nothing about game loops.

### Honest limitations

- Public relays are best-effort. Discovery can be slow, and a bad relay day is
  a bad matchmaking day. For production, self-host a relay and keep a
  decentralized strategy as fallback.
- No TURN server is configured, so peers behind symmetric NAT may fail to
  connect. Add `turnConfig` in `createTrysteroTransport` if you need that; TURN
  is a relay you have to run or pay for.
- Anyone who knows the app id and room name can join. Set `password` to gate
  the handshake.

## Authority model

**Host-authoritative, with an elected host and client-side prediction.**

### Election

Every peer independently takes the lexicographically smallest peer id it can
see, itself included (`electHost` in `src/net/transport.ts`).

No negotiation, no election messages, no split-brain protocol: peers that agree
on the membership set agree on the host, and they get **host migration for
free** — when the host disappears, the next-smallest id is already the answer
everywhere.

The honest cost: during the window where peers disagree about membership, they
can disagree about the host. `NetSession` resolves this by adopting any peer
with a _stronger_ claim (a lower id) that is actively publishing snapshots, so
a split view converges rather than persisting.

### Why not the alternatives

- **Lockstep / deterministic peer-to-peer.** Every peer simulates every input;
  no authority needed. But every peer must wait for the slowest, one dropped
  packet stalls the room, and it demands cross-browser floating-point
  determinism. Wrong trade for a casual arena.
- **Rollback netcode.** Superb for two-player fighting games. Needs a
  rewindable simulation, per-frame state history, and careful re-simulation
  budgeting. Large complexity cost for a free-roaming arena with pickups.
- **A dedicated server.** Solves cheating and authority cleanly — and is
  exactly the thing the brief excluded. (If you ever want it, write a
  `Transport` over WebSocket; nothing above that seam changes.)

### What this means for cheating

The host is a player, and it is trusted. A malicious host can lie about the
world. There is no fix for that without a server; it is documented rather than
pretended away.

What _is_ defended:

- Non-host peers cannot dictate state — snapshots from anyone other than the
  elected host are ignored.
- Every inbound message is validated against a strict schema
  (`decodeMessage`). Malformed input is dropped, never partially applied.
- Movement axes are clamped, names truncated, colours restricted to hex.
  A peer sending `moveX: 1e9` moves exactly as fast as everyone else.

Both behaviours are covered in `tests/integration/session.test.ts` under
"malicious peers".

## Protocol

One data channel, four message types, discriminated by `type`. Version-gated:
mismatched `PROTOCOL_VERSION` traffic is ignored outright, because in a
decentralized game two client versions **will** meet in the wild.

| Message    | Direction     | Rate    | Purpose                                    |
| ---------- | ------------- | ------- | ------------------------------------------ |
| `hello`    | any → all     | on join | Name and colour                            |
| `input`    | client → host | 30 Hz   | One tick of intent (axes, sprint, buttons) |
| `snapshot` | host → all    | 15 Hz   | Full authoritative world state             |
| `bye`      | any → all     | on exit | Best-effort departure notice               |

Protocol **v2** carries the game kit: an action-button bitfield in inputs
(masked against `BUTTON_MASK` on decode), and in snapshots the phase state,
per-player kit fields (team, role, hp, lives, checkpoint/lap, bot flag, the
effects map), team scores, the ball, projectiles, items and zone ownership.
Everything is validated against a hostile sender, including **size ceilings**
on every collection (players, projectiles, effects, …) so a malicious host
cannot make clients validate a million entries. Effect ids must match
`/^[a-z][a-z0-9_-]{0,23}$/` — but note that a NEW effect id is not a protocol
change; the map is carried generically.

Protocol **v3** adds the vertical axis: heights and vertical velocity for
players, pickups, projectiles and carried items, plus jump bookkeeping
(`grounded`, `jumps`, `jumpLatch`). Every mode carries these fields whether or
not gravity is enabled — a couple of floats per entity, in exchange for one
code path instead of two.

Protocol **v4** adds racing: three per-player lap-timing fields (when the
current lap started, the last lap, the best lap). Nothing else about the
racing needed a version — the slipstream, the wing and the tyres are all
timed effects, and the effects map has always travelled whole.

Protocol **v5** adds the tyre stacks: the trackside walls became bodies the
cars exchange momentum with, so their positions and velocities are mutable
state and travel in every snapshot (`tyreStacks`, index-identified — the
roster is fixed by the circuit, so homes never need to travel, only where
the racing has since shoved each stack). Quantized to centimetres; a parked
wall is rows of short zeroes.

New abilities that only need a button do **not** bump the version: both
button bits already travel. Camera view and sprite style never touch the wire
at all, which is precisely why two players can watch the same match in
different projections. Bump `PROTOCOL_VERSION` only when a message _shape_
changes; never renumber or reuse a version.

**Snapshots are full state, not deltas.** Deltas would be smaller, but every
dropped packet would need recovery machinery. Full snapshots mean a lost packet
costs 66 ms of latency and nothing else — which is why the 20%-packet-loss
integration test passes without any special handling.

Positions are quantized to millimetres on the wire. Clients are not
authoritative, so the lost precision cannot accumulate; the next snapshot
overwrites it. The simulation always keeps full precision.

**Same config or no contact:** every peer in a room must run the same
`SimConfig`. `main.ts` guarantees it by appending the game-mode id to the
transport room name, so differently-configured clients land in different
rooms rather than desyncing in the same one.

## Client-side netcode

Three problems, three mechanisms — all in `ClientView`
(`src/net/prediction.ts`):

### 1. Prediction — local input must feel instant

The local player is simulated immediately, without waiting a round trip. Both
prediction and the host use the **same** `integratePlayer` function; if they
ever diverge, every snapshot produces a visible correction.

### 2. Reconciliation — the host is still right

Each snapshot carries `lastInputSeq`, the newest input the host has consumed.
On arrival the client resets the local player to the authoritative state,
discards acknowledged inputs, and replays the rest.

The leftover difference is blended out over ~120 ms so a correction reads as
drift rather than a teleport. Corrections larger than 4 units snap instead —
that size is a respawn or a host migration, and sliding across the arena would
look broken.

### 3. Interpolation — remotes arrive at 15 Hz, render at 60

Remote players are drawn 120 ms in the past, interpolated between the two
snapshots straddling that moment. When the network stalls, the newest snapshot
is held rather than extrapolated: a stalled remote player is better than a
confidently wrong one.

### 4. Render interpolation — the screen is faster than the simulation

The simulation steps at 30 Hz; a display refreshes at 60 Hz or more. Sampled
naively, the local player's predicted position is a **step function**: still
for a frame, then a jump. Static scenery has no such problem, so it glides past
continuously while the character stutters against it — which looks like the
character vibrating, and is easy to misread as a rendering or culling fault.

`NetSession.sample()` therefore passes `ClientView` the leftover in its
fixed-timestep accumulator, and the local player is drawn between the previous
step and the current one.

The cost is honest: this renders the local player up to one tick (~33 ms)
behind. That is visual only — input is still consumed on the next tick either
way — and it is the standard fixed-timestep rendering trade. Two details matter:

- An ordinary reconcile must **not** re-anchor the interpolation, because
  reconciling re-derives the same tick rather than advancing time. Collapsing
  the span there would make the player jump on every snapshot, which at a
  2-tick snapshot interval is most of them.
- A teleport-sized correction **must** collapse it, so a snap stays a snap
  instead of becoming a slide.

`tests/integration/session.test.ts` guards this end to end by rendering at
60 Hz over a 30 Hz simulation and asserting no frame stalls.

## Timing

| Parameter           | Value  | Where                                |
| ------------------- | ------ | ------------------------------------ |
| Simulation tick     | 30 Hz  | `SimConfig.tickRate`                 |
| Snapshot broadcast  | 15 Hz  | `SimConfig.snapshotIntervalTicks`    |
| Input send          | 30 Hz  | one per tick                         |
| Interpolation delay | 120 ms | `ClientView` — must exceed 66 ms     |
| Error smoothing     | 120 ms | `ClientView`                         |
| Max frame catch-up  | 250 ms | `NetSession` — avoids a death spiral |

Interpolation delay must stay above the snapshot interval, or there is nothing
to interpolate towards and remote players stutter.

## Testing it

`MemoryNetwork` implements `Transport` in-process against a **virtual clock**,
with configurable latency, jitter and seeded packet loss. `SessionHarness`
builds real `NetSession` instances on top.

```ts
const harness = new SessionHarness({ latencyMs: 80, dropRate: 0.2 });
harness.join('alpha');
harness.join('bravo');
harness.setIntent('bravo', 1, 0);
harness.advance(4000); // 4 simulated seconds, in microseconds
expect(harness.host()?.id).toBe('alpha');
```

Nothing sleeps, nothing is timing-dependent, and a failure reproduces exactly
from the seed. Host migration, late joiners, packet loss and hostile peers are
all covered this way in `tests/integration/session.test.ts`.

Browser-level multiplayer is covered by Playwright using the
`BroadcastChannel` transport (`?net=broadcast`) — two real pages, real
rendering, no dependency on public relays or UDP egress from CI.

## Swapping the signalling strategy

```ts
// src/net/transports/trystero.ts
import { joinRoom, selfId } from 'trystero'; // Nostr (default)
import { joinRoom, selfId } from '@trystero-p2p/mqtt'; // MQTT
import { joinRoom, selfId } from '@trystero-p2p/torrent'; // BitTorrent
import { joinRoom, selfId } from '@trystero-p2p/ws-relay'; // your own relay
```

Install the matching package; nothing else changes. Recommended order of
robustness for decentralized use: Nostr, then MQTT, then BitTorrent, then IPFS.
