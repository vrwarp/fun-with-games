import { expect, test, type Page } from '@playwright/test';
import { regionLevel } from './pixels.js';

/**
 * Game-kit end-to-end coverage: modes launch, phases run, bots fill rooms,
 * and the mode picker works. Uses `?net=broadcast` — CI has no relay network.
 */

async function waitForHud(page: Page): Promise<void> {
  await expect(page.getByTestId('hud')).toBeVisible({ timeout: 30_000 });
}

test('rush mode runs its phase machine: countdown, GO, timer', async ({ page }) => {
  await page.goto('/?net=broadcast&autojoin=1&room=e2e-rush&mode=rush&name=Racer');
  await waitForHud(page);

  expect(await page.evaluate(() => window.__FWG__.mode)).toBe('rush');

  // Solo player satisfies rush's minPlayers, so the machine starts alone:
  // lobby -> countdown (banner shows numbers) -> playing (timer appears).
  await expect
    .poll(() => page.evaluate(() => window.__FWG__.phase), { timeout: 20_000 })
    .toBe('countdown');
  await expect(page.getByTestId('phase-banner')).toBeVisible();

  await expect
    .poll(() => page.evaluate(() => window.__FWG__.phase), { timeout: 20_000 })
    .toBe('playing');
  await expect(page.getByTestId('round-timer')).toBeVisible();
  await expect(page.getByTestId('mode-goal')).toContainText('25');
});

test('bots fill an arena via the URL and count as players', async ({ page }) => {
  await page.goto('/?net=broadcast&autojoin=1&room=e2e-bots&mode=arena&bots=2&name=Solo');
  await waitForHud(page);

  await expect
    .poll(() => page.evaluate(() => window.__FWG__.botCount), { timeout: 20_000 })
    .toBe(2);
  await expect
    .poll(() => page.evaluate(() => window.__FWG__.playerCount), { timeout: 20_000 })
    .toBe(3);

  // Bots satisfy arena's 2-player minimum, so the round starts.
  await expect
    .poll(() => page.evaluate(() => window.__FWG__.phase), { timeout: 30_000 })
    .not.toBe('lobby');

  // Bots show up on the scoreboard, marked as bots.
  await expect(page.getByTestId('score-row')).toHaveCount(3);
  await expect(page.getByTestId('scoreboard')).toContainText('🤖');
});

test('the lobby mode picker launches the chosen mode', async ({ page }) => {
  await page.goto('/?net=broadcast&room=e2e-picker');
  await expect(page.getByTestId('lobby')).toBeVisible();

  await page.getByTestId('mode-select').selectOption('tag');
  await expect(page.getByTestId('mode-tagline')).toContainText('IT');

  await page.getByTestId('name-input').fill('Picker');
  await page.getByTestId('join-button').click();
  await waitForHud(page);

  expect(await page.evaluate(() => window.__FWG__.mode)).toBe('tag');
  // The mode survives into the shareable URL.
  expect(page.url()).toContain('mode=tag');
});

test('the host can add a bot from settings', async ({ page }) => {
  await page.goto('/?net=broadcast&autojoin=1&room=e2e-hud-bot&mode=tag&name=Host');
  await waitForHud(page);

  await page.getByTestId('settings-button').click();
  const addBot = page.getByTestId('settings-add-bot');
  await expect(addBot).toBeVisible();
  await addBot.click();

  await expect
    .poll(() => page.evaluate(() => window.__FWG__.botCount), { timeout: 10_000 })
    .toBe(1);
  await expect(page.getByTestId('settings-bot-count')).toHaveText('1');
});

test('settings change the camera, the art and the sound without a reload', async ({ page }) => {
  // The whole point of the panel: these were query parameters, so changing one
  // meant editing a URL and dropping out of the room to reload it.
  await page.goto('/?net=broadcast&autojoin=1&room=e2e-settings&mode=grandprix&name=Driver');
  await waitForHud(page);
  const tickBefore = await page.evaluate(() => window.__FWG__.tick);

  await page.getByTestId('settings-button').click();
  // Racing offers exactly the two supported cameras, and isometric is the
  // orthographic one of the pair.
  await page.getByTestId('settings-view').selectOption('iso');
  await expect.poll(() => page.evaluate(() => window.__FWG__.view)).toBe('iso');
  expect(await page.evaluate(() => window.__FWG__.orthographic)).toBe(true);

  await page.getByTestId('settings-sprites').click();
  await page.getByTestId('settings-sound').click();
  await page.getByTestId('settings-close').click();

  // Same session throughout: the simulation never restarted.
  expect(await page.evaluate(() => window.__FWG__.tick)).toBeGreaterThan(tickBefore);
  // And the address bar now describes what is actually on screen.
  expect(page.url()).toContain('view=iso');
  expect(page.url()).toContain('sprites=1');
});

test('a camera chosen in settings survives a refresh', async ({ page }) => {
  await page.goto('/?net=broadcast&autojoin=1&room=e2e-sticky&mode=tag&name=Sticky');
  await waitForHud(page);

  await page.getByTestId('settings-button').click();
  await page.getByTestId('settings-view').selectOption('iso');
  await expect.poll(() => page.evaluate(() => window.__FWG__.view)).toBe('iso');

  // Back in without the parameter: the stored preference has to supply it,
  // which is what makes this a setting rather than a link.
  await page.goto('/?net=broadcast&autojoin=1&room=e2e-sticky2&mode=tag&name=Sticky');
  await waitForHud(page);
  expect(await page.evaluate(() => window.__FWG__.view)).toBe('iso');
});

test('a link still overrides what the device remembers', async ({ page }) => {
  await page.goto('/?net=broadcast&autojoin=1&room=e2e-link&mode=tag&name=Linked');
  await waitForHud(page);
  await page.getByTestId('settings-button').click();
  await page.getByTestId('settings-view').selectOption('first');
  await expect.poll(() => page.evaluate(() => window.__FWG__.view)).toBe('first');

  // Someone sends a link that names a view: the link describes the game they
  // were invited to, so it wins over the preference.
  await page.goto('/?net=broadcast&autojoin=1&room=e2e-link2&mode=tag&name=Linked&view=topdown');
  await waitForHud(page);
  expect(await page.evaluate(() => window.__FWG__.view)).toBe('topdown');
});

test('gather stays the untimed sandbox: no banner, no timer, no buttons', async ({ page }) => {
  await page.goto('/?net=broadcast&autojoin=1&room=e2e-gather&name=Chill');
  await waitForHud(page);

  expect(await page.evaluate(() => window.__FWG__.mode)).toBe('gather');
  expect(await page.evaluate(() => window.__FWG__.phase)).toBe('playing');
  await expect(page.getByTestId('phase-banner')).toBeHidden();
  await expect(page.getByTestId('round-timer')).toBeHidden();
  await expect(page.getByTestId('touch-buttons')).toBeHidden();
});

test.describe('2D and 2.5D views', () => {
  test('the platformer runs side-on with an orthographic camera', async ({ page }) => {
    await page.goto('/?net=broadcast&autojoin=1&room=e2e-platformer&mode=platformer&name=Jumper');
    await waitForHud(page);

    expect(await page.evaluate(() => window.__FWG__.view)).toBe('side');
    // Orthographic is what makes a side-scroller read as 2D rather than as a
    // 3D game photographed from the side.
    expect(await page.evaluate(() => window.__FWG__.orthographic)).toBe(true);
    // Jumping is an action, so the mode shows the on-screen button.
    await expect(page.getByTestId('touch-buttons')).toBeAttached();
  });

  test('gravity actually applies: the player is pulled back to a surface', async ({ page }) => {
    await page.goto('/?net=broadcast&autojoin=1&room=e2e-gravity&mode=platformer&name=Jumper');
    await waitForHud(page);
    await expect
      .poll(() => page.evaluate(() => window.__FWG__.tick), { timeout: 30_000 })
      .toBeGreaterThan(60);

    const height = await page.evaluate(() => {
      const id = window.__FWG__.selfId;
      return window.__FWG__.players.find((p) => p.id === id)?.y ?? -1;
    });
    // Standing on the floor or on the opening ledge — never falling forever.
    expect(height).toBeGreaterThanOrEqual(0);
    expect(height).toBeLessThan(20);
  });

  test('any mode can be forced into any view from the URL', async ({ page }) => {
    // View is presentation-only, so it is a per-player URL knob rather than
    // part of the room's rules.
    await page.goto('/?net=broadcast&autojoin=1&room=e2e-view&mode=tag&view=topdown&name=Bird');
    await waitForHud(page);

    expect(await page.evaluate(() => window.__FWG__.mode)).toBe('tag');
    expect(await page.evaluate(() => window.__FWG__.view)).toBe('topdown');
    expect(await page.evaluate(() => window.__FWG__.orthographic)).toBe(true);
  });

  test('the isometric mode picks up its 2.5D framing', async ({ page }) => {
    await page.goto('/?net=broadcast&autojoin=1&room=e2e-iso&mode=dungeon&bots=2&name=Delver');
    await waitForHud(page);

    expect(await page.evaluate(() => window.__FWG__.view)).toBe('iso');
    expect(await page.evaluate(() => window.__FWG__.orthographic)).toBe(true);
  });

  test('first person puts the camera in the driver\u2019s head', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto(
      '/?net=broadcast&autojoin=1&room=e2e-fp&mode=grandprix&bots=2&name=Driver&view=first',
    );
    await waitForHud(page);
    await expect
      .poll(() => page.evaluate(() => window.__FWG__.tick), { timeout: 30_000 })
      .toBeGreaterThan(30);

    expect(await page.evaluate(() => window.__FWG__.view)).toBe('first');
    // A cockpit is perspective, level with the horizon, and pinned: the orbit
    // is one arrangement rather than a range the player can drift out of.
    expect(await page.evaluate(() => window.__FWG__.orthographic)).toBe(false);
    expect(await page.evaluate(() => window.__FWG__.cameraBeta)).toBeCloseTo(Math.PI / 2, 3);

    // It also has to sit closer than the other supported camera, or it is not
    // a cockpit. (Grandprix now defaults to `first`, so the comparison has to
    // name the view it is being compared against rather than take the default.)
    const cockpit = await page.evaluate(() => window.__FWG__.cameraRadius);
    await page.goto('/?net=broadcast&autojoin=1&room=e2e-fp2&mode=grandprix&name=Driver&view=iso');
    await waitForHud(page);
    expect(cockpit).toBeLessThan(await page.evaluate(() => window.__FWG__.cameraRadius));

    expect(errors).toEqual([]);
  });

  test('the camera turns with the car, not with where it is going', async ({ page }) => {
    // A head is bolted to the chassis: the cockpit follows where the car is
    // POINTED, not where it is travelling, which is what keeps the horizon
    // still through a slide instead of swinging to chase the drift.
    await page.goto(
      '/?net=broadcast&autojoin=1&room=e2e-fp3&mode=grandprix&name=Driver&view=first',
    );
    await waitForHud(page);
    await expect
      .poll(() => page.evaluate(() => window.__FWG__.tick), { timeout: 30_000 })
      .toBeGreaterThan(60);

    const state = () =>
      page.evaluate(() => {
        const handle = window.__FWG__;
        const self = handle.players.find((player) => player.id === handle.selfId);
        return { alpha: handle.cameraAlpha, heading: self?.heading ?? 0 };
      });

    // Throttle AND lock: a car yaws by rolling, so steering on the spot is
    // supposed to leave both the car and the camera exactly where they were.
    const before = await state();
    await page.keyboard.down('KeyW');
    await page.keyboard.down('KeyA');
    await page.waitForTimeout(1500);
    await page.keyboard.up('KeyA');
    await page.keyboard.up('KeyW');
    const after = await state();

    const wrap = (angle: number): number => Math.abs(Math.atan2(Math.sin(angle), Math.cos(angle)));
    const swung = wrap(after.heading - before.heading);
    const panned = wrap(after.alpha - before.alpha);

    expect(swung).toBeGreaterThan(0.3);
    // Bolted on, so the camera went round with it — bounded both ways, because
    // a camera that lagged badly and one that overshot are both wrong.
    expect(panned).toBeGreaterThan(swung * 0.6);
    expect(panned).toBeLessThan(swung * 1.4);
  });

  test('the 3D follow camera stays perspective', async ({ page }) => {
    await page.goto('/?net=broadcast&autojoin=1&room=e2e-3d&name=Classic');
    await waitForHud(page);

    expect(await page.evaluate(() => window.__FWG__.view)).toBe('follow');
    expect(await page.evaluate(() => window.__FWG__.orthographic)).toBe(false);
  });

  test('sprite mode renders without errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto('/?net=broadcast&autojoin=1&room=e2e-sprites&mode=skirmish&bots=2&name=Pix');
    await waitForHud(page);
    await expect
      .poll(() => page.evaluate(() => window.__FWG__.tick), { timeout: 30_000 })
      .toBeGreaterThan(30);

    expect(errors).toEqual([]);
  });
});

test.describe('racing', () => {
  test('a car is steered relative to itself, not to the camera', async ({ page }) => {
    // Every other mode reads the stick as a direction in the world, rotated by
    // the camera. A car reads its axes in its own frame — which is what makes
    // driving identical in all five views instead of depending on where the
    // camera happens to be.
    await page.goto(
      '/?net=broadcast&autojoin=1&room=e2e-carctl&mode=grandprix&name=Driver&view=topdown',
    );
    await waitForHud(page);
    await expect
      .poll(() => page.evaluate(() => window.__FWG__.tick), { timeout: 30_000 })
      .toBeGreaterThan(60);

    const self = () =>
      page.evaluate(() => {
        const handle = window.__FWG__;
        return handle.players.find((player) => player.id === handle.selfId);
      });

    // The grid faces +X. In top-down, "up the screen" is -Z, so a
    // camera-relative reading of the same key would drive the car that way.
    const before = await self();
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(1800);
    await page.keyboard.up('KeyW');
    const after = await self();

    const alongNose = (after?.x ?? 0) - (before?.x ?? 0);
    const upTheScreen = (before?.z ?? 0) - (after?.z ?? 0);
    expect(alongNose).toBeGreaterThan(8);
    expect(Math.abs(upTheScreen)).toBeLessThan(alongNose / 2);
  });

  test('steering and throttle are separate controls', async ({ page }) => {
    await page.goto('/?net=broadcast&autojoin=1&room=e2e-axes&mode=grandprix&name=Driver');
    await waitForHud(page);
    await expect
      .poll(() => page.evaluate(() => window.__FWG__.tick), { timeout: 30_000 })
      .toBeGreaterThan(60);

    const self = () =>
      page.evaluate(() => {
        const handle = window.__FWG__;
        return handle.players.find((player) => player.id === handle.selfId);
      });

    // Steering with no throttle takes the car nowhere — and, because a car
    // yaws by rolling rather than by being told to, does not turn it either.
    const before = await self();
    await page.keyboard.down('KeyD');
    await page.waitForTimeout(1200);
    await page.keyboard.up('KeyD');
    const turned = await self();

    const travelled = Math.hypot(
      (turned?.x ?? 0) - (before?.x ?? 0),
      (turned?.z ?? 0) - (before?.z ?? 0),
    );
    expect(travelled).toBeLessThan(1);
    const swung = (turned?.heading ?? 0) - (before?.heading ?? 0);
    expect(Math.abs(Math.atan2(Math.sin(swung), Math.cos(swung)))).toBeLessThan(0.05);

    // Throttle with no steering moves it and leaves the nose where it was.
    const rolling = await self();
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(1200);
    await page.keyboard.up('KeyW');
    const driven = await self();

    expect(
      Math.hypot((driven?.x ?? 0) - (rolling?.x ?? 0), (driven?.z ?? 0) - (rolling?.z ?? 0)),
    ).toBeGreaterThan(4);
  });

  test('every graphics tier renders without falling over', async ({ page }) => {
    // The one thing a browser is needed for here. The tier POLICY is unit
    // tested — CI renders in software at single digit frame rates whatever is
    // switched on, so nothing here can tell an expensive look from a cheap one
    // — but whether a post-processing chain, an SSAO pass and a generated cube
    // texture actually COMPILE and draw is a question only a real GL context
    // answers, and getting it wrong is a black screen rather than a slow one.
    //
    // Slow on purpose, and the reason is worth writing down because the
    // obvious diagnosis is wrong. Switching tier is NOT what costs the time:
    // measured, the scene resumes its normal tick rate about a second after
    // each change. What costs the time is Playwright TOUCHING THE DOM. Every
    // actionability check waits for the element to hold still across two
    // animation frames, and this page renders in software at one or two frames
    // a second, so a single click can take five seconds. Nine interactions ran
    // to 51 seconds of a 60 second budget here and over it on a slower runner.
    //
    // So the panel is opened once and the picker cycled inside it, which is
    // four interactions rather than nine — and is the better test anyway,
    // because a settings change is supposed to apply immediately rather than
    // on closing the panel.
    test.slow();

    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto('/?net=broadcast&autojoin=1&room=e2e-gfx&mode=grandprix&name=Driver');
    await waitForHud(page);
    await expect
      .poll(() => page.evaluate(() => window.__FWG__.tick), { timeout: 30_000 })
      .toBeGreaterThan(30);

    const picker = page.getByTestId('settings-quality');
    await page.getByTestId('settings-button').click();
    await expect(picker).toBeVisible();

    for (const tier of ['low', 'medium', 'high'] as const) {
      await picker.selectOption(tier);

      // Rebuilding a pipeline tears down render targets and builds new ones.
      // If any of that throws, the scene stops advancing — so the tick is the
      // honest check that the renderer survived, not merely that no exception
      // reached the console.
      const before = await page.evaluate(() => window.__FWG__.tick);
      await expect
        .poll(() => page.evaluate(() => window.__FWG__.tick), { timeout: 30_000 })
        .toBeGreaterThan(before + 10);
    }

    // And the panel still closes on the most expensive tier, which is the one
    // most likely to have left the page wedged.
    await page.getByTestId('settings-close').click();
    await expect(picker).toBeHidden();

    expect(errors).toEqual([]);

    // The sky is still a sky. The tick assertions above cannot see the
    // picture, and the failure they once missed was exactly that shape:
    // switching to the high tier mid-game handed the sky dome's depth to the
    // new SSAO pass, which occluded the whole backdrop to black while every
    // tick kept advancing. The cockpit's upper-right quadrant is open sky in
    // this mode; black reads ~10, a healthy sky well over 100.
    const frame = await page.screenshot({ timeout: 60_000 });
    expect(regionLevel(frame, { left: 0.72, top: 0.1, right: 0.95, bottom: 0.2 })).toBeGreaterThan(
      60,
    );
  });

  test('a view round trip at the high tier keeps the sky', async ({ page }) => {
    // Same DOM-touch economics as the tier cycle above: software rendering
    // makes every actionability check slow, so the budget is honest instead
    // of the sequence trimmed.
    test.slow();

    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto('/?net=broadcast&autojoin=1&room=e2e-viewtrip&mode=grandprix&name=Driver');
    await waitForHud(page);
    await expect
      .poll(() => page.evaluate(() => window.__FWG__.tick), { timeout: 30_000 })
      .toBeGreaterThan(30);

    await page.getByTestId('settings-button').click();
    const quality = page.getByTestId('settings-quality');
    await expect(quality).toBeVisible();
    await quality.selectOption('high');

    // Cockpit to isometric and back crosses the perspective/orthographic
    // boundary twice, and each crossing rebuilds the post pipeline. On a real
    // phone GPU the old code path — one pipeline, its SSAO shader recompiled
    // in place when `camera.mode` flipped — came back from exactly this trip
    // with the sky permanently black. The tick poll after each hop proves the
    // rebuild did not wedge the renderer; the screenshot at the end proves
    // the backdrop survived.
    const view = page.getByTestId('settings-view');
    for (const target of ['iso', 'first'] as const) {
      await view.selectOption(target);
      const before = await page.evaluate(() => window.__FWG__.tick);
      await expect
        .poll(() => page.evaluate(() => window.__FWG__.tick), { timeout: 30_000 })
        .toBeGreaterThan(before + 10);
    }

    await page.getByTestId('settings-close').click();
    expect(errors).toEqual([]);

    // Same open-sky quadrant as the tier cycle: black reads ~10, a healthy
    // sky well over 100.
    const frame = await page.screenshot({ timeout: 60_000 });
    expect(regionLevel(frame, { left: 0.72, top: 0.1, right: 0.95, bottom: 0.2 })).toBeGreaterThan(
      60,
    );
  });

  test('the art gate veils the start, holds the clock, then lifts', async ({ page }) => {
    // Vendor art settling costs real time on a software renderer (the HDR
    // sky decodes on the CPU), which is exactly what makes the veil
    // observable here at all.
    test.slow();

    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto('/?net=broadcast&autojoin=1&room=e2e-artgate&mode=grandprix&name=Driver');
    await waitForHud(page);

    // One atomic look: if the veil is still up, the room's clock must not
    // have started — that pairing is the whole feature. Read together
    // because the veil lifts on its own schedule, and a test that asserted
    // the two separately would race it.
    const held = await page.evaluate(() => ({
      veiled: document.querySelector('[data-testid="loading-veil"]:not(.is-leaving)') !== null,
      tick: window.__FWG__.tick,
    }));
    if (held.veiled) expect(held.tick).toBe(0);

    // The veil lifts by itself — settled or timed out, never wedged — and
    // only then does the race actually run.
    await expect(page.getByTestId('loading-veil')).toBeHidden({ timeout: 60_000 });
    await expect
      .poll(() => page.evaluate(() => window.__FWG__.tick), { timeout: 30_000 })
      .toBeGreaterThan(30);

    expect(errors).toEqual([]);
  });

  test('a grand prix renders, grids up and drives', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto('/?net=broadcast&autojoin=1&room=e2e-gp&mode=grandprix&bots=2&name=Driver');
    await waitForHud(page);
    await expect
      .poll(() => page.evaluate(() => window.__FWG__.tick), { timeout: 30_000 })
      .toBeGreaterThan(60);

    // The pit board only exists in modes with laps, so its presence is the
    // check that the race view model reached the DOM at all.
    await expect(page.getByTestId('race-board')).toBeVisible();
    await expect(page.getByTestId('race-lap')).toContainText('/6');
    await expect(page.getByTestId('race-position')).toContainText('P');

    // A car is steered, so both buttons are on offer — a keyboard-only brake
    // would be unreachable on the primary target.
    await expect(page.getByTestId('touch-buttons')).toBeAttached();

    const before = await page.evaluate(() => {
      const handle = window.__FWG__;
      return handle.players.find((player) => player.id === handle.selfId);
    });

    // Hold the throttle: the car has to actually move, and along its nose.
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(2000);
    await page.keyboard.up('KeyW');

    const after = await page.evaluate(() => {
      const handle = window.__FWG__;
      return handle.players.find((player) => player.id === handle.selfId);
    });

    expect(before).toBeDefined();
    expect(after).toBeDefined();
    const travelled = Math.hypot(after!.x - before!.x, after!.z - before!.z);
    expect(travelled).toBeGreaterThan(5);
    expect(errors).toEqual([]);
  });

  test('the street circuit is an isometric race', async ({ page }) => {
    await page.goto('/?net=broadcast&autojoin=1&room=e2e-street&mode=street&bots=2&name=Racer');
    await waitForHud(page);

    // Isometric rather than top-down: a fixed overhead camera inverts steering
    // whenever the car drives back toward it, which is half of any lap.
    expect(await page.evaluate(() => window.__FWG__.view)).toBe('iso');
    expect(await page.evaluate(() => window.__FWG__.orthographic)).toBe(true);
    await expect(page.getByTestId('race-lap')).toContainText('/5');
  });

  test('the isometric camera swings around behind a car', async ({ page }) => {
    // The whole reason iso is a supported driving view and top-down is not. A
    // fixed diagonal means "steer left" looks like right whenever the nose is
    // pointed back at the camera; chasing the heading keeps the two agreeing.
    await page.goto(
      '/?net=broadcast&autojoin=1&room=e2e-isochase&mode=grandprix&name=Driver&view=iso',
    );
    await waitForHud(page);
    await expect
      .poll(() => page.evaluate(() => window.__FWG__.tick), { timeout: 30_000 })
      .toBeGreaterThan(90);

    const orbit = () => page.evaluate(() => window.__FWG__.cameraAlpha);
    const before = await orbit();

    // Drive round a corner. The camera has to have moved with it.
    await page.keyboard.down('KeyW');
    await page.keyboard.down('KeyD');
    await page.waitForTimeout(2500);
    await page.keyboard.up('KeyD');
    await page.keyboard.up('KeyW');

    const after = await orbit();
    const swung = Math.abs(Math.atan2(Math.sin(after - before), Math.cos(after - before)));
    expect(swung).toBeGreaterThan(0.3);
  });

  test('a camera on foot stays put in isometric', async ({ page }) => {
    // The counterpart: on foot the stick is already rotated by the camera, so
    // a fixed diagonal is correct and a rotating world would just be
    // disorienting. Only a car gets the chase.
    await page.goto('/?net=broadcast&autojoin=1&room=e2e-isofoot&mode=tag&name=Runner&view=iso');
    await waitForHud(page);
    await expect
      .poll(() => page.evaluate(() => window.__FWG__.tick), { timeout: 30_000 })
      .toBeGreaterThan(90);

    const before = await page.evaluate(() => window.__FWG__.cameraAlpha);
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(1500);
    await page.keyboard.up('KeyW');
    const after = await page.evaluate(() => window.__FWG__.cameraAlpha);

    expect(Math.abs(after - before)).toBeLessThan(0.05);
  });

  test('engines run without upsetting the page', async ({ page }) => {
    // The engine layer is a live WebAudio graph rebuilt every frame — an
    // oscillator bank, a filter and an HRTF panner per car, plus the listener
    // moving with the driver. None of that can be heard from a test, but all
    // of it can throw, and a browser that dislikes one of those nodes would
    // otherwise take the whole render loop down with it.
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto('/?net=broadcast&autojoin=1&room=e2e-engine&mode=grandprix&bots=3&name=Driver');
    await waitForHud(page);

    // Browsers refuse to start an AudioContext until the page has been
    // interacted with, so without a gesture this would test the early return.
    await page.getByTestId('viewport').click({ position: { x: 5, y: 5 } });
    await page.keyboard.down('KeyW');
    await expect
      .poll(() => page.evaluate(() => window.__FWG__.tick), { timeout: 30_000 })
      .toBeGreaterThan(150);
    await page.keyboard.up('KeyW');

    expect(errors).toEqual([]);
  });

  test('muting mid-race silences the engines cleanly', async ({ page }) => {
    // Everything here happens on a live racing scene, and on a software
    // rasteriser that scene is expensive to stand up — with vendor art
    // fetched, decoding the HDR sky on the CPU put the whole sequence at
    // 59 seconds of a 60-second budget. The work is legitimate, so the
    // budget is honest (3x) rather than the sequence trimmed.
    test.slow();
    // Mute closes the whole context, which is the one moment a continuous
    // sound can leave a dangling node behind and throw on the next frame.
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto('/?net=broadcast&autojoin=1&room=e2e-mute&mode=grandprix&bots=2&name=Driver');
    await waitForHud(page);
    await page.getByTestId('viewport').click({ position: { x: 5, y: 5 } });

    await page.getByTestId('settings-button').click();
    await page.getByTestId('settings-sound').click();
    await page.getByTestId('settings-close').click();

    // Keep driving with it off, then turn it back on and keep going.
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(1200);
    await page.getByTestId('settings-button').click();
    await page.getByTestId('settings-sound').click();
    await page.getByTestId('settings-close').click();
    await page.waitForTimeout(1200);
    await page.keyboard.up('KeyW');

    expect(errors).toEqual([]);
  });

  test('a car sees further ahead than a runner does', async ({ page }) => {
    // A camera framed for someone on foot shows a car under a second of road,
    // which is not enough to plan a corner from. Both sides ask for the same
    // view, because the framing scale is what is under test — comparing two
    // different cameras would only prove they are different cameras. A cockpit
    // is deliberately exempt from the widening (pulling the eye back to see
    // more road just puts it behind its own bodywork), so this asks for iso.
    await page.goto('/?net=broadcast&autojoin=1&room=e2e-cam-run&mode=tag&name=Runner&view=iso');
    await waitForHud(page);
    const onFoot = await page.evaluate(() => window.__FWG__.cameraRadius);

    await page.goto(
      '/?net=broadcast&autojoin=1&room=e2e-cam-car&mode=grandprix&name=Driver&view=iso',
    );
    await waitForHud(page);
    const driving = await page.evaluate(() => window.__FWG__.cameraRadius);

    expect(driving).toBeGreaterThan(onFoot);
  });
});
