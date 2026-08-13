# Assets

How to get art into this game — and, just as importantly, how to do it without
ending up with a repository full of binaries whose licences nobody recorded.

## The rule that shapes everything else

**The game must always be playable with no art at all.**

Procedural geometry is the baseline, not a fallback for emergencies. Models are
an enhancement layered on top, and every code path that touches one is written
to fail soft:

- `loadManifest()` returns an empty manifest if `manifest.json` is missing or
  malformed.
- `loadModel()` returns `null` on any failure rather than throwing.
- `main.ts` keeps the procedural capsule when either returns nothing.

This is what keeps CI fast (no binaries to download), keeps `npm install &&
npm run dev` working offline, and keeps a broken asset from turning into a
broken game.

## The four ways to get an asset

Ranked by how well they suit an agent working unattended.

### 1. Procedural geometry at runtime — the default

`MeshBuilder` shapes and canvas-drawn textures, generated in the browser. Zero
files, zero licences, zero load time.

Already in use: the checkerboard floor, arena walls, obstacle boxes, capsule
players, octahedron pickups, and the billboard name labels
(`src/render/textures.ts`).

Best for: greyboxing, placeholders, anything geometric, and any effect a
texture can be drawn rather than shipped.

### 2. Procedural glTF files — `npm run assets:generate`

Generates real `.gltf` files from a small dependency-free writer
(`scripts/lib/gltf.mjs`). No network, no install step, deterministic output —
re-running leaves git clean, and CI enforces that.

It also draws the **app icons** (`public/icons/`) with a tiny PNG encoder in
`scripts/lib/png.mjs` — including the maskable variant Android needs. Icons are
generated rather than committed as binaries for the same reason as everything
else here: a PNG in a diff is something no reviewer can actually check, whereas
a function that draws one is.

Ships three model placeholders in `public/assets/generated/`:

| id       | file          | what it is                          |
| -------- | ------------- | ----------------------------------- |
| `player` | `runner.gltf` | Blocky humanoid, 1.7 units tall     |
| `shard`  | `shard.gltf`  | Faceted crystal for pickups         |
| `crate`  | `crate.gltf`  | Braced crate for obstacles or props |

The `player` model is wired up by default, so the shipped demo exercises the
whole pipeline — manifest → loader → glTF → prototype swap — rather than
merely providing it.

Why this exists at all, when runtime geometry is easier: it produces _files_
that travel the same path real art will, so the pipeline is tested by the
assets it generates. It also gives an agent a way to author new placeholder
shapes in a reviewable text diff.

To add one, edit `scripts/generate-assets.mjs`:

```js
function towerModel() {
  return merge([
    box({ center: [0, -0.5, 0], size: [1.2, 1, 1.2] }),
    box({ center: [0, 0.5, 0], size: [0.8, 1, 0.8] }),
  ]);
}
```

Add it to `MODELS`, run `npm run assets:generate`, commit the result.

**Constraints of the writer** (deliberate — it is ~150 lines): static meshes
only, flat normals, one material, no textures, no skinning, no animation,
65 535 vertices max. For anything beyond that, use option 3 or 4.

### 3. Curated CC0 art — `npm run assets:fetch`

Downloads what `assets/sources.json` catalogues into `public/assets/vendor/`,
which is **gitignored**. The catalogue is versioned; the binaries are not.
Clones stay small, and art never lands in code review.

Sources worth knowing, all verified as of writing:

| Source                                                                           | Licence          | Notes                                                                                                       |
| -------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------- |
| [Kenney](https://kenney.nl/)                                                     | CC0              | ~40k assets in consistent styles. The best single source for a coherent look without an artist.             |
| [Quaternius](https://quaternius.com/)                                            | CC0              | Low-poly packs, characters and environments, many rigged.                                                   |
| [Poly Pizza](https://poly.pizza/)                                                | Mostly CC0       | Hosts the archived Google Poly collection. Check per-model licences.                                        |
| [Poly Haven](https://polyhaven.com/)                                             | CC0              | HDRIs, PBR textures, some models. Best-in-class for lighting.                                               |
| [Khronos glTF Sample Assets](https://github.com/KhronosGroup/glTF-Sample-Assets) | Mixed, per-model | Canonical, versioned, git-stable. Ideal for testing loader features. Licences vary — read each `README.md`. |
| [OpenGameArt](https://opengameart.org/)                                          | Mixed            | Large but requires per-asset licence checking.                                                              |

Adding one:

```jsonc
{
  "id": "barrel",
  "url": "https://example.com/barrel.glb",
  "file": "barrel.glb",
  "scale": 1,
  "enabled": true,
  "license": {
    "name": "CC0-1.0",
    "source": "https://example.com/barrel",
    "author": "Someone",
  },
}
```

Then `npm run assets:fetch`. It writes the file, records its SHA-256 in the
manifest, and regenerates `ATTRIBUTION.md`. Copy the printed checksum into
`sha256` in the catalogue to pin it — after that, an upstream change is a hard
failure instead of a surprise.

Note the catalogue's default entry (Khronos's Fox) is `"enabled": false`. It
is there as a worked example of correct multi-licence metadata, not as
something the demo needs.

### 4. AI-generated 3D — for one-off hero assets

Text-to-3D is now good enough for props, and roughly at "needs a pass in
Blender" quality for characters. Current tools that export glTF/GLB:

| Tool                                 | Notes                                                                                                       |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| [Meshy](https://www.meshy.ai/)       | Text- and image-to-3D, PBR textures, auto-rigging and animation presets. Broadest single-platform coverage. |
| [Tripo AI](https://www.tripo3d.ai/)  | Fast (under a minute), auto UV unwrap, glTF/FBX export. No native rigging.                                  |
| [Hyper3D Rodin](https://hyper3d.ai/) | GLB/glTF/USDZ export; strong on clean topology.                                                             |
| Tencent Hunyuan3D                    | Open-weights; self-hostable if you need an offline or auditable pipeline.                                   |

**Do not wire an AI generation service into the build.** These are interactive,
credentialed, non-deterministic and often non-free. The workflow is: generate
by hand, check the licence and commercial-use terms of the _service_ as well as
the output, optimise it, then add it to `assets/sources.json` (or commit it if
small) so the result is reproducible.

Licensing here is genuinely unsettled — terms differ per provider and change.
Record what the terms were when you downloaded it, in the manifest, where the
next agent will find it.

## The manifest

`public/assets/manifest.json` is the single place the game learns what art
exists. It is **generated** — never hand-edit it; run the scripts and commit
what they write.

```jsonc
{
  "version": 1,
  "models": [
    {
      "id": "player", // what code asks for
      "url": "assets/generated/runner.gltf", // relative to the site base
      "scale": 1, // applied after load
      "origin": "generated", // "generated" | "vendor"
      "description": "…",
      "license": { "name": "CC0-1.0", "source": "…", "author": "…" },
    },
  ],
}
```

`origin` is what lets the two producers coexist: each rewrites only its own
entries. `generated` files are committed and must exist; `vendor` files are
gitignored and may legitimately be absent.

### Consuming a model

`main.ts` looks up `player` and swaps the prototype mesh:

```ts
const manifest = await loadManifest(import.meta.env.BASE_URL);
const entry = manifest.models.find((m) => m.id === 'player');
const container = await loadModel(renderer.scene, entry, baseUrl);
renderer.entities.setPlayerPrototype(prototype);
```

To consume `shard` or `crate`, add a matching `setPickupPrototype` /
`setObstaclePrototype` to `EntityViews` and follow the same shape. Both models
are already generated and catalogued.

## Authoring requirements

Models that drop into this game without fiddling should be:

- **glTF 2.0** (`.gltf` or `.glb`). It is the format Babylon loads natively and
  the one every source above exports.
- **Y-up, +Z forward.** The simulation computes `heading = atan2(vx, vz)`, so a
  model facing +Z needs no rotation offset.
- **Centred on the origin, 1.7 units tall** for characters. The capsule they
  replace spans -0.85…+0.85 about the entity root; a model with its feet at
  y = 0 floats half a body height above the floor. Use `scale` in the manifest
  to normalise anything sized differently.
- **A single mesh** where possible. `setPlayerPrototype` clones one mesh and
  assigns it the player's colour; a multi-mesh model needs the loop extended.
- **Under 4 MB** if committed — `assets:verify` enforces it. Downloaded assets
  are capped at 16 MB.

### Optimising

```bash
npx @gltf-transform/cli optimize in.glb out.glb --compress draco --texture-compress webp
```

`@gltf-transform/cli` handles Draco compression, texture resizing, deduplication
and pruning. Draco needs the decoder registered in Babylon — worth it for large
meshes, unnecessary for placeholders.

## Licence hygiene

`npm run assets:verify` runs in CI on every push, and fails if:

- any asset lacks `license.name` or `license.source`;
- a committed (`generated`) file referenced by the manifest is missing;
- a committed asset exceeds the size budget;
- a recorded `sha256` does not match the file;
- `ATTRIBUTION.md` is out of sync with the manifest.

`public/assets/ATTRIBUTION.md` is generated from the manifest and shipped with
the site, which covers the repository. **Assets under attribution licences
(CC-BY and similar) must also have their credit visible in the running game**,
because a file in the deployment is generally not sufficient — so the game has
an in-game credits panel (`src/ui/credits.ts`), reachable from a button in the
corner of the HUD.

It reads the same `manifest.json` the loader does, so **an asset that is
catalogued is credited automatically**; there is no second list to keep in
sync. Entries whose licence actually obliges the credit are marked, using
`requiresAttribution()` in `src/shared/manifest.ts`. That check is deliberately
strict: it only treats a licence as attribution-free when the _entire_ string
is a public-domain dedication, because real metadata is often compound —
Khronos's Fox is `CC0-1.0 (model) / CC-BY-4.0 (rigging, animation, glTF
conversion)`, and a loose prefix match would read that as CC0 and silently drop
a required credit.

The panel also lists the third-party code that reaches the browser (Babylon.js,
Trystero). That list is hardcoded in `credits.ts` — if you add a runtime
dependency, add it there.

CC0 assets need no attribution legally. They are credited anyway, because six
months from now the useful question is "where did this come from and can we
still use it", and the answer should not require archaeology.
