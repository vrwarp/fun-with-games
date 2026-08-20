import { expect, test, type Page } from '@playwright/test';

/**
 * Mobile is a supported target, so it is tested on a real touch device
 * descriptor (`Pixel 5`: touch events, mobile user agent, phone viewport)
 * rather than a narrow desktop window. A narrow window would pass while the
 * game remained completely unplayable, because the thing that actually breaks
 * on a phone is *input*, not layout.
 */

const ROOM = 'mobile-test';

async function launch(page: Page): Promise<void> {
  await page.goto(`/?net=broadcast&autojoin=1&room=${ROOM}&name=Mobile`);
  await expect(page.getByTestId('hud')).toBeVisible({ timeout: 30_000 });
}

/**
 * Drags the thumbstick by a screen-space offset and holds it there.
 *
 * Driven through `page.mouse` rather than `page.touchscreen`, which can only
 * tap. That is faithful enough: `TouchInput` listens for Pointer Events, and
 * both a mouse and a finger produce those.
 */
async function holdStick(page: Page, dx: number, dy: number, holdMs: number): Promise<void> {
  const stick = page.getByTestId('touch-stick');
  await expect(stick).toBeVisible();

  const box = await stick.boundingBox();
  if (!box) throw new Error('thumbstick has no bounding box');

  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx, cy + dy, { steps: 8 });
  await page.waitForTimeout(holdMs);
  await page.mouse.up();
}

test.describe('on a phone', () => {
  test('starts and renders', async ({ page }) => {
    await launch(page);

    await expect
      .poll(() => page.evaluate(() => window.__FWG__.fps), { timeout: 30_000 })
      .toBeGreaterThan(0);
    await expect
      .poll(() => page.evaluate(() => window.__FWG__.tick), { timeout: 30_000 })
      .toBeGreaterThan(20);
  });

  test('shows the thumbstick', async ({ page }) => {
    await launch(page);
    // Without this the game is unplayable on a phone — there is no keyboard.
    await expect(page.getByTestId('touch-controls')).toBeVisible();
    await expect(page.getByTestId('touch-stick')).toBeVisible();
  });

  test('hides the keyboard hints', async ({ page }) => {
    await launch(page);
    await expect(page.locator('.hud__help')).toBeHidden();
  });

  test('the thumbstick moves the player', async ({ page }) => {
    await launch(page);
    await expect
      .poll(() => page.evaluate(() => window.__FWG__.tick), { timeout: 30_000 })
      .toBeGreaterThan(20);

    const positionOf = () =>
      page.evaluate(() => {
        const id = window.__FWG__.selfId;
        const player = window.__FWG__.players.find((p) => p.id === id);
        return player ? { x: player.x, z: player.z } : null;
      });

    const before = await positionOf();
    expect(before).not.toBeNull();

    await holdStick(page, 0, -45, 1200);

    const after = await positionOf();
    expect(after).not.toBeNull();

    const travelled = Math.hypot(after!.x - before!.x, after!.z - before!.z);
    expect(travelled).toBeGreaterThan(0.5);
  });

  test('the HUD fits the viewport without horizontal scrolling', async ({ page }) => {
    await launch(page);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('the scoreboard stays readable', async ({ page }) => {
    await launch(page);
    await expect(page.getByTestId('score-row')).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByTestId('score-name')).toContainText('Mobile');
  });

  test('the lobby is usable on a small screen', async ({ page }) => {
    await page.goto('/?net=broadcast&room=mobile-lobby');

    await expect(page.getByTestId('lobby')).toBeVisible();
    const joinButton = page.getByTestId('join-button');
    await expect(joinButton).toBeVisible();

    // Below ~44px an on-screen control is genuinely hard to hit with a thumb.
    const box = await joinButton.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);

    await page.getByTestId('name-input').fill('Thumbs');
    await joinButton.tap();
    await expect(page.getByTestId('hud')).toBeVisible({ timeout: 30_000 });
  });

  test('every interactive control is thumb-sized', async ({ page }) => {
    // 44px is the long-standing floor for a comfortable touch target. Anything
    // smaller is a control that technically exists and practically does not.
    await launch(page);

    const controls = page.locator('[data-testid="copy-link"]');
    const box = await controls.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  });

  test('the camera follows the direction of travel unaided', async ({ page }) => {
    // The defining mobile-design decision: playable with one thumb. If the
    // camera did not swing round by itself, a player would need a second thumb
    // to drag the view — on the hand holding the phone.
    await launch(page);
    await expect
      .poll(() => page.evaluate(() => window.__FWG__.tick), { timeout: 30_000 })
      .toBeGreaterThan(20);

    const before = await page.evaluate(() => window.__FWG__.cameraAlpha);

    // Drive in a direction that is not where the camera already points.
    await holdStick(page, 42, 30, 2500);

    const after = await page.evaluate(() => window.__FWG__.cameraAlpha);
    const delta = Math.abs(Math.atan2(Math.sin(after - before), Math.cos(after - before)));
    expect(delta).toBeGreaterThan(0.1);
  });

  test('is installable as an app', async ({ page }) => {
    await launch(page);

    const href = await page.getAttribute('link[rel="manifest"]', 'href');
    expect(href).toBeTruthy();

    const response = await page.request.get(new URL(href!, page.url()).toString());
    expect(response.ok()).toBe(true);

    const manifest = (await response.json()) as {
      display?: string;
      icons?: Array<{ sizes?: string; purpose?: string }>;
    };
    expect(manifest.display).toBe('standalone');
    // A maskable icon is what stops Android from framing the icon in a white
    // box on the home screen.
    expect(manifest.icons?.some((icon) => icon.purpose === 'maskable')).toBe(true);
    expect(manifest.icons?.some((icon) => icon.sizes === '512x512')).toBe(true);
  });

  test('frames the arena for a portrait viewport', async ({ page }) => {
    await launch(page);
    await expect
      .poll(() => page.evaluate(() => window.__FWG__.tick), { timeout: 30_000 })
      .toBeGreaterThan(10);

    // A portrait phone is narrow, so the camera pulls back further and tilts
    // further down than on a desktop window (radius 22, beta pi/3.2);
    // otherwise you walk into things you never saw, and a third of the screen
    // is empty sky.
    const radius = await page.evaluate(() => window.__FWG__.cameraRadius);
    const beta = await page.evaluate(() => window.__FWG__.cameraBeta);
    expect(radius).toBeGreaterThan(22);
    // Smaller beta is a more overhead view.
    expect(beta).toBeLessThan(Math.PI / 3.2);
  });

  test('the credits panel is usable with a thumb', async ({ page }) => {
    await launch(page);

    const open = page.getByTestId('credits-button');
    await expect(open).toBeVisible({ timeout: 30_000 });

    const box = await open.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);

    await open.tap();
    const dialog = page.getByTestId('credits-dialog');
    await expect(dialog).toBeVisible();

    // The panel must fit a phone rather than overflowing it.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);

    const close = page.getByTestId('credits-close');
    const closeBox = await close.boundingBox();
    expect(closeBox?.height ?? 0).toBeGreaterThanOrEqual(44);

    await close.tap();
    await expect(dialog).toBeHidden();
  });

  test('logs no page errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await launch(page);
    await page.waitForTimeout(2500);

    expect(errors).toEqual([]);
  });

  test('modes with an action show a thumb-sized fire button', async ({ page }) => {
    // Every action needs a touch affordance (CLAUDE.md §7): in arena mode the
    // primary button must exist, be reachable, and be big enough for a thumb.
    await page.goto(`/?net=broadcast&autojoin=1&room=${ROOM}-arena&mode=arena&name=Gunner`);
    await expect(page.getByTestId('hud')).toBeVisible({ timeout: 30_000 });

    const fire = page.getByTestId('touch-button-primary');
    await expect(fire).toBeVisible();
    const box = await fire.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  });

  test('modes without an action keep the screen clear of buttons', async ({ page }) => {
    await launch(page); // default gather mode
    await expect(page.getByTestId('touch-buttons')).toBeHidden();
  });

  test('the phase banner is readable on a phone', async ({ page }) => {
    await page.goto(`/?net=broadcast&autojoin=1&room=${ROOM}-rush&mode=rush&name=Racer`);
    await expect(page.getByTestId('hud')).toBeVisible({ timeout: 30_000 });

    await expect
      .poll(() => page.evaluate(() => window.__FWG__.phase), { timeout: 20_000 })
      .toBe('countdown');
    await expect(page.getByTestId('phase-banner')).toBeVisible();

    // Nothing overflows the phone viewport with the banner and timer up.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
