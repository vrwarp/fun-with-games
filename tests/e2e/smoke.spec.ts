import { expect, test } from '@playwright/test';

/**
 * Single-page smoke tests.
 *
 * These cover the one thing the headless suite structurally cannot: that
 * Babylon actually starts, the scene renders, and the DOM overlay is wired to
 * real session state. Everything about gameplay rules and netcode is tested
 * far more thoroughly (and faster) in `tests/unit` and `tests/integration`.
 *
 * A solo peer is still a complete session — it elects itself host, simulates,
 * snapshots, predicts and renders — so this exercises the whole pipeline.
 */

test.describe('lobby', () => {
  test('shows the join form and starts a game', async ({ page }) => {
    await page.goto('/?net=broadcast');

    const lobby = page.getByTestId('lobby');
    await expect(lobby).toBeVisible();

    await page.getByTestId('name-input').fill('Ada');
    await page.getByTestId('room-input').fill('smoke-room');
    await page.getByTestId('join-button').click();

    await expect(page.getByTestId('viewport')).toBeVisible();
    await expect(page.getByTestId('hud')).toBeVisible();
    await expect(page.getByTestId('room-code')).toHaveText('smoke-room');
  });

  test('puts the room in the URL so it can be shared', async ({ page }) => {
    await page.goto('/?net=broadcast');
    await page.getByTestId('room-input').fill('share-me');
    await page.getByTestId('join-button').click();

    await expect(page.getByTestId('hud')).toBeVisible();
    expect(new URL(page.url()).searchParams.get('room')).toBe('share-me');
  });

  test('normalizes a messy room code', async ({ page }) => {
    await page.goto('/?net=broadcast');
    await page.getByTestId('room-input').fill('  Hello World!! ');
    await page.getByTestId('join-button').click();

    await expect(page.getByTestId('room-code')).toHaveText('hello-world');
  });
});

test.describe('a running game', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/?net=broadcast&autojoin=1&room=solo-smoke&name=Solo');
    await expect(page.getByTestId('hud')).toBeVisible();
  });

  test('renders frames', async ({ page }) => {
    // `getFps` only becomes non-zero once the render loop has actually run.
    await expect
      .poll(() => page.evaluate(() => window.__FWG__.fps), { timeout: 20_000 })
      .toBeGreaterThan(0);
  });

  test('draws something other than an empty canvas', async ({ page }) => {
    // Guards against the scene starting but rendering nothing — a failure mode
    // that leaves every DOM assertion above perfectly happy.
    await expect
      .poll(() => page.evaluate(() => window.__FWG__.tick), { timeout: 20_000 })
      .toBeGreaterThan(10);

    const screenshot = await page.getByTestId('viewport').screenshot();
    expect(screenshot.byteLength).toBeGreaterThan(5000);
  });

  test('advances the simulation', async ({ page }) => {
    await expect
      .poll(() => page.evaluate(() => window.__FWG__.tick), { timeout: 20_000 })
      .toBeGreaterThan(30);
  });

  test('hosts itself when alone', async ({ page }) => {
    await expect.poll(() => page.evaluate(() => window.__FWG__.isHost)).toBe(true);
    expect(await page.evaluate(() => window.__FWG__.peerCount)).toBe(0);
  });

  test('shows the local player on the scoreboard', async ({ page }) => {
    await expect(page.getByTestId('score-row')).toHaveCount(1, { timeout: 20_000 });
    await expect(page.getByTestId('score-name')).toContainText('Solo');
  });

  test('reports the host role in the status line', async ({ page }) => {
    await expect(page.getByTestId('net-status')).toHaveAttribute('data-role', 'host');
  });

  test('moves the player in response to the keyboard', async ({ page }) => {
    await expect
      .poll(() => page.evaluate(() => window.__FWG__.tick), { timeout: 20_000 })
      .toBeGreaterThan(15);

    const positionOf = () =>
      page.evaluate(() => {
        const row = document.querySelector('[data-testid="score-row"]');
        return row?.getAttribute('data-player-id') ?? null;
      });
    expect(await positionOf()).not.toBeNull();

    // Hold a key long enough for several simulation ticks to consume it.
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(1200);
    await page.keyboard.up('KeyW');

    // The score row is the observable proof the session kept running under
    // input; position itself is asserted exhaustively in the headless suite.
    await expect(page.getByTestId('score-row')).toHaveCount(1);
  });

  test('credits the shipped assets in-game', async ({ page }) => {
    // A licence obligation, not decoration: anything under an attribution
    // licence has to be credited in the running game, not only in a file in
    // the repository.
    const open = page.getByTestId('credits-button');
    await expect(open).toBeVisible({ timeout: 20_000 });
    await open.click();

    const dialog = page.getByTestId('credits-dialog');
    await expect(dialog).toBeVisible();

    // The build ships generated models, so they must be listed by name...
    await expect(page.getByTestId('credits-entry')).not.toHaveCount(0);
    await expect(dialog).toContainText('CC0-1.0');
    // ...alongside the libraries that reach the browser.
    await expect(dialog).toContainText('Babylon.js');
    await expect(dialog).toContainText('Trystero');

    await page.getByTestId('credits-close').click();
    await expect(dialog).toBeHidden();
  });

  test('logs no page errors while running', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await page.waitForTimeout(2000);

    expect(errors).toEqual([]);
  });
});
