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

| File              | Owns                                                                     |
| ----------------- | ------------------------------------------------------------------------ |
| `renderer.ts`     | Engine, scene, camera, lights, fog, arena, post-processing, quality tier |
| `environment.ts`  | The generated sky: a reflection probe and a visible dome                 |
| `surfaces.ts`     | Procedural albedo + height patterns, and the normal maps made from them  |
| `carmesh.ts`      | The car's geometry                                                       |
| `carmaterials.ts` | The car's substances (paint, carbon, rubber, metal)                      |
| `skin.ts`         | The seam status effects use to paint a body of any material type         |
| `quality.ts`      | Which tier a device starts on, and when to give one up                   |
| `entities.ts`     | Player and pickup meshes                                                 |
| `trackview.ts`    | Tarmac, kerbs, start line, zone marks, barriers, gantry                  |
| `marks.ts`        | Tyre marks and dust                                                      |

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

## 7. Quality tiers

`quality.ts` is pure policy, and pure on purpose: CI runs headless software
rendering at single-digit frame rates whatever the settings, so a browser test
cannot tell a cheap tier from an expensive one. Keeping the decision pure means
it can be pinned in milliseconds even though the thing it decides about cannot.

```
low     no screen passes at all. Tone mapping only (a material term).
medium  + anti-aliasing, restrained bloom, normal maps, clear coat.
high    + ambient occlusion, sharper shadows.
```

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
pixel ratio of 3 means a cheap one. Then
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

## 8. The car

`carmesh.ts` builds about forty primitives — tapered nose, six-sided monocoque,
tapering sidepods, airbox and engine cover, halo, floor and raked diffuser,
two-element front wing with endplates, rear wing, exhaust, and four wheels with
rims, spokes and wishbones — then **merges them by material into five meshes**.

The counter-intuitive part, and why this is affordable on a phone: _more
geometry here means fewer draw calls than before._ The car it replaced was five
boxes and four cylinders — nine draw calls. This one is five. A GPU at this
scale cares about state changes, not triangles.

The rear wing flap is the one part kept out of every merge, because DRS has to
lay it flat.

Everything is a multiple of `playerRadius`, which is what the simulation
actually collides with, so a car that looks like it fits through a gap does.
The body points along +Z, matching `heading = atan2(vx, vz)`.

`carmaterials.ts` holds the four substances. The contrast between them is what
sells any of them — a car where the tyres and the bodywork catch light the same
way reads as one moulded object, and no amount of shaping fixes that.

---

## 9. Status effects across material types

`skin.ts` exists because a body is no longer always a `StandardMaterial`. A car
is `PBRMaterial`, a sprite is a `StandardMaterial` with lighting off, and the
two spell the base colour differently (`albedoColor` against `diffuseColor`)
with no common ancestor that has either.

`PlayerSkin` is three setters and a disposal. The effects code stops caring
what kind of surface it is painting, which is what let the car become properly
physical without the tag rules, the freeze effect and the knockout fade each
growing a branch.

---

## 10. How to check a change

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
