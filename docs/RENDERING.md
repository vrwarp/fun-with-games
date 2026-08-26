# Rendering

How the picture is made. Read `ARCHITECTURE.md` first for where the render
layer sits; this is what happens inside it.

The one rule that governs everything here: **the renderer is a projection.**
`RenderState` goes in, meshes come out, and nothing ever reads back. Every
decision below is free to change without touching a gameplay rule.

---

## 1. The look, in one paragraph

A circuit is lit as an outdoor scene and shaded physically. There is a sun, a
sky you can see, and a copy of that sky the surfaces are allowed to reflect.
Cars, tarmac, grass and the boundary wall are **metallic-roughness** materials
whose numbers describe substances rather than appearances. The image is then
tone-mapped with an ACES curve, which is what turns a computed frame into
something that reads as photographed.

The other fifteen modes keep the darker arena look they were designed against.
Nothing below quietly restyles them: every branch is on
`config.track.enabled && config.trackPath.length >= 2`.

---

## 2. Files

| File              | Owns                                                                    |
| ----------------- | ----------------------------------------------------------------------- |
| `renderer.ts`     | Engine, scene, camera, lights, shadows, fog, arena, post                |
| `environment.ts`  | The generated sky: sun, clouds, a reflection probe and a visible dome   |
| `scenery.ts`      | Trees, guard posts, boards, street lamps — merged static meshes         |
| `tyrestacks.ts`   | The tyre walls, drawn from simulation state — they are bodies now       |
| `cardynamics.ts`  | Wheel spin, recovered steering, body lean, brake glow — pure            |
| `smoke.ts`        | Tyre smoke and dust, gated by the same slip functions as the marks      |
| `surfaces.ts`     | Procedural albedo + height patterns, and the normal maps made from them |
| `carmesh.ts`      | The car's geometry                                                      |
| `carmaterials.ts` | The car's substances (paint, carbon, rubber, metal)                     |
| `skin.ts`         | The seam status effects use to paint a body of any material type        |
| `quality.ts`      | Which tier a device starts on, and when to give one up                  |
| `entities.ts`     | Player and pickup meshes                                                |
| `trackview.ts`    | Tarmac, kerbs, start line, zone marks, barriers, gantry                 |
| `marks.ts`        | Tyre marks and dust                                                     |
| `assets.ts`       | Loading catalogued art: models, photo surfaces — every path fails soft  |

---

## 3. Why physically based, and what it cost

The kit used `StandardMaterial` (Blinn-Phong) everywhere. Its specular term is
**added on top of** the diffuse rather than taken out of the same budget, so
brightness and shininess fight: turning the sun up to make the scene look lit
blew the cars out to white, and the fix was to turn the specular down until the
paint stopped looking like paint. Every knob moved every other knob.

Metallic-roughness settles, because the numbers mean something:

- **roughness** — how scattered the reflection is.
- **metallic** — whether the surface tints its reflection with its own colour
  (metal) or leaves it white (everything else).

Both are properties of the substance and neither changes when the lighting
does. Turn the sun up and the car gets brighter instead of getting whiter.

Two traps worth knowing before touching any of it:

**Metallic is a slider between two different materials, not a gloss dial.** As
it rises the diffuse colour is taken away and handed to the reflection. Car
paint at `metallic = 0.35` came out pastel — it was mostly mirroring a bright
sky, and a mirror of a bright sky is white. It sits at `0.12`, because colour
is how a player finds their own car.

**Colours must be converted to linear space.** PBR does its arithmetic in
linear light, so a hex colour handed over untouched has been gamma-encoded
twice. `skin.ts` does the conversion; the symptom of skipping it is a car that
is washed out rather than obviously wrong, which gets tuned around for an hour
instead of fixed.

The cost is real and worth stating: the Babylon chunk grew by about 300 kB
minified (roughly 8%), because `PBRMaterial` is a much larger shader family
than `StandardMaterial`.

---

## 4. The sky is not optional

`environment.ts` generates a cube texture from three colours — zenith, horizon,
ground — and hands it to `scene.environmentTexture`.

**Every quality tier gets it, including the cheapest.** A physically based
material is defined by what it reflects, so a metal with no environment is not
a cheaper metal, it is a black shape. That is the single most common way a PBR
scene comes out looking worse than the unlit one it replaced. It is six 64px
faces — about 100 kB, generated, no network — so there is nothing to save.

The same three colours also paint a **visible** dome (`createSkyDome`), at
higher resolution because a gradient magnified across a thousand pixels bands
into steps at 64. Sharing the colours is the point: a car that mirrors a sky
the player cannot see is a car reflecting a different world.

The ground colour is deliberately **neutral**, not grass green. This cube lights
and mirrors everything in the scene, so a green lower hemisphere puts a green
cast on every surface — the tarmac came out sage, and it took a magenta-tagged
build to prove where it was coming from.

### A sun and a cloud deck

`skyRadianceAt` composites three things, in the order the light arrives:

1. the gradient, which is the air;
2. the **sun**, added to it, as two lobes — a tight disc (`pow(dot, 1600)`) and
   a broad glare (`pow(dot, 6)`). One falloff cannot be both, and the glare is
   most of what says "bright day" rather than "blue paint";
3. the **cloud**, composited over both. Order matters: a disc added after the
   cloud shines straight through an overcast, which is the most obvious way to
   get a procedural sky wrong, so a test pins it.

The cloud deck is a flat layer at a height, so the projection is where the view
ray crosses it: `p = dir.xz / dir.y`. That depends only on the direction, which
means **every cube face agrees at its edges for free** — per-face 2D noise
would put a seam down all twelve. Overhead the projection is tight; near the
horizon it stretches toward infinity, which is what a cloud layer seen edge-on
actually does, and also where the detail drops below a texel, so the last few
degrees fade into the horizon haze rather than aliasing into it.

Cover moves a **threshold** rather than scaling a density. That is what makes
"scattered" mean separate clouds with gaps, instead of a uniform grey veil; the
test asserts the distribution is bimodal for exactly that reason.

`SUN_TRAVEL` is exported and the renderer hands it straight to the key light,
so the sun you can see and the light casting your shadow are one fact rather
than two constants that drift.

### The dome and the probe want different lower hemispheres

Not an inconsistency — different questions. The probe models radiance: what is
down there is dark ground, and a car's underside should reflect it. The dome
models what a player SEES, and in a scene with a floor you never look at sky
below the horizon except at the edges of the world, where a dark hemisphere
reads as a hole punched in the picture. So the dome keeps dimming the horizon
colour instead. `createSkyDome` makes that swap in one line.

---

## 5. Surface detail is a normal map, not triangles

A surface reads as a material because of how light moves across it far below
the scale worth modelling. Asphalt is a field of stone chips; carbon fibre is a
woven basket; a tyre is grained rubber. All of it is a per-pixel lighting
question, which is what a normal map answers.

This is the half of "PBR" that does the work. Metallic and roughness decide how
a surface responds to light; a normal map decides that it has a surface at all.
A flat roughness over a flat triangle is a flat plastic sheet however carefully
it is tuned.

`surfaces.ts` generates four patterns — `asphalt`, `grass`, `carbonWeave`,
`tyreRubber` — as an albedo plus a height field, and `normalMap()` turns the
height into tangent-space normals by central differences.

### Why the generators are pure

`ASSETS.md` forbids shipping binaries, so these are procedural. `textures.ts`
does its procedural work by drawing into a canvas, which would put these
somewhere no test can reach: unit tests run in Node with no DOM, and the
browser suite has no way to assert on a texel.

So the patterns are plain arithmetic over typed arrays, with no Babylon and no
DOM, and only `createSurface` touches a scene. `tests/unit/render/surfaces.test.ts`
then pins the things that are invisible at speed and obvious in a millisecond:

- every pattern **tiles** — the step across the seam is no larger than a step
  anywhere inside it. This caught the tyre grain wrapping at 32 lattice cells
  while its texture only covered 8, drawing a seam down every wheel;
- the normal map tilts **against** the slope, reads across the wrap, and points
  straight up off a flat field;
- the carbon weave is a 2×2 **twill** and not a plain weave (shifting four tows
  along a row reproduces it; two tows inverts it);
- asphalt is dark and **neutral**, so the sky can colour it rather than fight
  a colour of its own;
- grass is green-dominant and measurably **brighter** than the tarmac beside
  it. That one is a gameplay property: the contrast is a driver's fastest read
  of where the road is.

### Tiling

Everything wraps: the noise lattice is sampled modulo its own period, per axis.
Getting it wrong shows up as a visible grid over the whole circuit, once per
tile, forever. Ribbon UVs run 0..1 over a whole band, so the road works its
tiling out from the circuit's real length and width — `ROAD_TILE` world units
per tile, in both directions, so the stones stay square.

---

## 5b. Photographs over the procedural look

Everything above is the **baseline**: generated, committed, always present.
On top of it, `Renderer.applyVendorArt` swaps in catalogued CC0 photographs —
HDRI skies, photo asphalt/grass/barrier/bark, and a photoscanned tyre model —
when `assets:fetch` has put them in `public/assets/vendor/`. The deployed
site has them; a fresh clone plays the procedural look until it fetches.
Every path in this section **fails soft**: a missing file or a failed decode
logs at `info` and leaves the procedural art standing, per the first rule of
`ASSETS.md`.

The sky is **chosen per mode** (`findSkyEntry`: `sky-street` outranks `sky`
in street), and two of its catalogue knobs reach beyond the dome: `meta.sun`
retunes the key light to the lamp the photo was shot under — the reason the
street circuit's whole scene goes golden-hour rather than just its backdrop —
and `meta.horizon` recolours the fog and clear colour. All of it applies in
the texture's `onLoad`, so a failed download changes nothing.

The sky is one `.hdr` loaded **twice**, because the dome and the probe answer
different questions (§4 again):

- the **dome** gets a 512px `HDRCubeTexture` in `SKYBOX_MODE`, no prefilter —
  it only has to be looked at;
- `scene.environmentTexture` gets a 128px prefiltered one with harmonics —
  it has to light things, so it needs the roughness mip chain.

Two knobs travel with the file as catalogue `meta` (see `ASSETS.md` §3), not
as code: `rotationY` turns the photo until its sun sits where `SUN_TRAVEL`
says the key light is, and `horizon` is the image's own haze colour, which
**replaces the fog colour** (`.toLinearSpace()`, and the clear colour with
it). Fog tuned for the painted sky read as a grey wash over the photo one.

The environment copy is applied at `level = 0.5`. A photographic sun carries
hundreds of times the energy of the painted sun lobe, and at full level every
glossy highlight on the cars blew out into a white streak. Halving the
texture's level tames the reflections without touching
`scene.environmentIntensity`, which would dim the lighting of everything else
too.

Photo surfaces go through `applyPhotoSurface`, which exists so a swap cannot
lose what the procedural material established: it copies `uScale`/`vScale`
and the anisotropy level off the outgoing texture (the tiling maths of §5
still stands; explicit tiling covers materials that had no texture, like the
bark), sets `gammaSpace` only on the albedo slot — a normal map read as sRGB
tilts wrong everywhere — and swaps the bump **only if the tier had one**, so
a photo normal map cannot sneak per-pixel lighting onto a tier that turned it
off. This is why the barrier's corrugation is visible on medium and high but
not low: a galvanised sheet's colour is nearly uniform — the ribs live in
the normal map, and the cheap tier declined normal maps on purpose. The
road and grass also take a packed **ARM** map (AO / roughness / metallic in
the glTF channel layout); when it lands, the procedural metallic/roughness
scalars step aside and the photographed roughness takes over — the low-sun
glare corridor down the tarmac is that map at work. An `albedoColor` option
covers two traps at once: lifting a flat-colour material's near-black tint
before it multiplies the photo away (bark), and knocking a photographed
sheet DOWN so the barrier stays a step darker than the horizon (the same
call §5 made about the procedural wall).

A quality-tier switch rebuilds `TrackView` on procedural tarmac;
`#applyTierToScene` re-applies the road and barrier photographs after it.
Scenery, the ground and the tyres are built once and keep theirs.

The **tyre model** rides the `#dressing` gate — a software rasteriser keeps
the cheap torus, exactly as it gets no trees — which also keeps CI's
SwiftShader e2e runs off the heavy geometry. One mesh from the glTF becomes
the clone prototype for every tyre in every wall; `normalizeTyrePrototype`
measures rather than trusts it (hole axis from the smallest bounding extent,
size from the largest), so a swapped model with different authoring
conventions still lands stacked flat and right-sized. The swap is invisible
above the view: the same simulation state poses photograph and torus alike.

---

## 6. Overlays on a dark road

Zone marks (sector gates, DRS zones) are unlit emissive quads blended by alpha,
so the result is a **lerp toward the overlay's colour**:

```
result = road * (1 - a) + tint * a
```

Tarmac is now a true asphalt albedo — about a tenth of the light that lands on
it, roughly `0.02` linear. The DRS green is `0.84`. So even at four percent
alpha the fill contributed more green than the entire road surface had, and a
third of the circuit came out as a teal carpet. **Halving the alpha barely
moved it, because the problem was never the alpha; it was the ratio.**

The fill now sits at `0.006` — measured off a screenshot rather than guessed:
`rgb(32,33,35)` outside a zone against `rgb(36,39,40)` inside. The cue moved to
a wider, brighter line at the zone's entry, which is where a driver looks and
how a real circuit marks one.

Note that `#band` draws double-sided, so the effective alpha is about twice
what is written.

If you add an overlay, budget it against the road's linear value, not against
how it looks over a mid-grey.

---

## 6b. The car moves, and the shadows are tiered

Two systems that arrived together, because both answer the same review: a
scene can be materially perfect and still read as a video game if the car is a
statue and the light is flat.

**Car motion is derived, never transmitted** (`cardynamics.ts`). The renderer
already receives position, heading and velocity; wheel spin is distance over
radius, the steering angle is the sim's own bicycle model run backward from
the yaw rate, body pitch/roll is the differenced acceleration leaned AGAINST,
and brake glow heats the rims instantly and cools slowly. Bots animate
identically to humans because both are just cars with velocities. The signs
are the entire hazard — a body leaning INTO a corner looks off without looking
broken — so all of them are pinned by pure tests, including one caught by
arithmetic: Babylon's positive `rotation.z` tilts the top toward −X, the car's
LEFT, so the roll negates at its single apply site.

**Shadows are three genuinely different rigs**, keyed by `quality.shadowMapSize`
and `quality.cascadedShadows` (the former was defined and unread for a while —
the constructor sniffed pointer type instead; the tier decides now):

```
low     512 blurred exponential map: soft blobs under the cars.
medium  1024, same technique, sharper.
high    2048 CASCADED maps: treeline, tyre stacks, posts and boards all
        cast, PCF filtered, alpha-tested so the pine cards punch
        tree-shaped holes in the light.
```

Generators rebuild on tier change; `EntityViews` rebuilds its bodies against
the new one, `KitViews` re-registers its static casters, `Scenery` re-adds on
the cascade tier. The ambient:sun ratio IS the darkest a shadow can be — at
the old near-1:4 the scene could never contrast, which read as "evenly lit
from everywhere", which read as N64.

**Tyre smoke** (`smoke.ts`) puts the slide in the air above the streak the
marks put on the ground — one particle system per car, gated by the same
`marksGround`/`slipOf` the marks use so the two can never disagree, white on
the limit and brown dust off it.

There is deliberately **no lens flare**. One shipped briefly: Babylon's
`LensFlareSystem` ray-picks the scene for occlusion, which needs the `Ray`
side-effect import — absent, the first flare render throws and takes the
whole render loop with it, and only in the production bundle, where
tree-shaking removes what the dev server happened to keep. It also never
fired in the isometric view (an orthographic camera at 37° elevation never
has the sun on screen), which made it a cockpit-only garnish priced at a
crashed game. If it returns, it returns with the `Ray` import, a test that
covers a built bundle at a bloom tier, and a reason to exist in iso.

---

## 7. The world beyond the kerb

The scene used to end at the kerb: grass, then a grey wall, then sky. A circuit
drawn that way is a road on a plane, and no amount of work on the road fixes
it — what tells you a track is somewhere is the stuff you are not looking at.

`scenery.ts` plants trees, guard posts, boards and marshal posts — and, in a
mode whose metadata asks for `'street'` furniture, paired **street lamps**:
a thin pole, an arm, an unlit-emissive head, and an additive pool of warm
lamplight painted on the ground under it (the contact-shadow trick run the
other way). The heads glow instead of casting light — dozens of point lights
is a budget nobody has — and at dusk the pools are most of what "lit street"
means, on every tier. Three rules make all of it affordable and correct:

- **Thin instances.** One mesh, one material, one draw call, and a buffer of
  transforms. Five hundred trees cost about what one tree costs.
- **Nothing casts a shadow.** The shadow map is fitted to whatever casts into
  it, so admitting a treeline would stretch it across the whole arena and leave
  each car a handful of texels — trading the shadow that matters for hundreds
  nobody looks at.
- **Placement is a pure function.** `scatter` and `tyreWalls` take numbers and
  return positions, with no Babylon near them, because they can be wrong in
  ways a screenshot hides: a tree in the racing line is obvious, a tree just
  inside the track limit at the far end of the circuit is not, and a tyre wall
  on the INSIDE of a corner reads as merely odd until you notice the circuit
  has been telling every driver the wrong thing all race.

Trees are a jittered grid with a third of the cells left empty — uniform random
points clump, and clumped trees read as a mistake rather than as a wood.
Candidates that land near the road are dropped rather than nudged, because a
circuit folds back on itself and nudging produces a suspicious ring hugging the
barrier.

Trees are **drawn, not lathed**: each of three species paints its own conifer
— drooping frond strokes with jittered lengths, missing branches, darker
interiors — onto three alpha-cut cards at sixty degrees. A cone is geometry
pretending to be a tree; a card carries the actual ragged outline, which is
the part the eye reads. A horizontal cap card for top-down cameras was tried
and removed: seen from anywhere near the ground it smears into a line slicing
every tree in half, and this game's cameras live near the ground — the
isometric one looks down at 53 degrees, not 90, so three oblique cards keep
their volume there too.

The dressing around them: corrugated guardrail (a normal-mapped wave profile;
corrugation reads as light rolling across ridges), guard posts every four
metres so a hundred-metre barrier stops reading as one extrusion, tyre stacks
painted in red/white/black bundles, invented-sponsor boards along the
straights — built as two one-sided planes, because a two-sided plane shows its
text MIRRORED to the half of the circuit behind it — and painted pit bays
where the pit zones' literal trigger circles used to float like crop circles.

Tyre walls go where the road actually **bends**, measured as the turn in
heading over a fixed chord rather than from the path's own vertices, which
would measure how densely the circuit was authored. Straights get nothing,
which is what makes the corners read.

### The ground runs past the arena

On a circuit the ground is five times the arena and the walls stay where they
were. From any raised camera the old ground read as a slab floating in space,
with a cliff edge and sky underneath — the fastest way to make a landscape look
like a diorama. Scenery is planted well past the boundary too, so the wall has
a treeline above it rather than a bare grey band across the horizon.

---

## 8. The road is painted

Two markings, both derived from the same track path the simulation uses.

**Track-limit lines** are thin white bands at the inner edge of the kerbs. That
is where the clean track ends, and it matches the simulation: kerbs sit _inside_
the limits here, so the line goes inside them.

**The racing line** is a strip of laid-in rubber — darker than the tarmac and,
more importantly, _smoother_. Dropping the roughness is what makes it catch the
sky along a straight while the tarmac either side stays dull, which is how you
see it at all from a camera a metre off the ground. It is built as a four-path
ribbon with vertex alpha so it fades at its edges; a hard edge reads as a
painted stripe, and rubber has no edge.

`racingLineOffsets` is pure and tested. The raw signal is only "how hard is the
road turning, and which way", which alone would pin the line to the inside kerb
through a corner and snap it back the instant the road straightened — a
zig-zag. **The smoothing is what makes it a line:** averaging over a long
circular window pulls commitment backward and forward, so the line drifts out
before the corner and unwinds after it. Turn-in and exit fall out of the filter
rather than being written down. Circular, because a lap is — smoothing it as an
open sequence leaves a kink at the start/finish line, which is exactly where
everybody is looking.

Commitment scales with curvature, so a fast kink gets a gentle drift and a
hairpin gets the full width. A line pinned to the inside everywhere is not a
racing line, it is a wall-follower.

---

## 9. What the camera actually sees

Nothing is streamed or progressively loaded — the whole circuit exists from
startup. How much of it is on screen is decided in `applyView` (`views.ts`),
and for the orthographic views it is an absolute box: `orthoHalfHeight` from
the view's spec, multiplied by `#framingScale`, with the width derived from the
aspect ratio. Babylon's ortho box is not aspect-derived, so it has to be
recomputed on every resize or a phone rotating to landscape squashes the world.

`#framingScale` is `min(1.7, max(1, playerMaxSpeed / 14))` — a car at 27 units
a second would cross a frame framed for a runner in well under a second, which
is not enough road to plan a corner from. It only ever widens the shot.

Then the frame follows the player (eased at `dt * 8`), the target is clamped so
the view cannot pan off the world, fog closes at `span * 3`, and the far plane
sits at `span * 8`.

### The trap: screen extents are not ground extents

`groundFootprint` exists because the clamp used to compare the ortho box's
width and height directly against the arena, and both halves of that were
wrong.

**Screen axes are not world axes.** They line up only when the camera looks
down a world axis. `topdown` does — and the old arithmetic was clearly written
for it, where it is exactly right. `iso` sits at `alpha = -PI/4`, so both screen
axes are diagonals and each contributes to X _and_ Z. Worse, a view that chases
a car's heading **orbits**, so there is no fixed alpha to assume at all.

**A tilted camera sees more ground than it is tall.** Screen height `h` covers
`h / cos(beta)` of ground — 1.66x at `iso`'s 37 degrees above the horizon.

Together, for `iso` on a desktop frame: assumed 40 x 25, actually **58 x 58**.
The arena is 42 deep, so the frustum overspilled the far wall _from the dead
centre of the map_ — no clamp value could have prevented it. Meanwhile the
clamp still bound, pinning the camera 14 units off the car near the grid. It
paid the cost without buying the benefit.

**The arena is not the edge of the world**, either, not since a circuit's ground
started running five times past it. `groundExtent` is now the single definition
of where the land stops, used both to build the ground and to clamp the camera.
On a circuit it is far enough away that the camera simply follows the car; in an
arena mode it is the arena, exactly as before.

One consequence worth expecting: with honest arithmetic the `iso` footprint is
larger than most arenas, so `slack` goes negative and the view centres. That is
the right answer — if the whole world is on screen there is nothing to pan
toward — and it is what the "classic 2D camera-bounds rule" always said.

---

## 10. Quality tiers

`quality.ts` is pure policy, and pure on purpose: CI runs headless software
rendering at single-digit frame rates whatever the settings, so a browser test
cannot tell a cheap tier from an expensive one. Keeping the decision pure means
it can be pinned in milliseconds even though the thing it decides about cannot.

```
low     no screen passes at all. Tone mapping only (a material term).
medium  + anti-aliasing, restrained bloom, normal maps, clear coat.
high    + ambient occlusion, sharper shadows.
```

Ambient occlusion runs **only in the perspective views** (`first`, `follow`),
and the renderer rebuilds the whole post pipeline whenever a view switch
crosses the perspective/orthographic boundary. Both halves of that are
deliberate. Babylon's own answer to a projection change is to keep the
pipeline and recompile the SSAO shader in place with an
`ORTHOGRAPHIC_CAMERA` define the moment `camera.mode` flips — a
device-dependent shader path that, on at least one real phone GPU, came back
from an iso round trip with the sky permanently black while every local
renderer stayed clean (the third such device-only failure in this one pass).
Rebuilding on the flip lands the renderer in the exact state a fresh load
produces, which is the one state every device has demonstrably rendered
correctly. Not running SSAO in the overhead views at all costs almost
nothing: at their zoom the occlusion radius is a couple of pixels of
darkening, priced at a full-scene depth+normal pass.

Tone mapping and the environment are in **all** tiers. The first is nearly free
and is the largest single difference between a render and a photograph; the
second is what makes the materials work at all.

The starting tier is deliberately pessimistic. **No GPU beats every other
signal:** `isSoftwareRenderer()` matches the WebGL renderer string against
SwiftShader, llvmpipe and friends, and a machine shading every fragment on the
CPU opens on `low` however desktop-shaped it otherwise looks. That is CI
containers, virtual machines, remote desktops and any browser where
acceleration is off or blocklisted, and without it such a machine opens on the
most expensive look and spends eight seconds and two rebuilds climbing back
down. Otherwise a touch screen means a phone, and a phone with few cores or a
pixel ratio of 3 means a cheap one.

A software rasteriser also gets **no dressing at all** — no trackside scenery,
no tyre smoke — and that is a device fact rather than a tier (`#dressing` in
`renderer.ts`), so it holds whatever the picker says. The dressing is a
handful of draw calls but almost pure fill: screen-covering alpha-tested tree
cards, drawn again into every shadow cascade, and blended smoke — and fill is
the one thing a CPU shading fragments cannot pay. Skipping it took the
software frame from tens of seconds back to workable; every real GPU,
including a cheap phone's, keeps all of it. Then
`QualityGovernor` only ever steps **down**, after a sustained shortfall rather
than one dropped frame. A player who starts too low sees a game that runs
beautifully and can turn the handsome switches on; a player who starts too high
concludes the game is broken. A tier the player picks by hand is theirs and the
governor stops interfering.

Changing tier **rebuilds** materials rather than mutating them: whether a
surface has a normal map is compiled into its shader. `#applyTierToScene`
rebuilds the car finishes and the circuit; the circuit is static geometry, so
that is a handful of milliseconds at the moment somebody moved a slider.

The tier lives in the Settings panel and in `localStorage`, never in the URL —
it describes a device, not the game somebody was invited to.

---

## 11. The car

`carmesh.ts` builds about fifty primitives — drooping nose married to a
two-element front wing, six-sided monocoque with a shoulder fairing, halo
with its pillar, coke-bottle sidepods riding the floor, airbox, falling
engine-cover spine into a tail fairing, raked diffuser with a dark exit
cavity, a rear wing assembly (endplates, main plane, beam wing, one centre
pylon), exhaust, and four wheels with rims, spokes and wishbones — then
**merges them by material into a handful of meshes**.

The counter-intuitive part, and why this is affordable on a phone: _more
geometry here means fewer draw calls than before._ The car it replaced was
five boxes and four cylinders — nine draw calls. A GPU at this scale cares
about state changes, not triangles.

The proportions are not folklore: the shape was iterated against a
turnaround sheet (`/studio.html` + `scripts/car-studio.mjs`) reviewed by
the `f1-superfan` agent, whose prescriptions are what set the 4.1r
wheelbase, the near-equal 18-inch-era wheel diameters with wider rears, the
square front/rear track in plan, and the halo's size and rake. Two
non-negotiables to preserve when editing it: the halo must break the cowl
line in profile, and the steering wheel's position is a cockpit-camera
compromise — sunk low, but far enough forward that its top arc stays in
that camera's frame, because counter-rotating there is its whole job.
Rotation signs in the file were fixed by measuring rendered elevations;
trust the comments, not intuition about handedness.

The rear wing flap is the one part kept out of every merge, because DRS has
to lay it flat. The halo and its pillar merge into the RUBBER group on
purpose — the tyre compound's matte near-black is the closest material the
car carries to real halo carbon, and the glossy weave read as chrome.

Everything is a multiple of `playerRadius`, which is what the simulation
actually collides with, so a car that looks like it fits through a gap does.
The body points along +Z, matching `heading = atan2(vx, vz)`.

`carmaterials.ts` holds the four substances. The contrast between them is what
sells any of them — a car where the tyres and the bodywork catch light the same
way reads as one moulded object, and no amount of shaping fixes that.

---

## 12. Status effects across material types

`skin.ts` exists because a body is no longer always a `StandardMaterial`. A car
is `PBRMaterial`, a sprite is a `StandardMaterial` with lighting off, and the
two spell the base colour differently (`albedoColor` against `diffuseColor`)
with no common ancestor that has either.

`PlayerSkin` is three setters and a disposal. The effects code stops caring
what kind of surface it is painting, which is what let the car become properly
physical without the tag rules, the freeze effect and the knockout fade each
growing a branch.

---

## 13. How to check a change

Headless tests cover the pure parts (`surfaces.ts`, `quality.ts`,
`environment.ts`, `marks.ts`). Everything else needs eyes, and **screenshots
have caught things reasoning did not**: a road that was correct in code and
teal on screen, tyre marks sitting at exactly the road's height where they
z-fought, and an arena wall rendering as a hole in the world.

When a surface looks wrong and you cannot tell which one it is, **tag it**.
Give the suspect material a bright magenta albedo, rebuild, and look. Two
minutes, and it ends an argument that guessing does not. Sampling actual pixel
values beats eyeballing a screenshot too — "it looks green" and
`rgb(36,53,48)` against `rgb(42,43,45)` are very different amounts of
information.

Run `npm run test:e2e` for anything under `src/render/`. The `mobile-chrome`
project is the one that matters: it runs a real device descriptor, and what
breaks on a phone is input and frame rate, not layout.
