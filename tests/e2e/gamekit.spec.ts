import { expect, test, type Page } from '@playwright/test';

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

test('the host can add a bot from the HUD', async ({ page }) => {
  await page.goto('/?net=broadcast&autojoin=1&room=e2e-hud-bot&mode=tag&name=Host');
  await waitForHud(page);

  const addBot = page.getByTestId('add-bot');
  await expect(addBot).toBeVisible();
  await addBot.click();

  await expect
    .poll(() => page.evaluate(() => window.__FWG__.botCount), { timeout: 10_000 })
    .toBe(1);
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

    // It also has to sit closer than the chase camera, or it is not a cockpit.
    const cockpit = await page.evaluate(() => window.__FWG__.cameraRadius);
    await page.goto('/?net=broadcast&autojoin=1&room=e2e-fp2&mode=grandprix&name=Driver');
    await waitForHud(page);
    expect(cockpit).toBeLessThan(await page.evaluate(() => window.__FWG__.cameraRadius));

    expect(errors).toEqual([]);
  });

  test('the camera turns with the car, not with where it is going', async ({ page }) => {
    // A head is bolted to the chassis. The chase camera deliberately only
    // swings while the player is moving; doing that in a cockpit would leave
    // the view pointing at the scenery every time a driver turned on the spot.
    await page.goto(
      '/?net=broadcast&autojoin=1&room=e2e-fp3&mode=grandprix&name=Driver&view=first',
    );
    await waitForHud(page);
    await expect
      .poll(() => page.evaluate(() => window.__FWG__.tick), { timeout: 30_000 })
      .toBeGreaterThan(60);

    const before = await page.evaluate(() => window.__FWG__.cameraAlpha);
    await page.keyboard.down('KeyA');
    await page.waitForTimeout(1200);
    await page.keyboard.up('KeyA');

    const after = await page.evaluate(() => window.__FWG__.cameraAlpha);
    let turned = Math.abs(after - before) % (Math.PI * 2);
    if (turned > Math.PI) turned = Math.PI * 2 - turned;
    expect(turned).toBeGreaterThan(0.3);
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
    await expect(page.getByTestId('race-lap')).toContainText('/3');
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

  test('the street circuit is a flat 2D race', async ({ page }) => {
    await page.goto('/?net=broadcast&autojoin=1&room=e2e-street&mode=street&bots=2&name=Racer');
    await waitForHud(page);

    expect(await page.evaluate(() => window.__FWG__.view)).toBe('topdown');
    expect(await page.evaluate(() => window.__FWG__.orthographic)).toBe(true);
    await expect(page.getByTestId('race-lap')).toContainText('/5');
  });

  test('a car sees further ahead than a runner does', async ({ page }) => {
    // A camera framed for someone on foot shows a car under a second of road,
    // which is not enough to plan a corner from.
    await page.goto('/?net=broadcast&autojoin=1&room=e2e-cam-run&mode=tag&name=Runner');
    await waitForHud(page);
    const onFoot = await page.evaluate(() => window.__FWG__.cameraRadius);

    await page.goto('/?net=broadcast&autojoin=1&room=e2e-cam-car&mode=grandprix&name=Driver');
    await waitForHud(page);
    const driving = await page.evaluate(() => window.__FWG__.cameraRadius);

    expect(driving).toBeGreaterThan(onFoot);
  });
});
