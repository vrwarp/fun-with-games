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
