# Architecture decision records

Short records of decisions that are expensive to reverse, so a future agent can
tell "this was considered and rejected" from "nobody thought about this".

The big decisions already have their rationale written up where the code lives:

| Decision                                     | Where it is argued                                                           |
| -------------------------------------------- | ---------------------------------------------------------------------------- |
| Trystero for decentralized WebRTC signalling | [`../NETWORKING.md`](../NETWORKING.md#choosing-a-decentralized-webrtc-layer) |
| Host-authoritative with an elected host      | [`../NETWORKING.md`](../NETWORKING.md#authority-model)                       |
| Headless, deterministic simulation           | [`../ARCHITECTURE.md`](../ARCHITECTURE.md#the-one-idea)                      |
| Full snapshots rather than deltas            | [`../NETWORKING.md`](../NETWORKING.md#protocol)                              |
| BroadcastChannel for e2e multiplayer         | [`../TESTING.md`](../TESTING.md#why-e2e-multiplayer-uses-broadcastchannel)   |
| No ECS, no rollback, no anti-cheat           | [`../ARCHITECTURE.md`](../ARCHITECTURE.md#deliberate-non-goals)              |

Add an ADR here when you make a _new_ decision of that weight — particularly
one that reverses something above. Copy `template.md` and number it
sequentially.

Do not add one for ordinary implementation choices. An ADR directory full of
trivia is one nobody reads.
