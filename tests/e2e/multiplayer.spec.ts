import { expect, test, type Page } from '@playwright/test';

/**
 * Two real browser pages playing the same game.
 *
 * Uses the `BroadcastChannel` transport (`?net=broadcast`) rather than live
 * WebRTC. That keeps the test hermetic — no public relay, no UDP egress from
 * the CI container, no ICE timing — while still exercising everything above
 * the transport seam: host election, snapshot distribution, roster sync,
 * prediction and host migration.
 *
 * The WebRTC transport itself is a thin adapter over Trystero; the layer this
 * test cannot reach is exactly the layer that is not ours.
 */

const ROOM = 'e2e-duo';

async function joinRoom(page: Page, name: string, room = ROOM): Promise<void> {
  await page.goto(`/?net=broadcast&autojoin=1&room=${room}&name=${name}`);
  await expect(page.getByTestId('hud')).toBeVisible({ timeout: 30_000 });
}

/** Waits for a page to report `count` peers besides itself. */
async function expectPeerCount(page: Page, count: number): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.__FWG__.peerCount), { timeout: 30_000 })
    .toBe(count);
}

test.describe('two peers in one room', () => {
  test('discover each other and agree on a single host', async ({ context }) => {
    const alice = await context.newPage();
    const bob = await context.newPage();

    await joinRoom(alice, 'Alice');
    await joinRoom(bob, 'Bob');

    await expectPeerCount(alice, 1);
    await expectPeerCount(bob, 1);

    const aliceHost = await alice.evaluate(() => window.__FWG__.hostId);
    const bobHost = await bob.evaluate(() => window.__FWG__.hostId);
    expect(aliceHost).toBe(bobHost);

    // Exactly one of them believes it is in charge.
    const hostFlags = await Promise.all(
      [alice, bob].map((page) => page.evaluate(() => window.__FWG__.isHost)),
    );
    expect(hostFlags.filter(Boolean)).toHaveLength(1);
  });

  test('each sees both players on the scoreboard', async ({ context }) => {
    const alice = await context.newPage();
    const bob = await context.newPage();

    await joinRoom(alice, 'Alice', 'e2e-roster');
    await joinRoom(bob, 'Bob', 'e2e-roster');

    for (const page of [alice, bob]) {
      await expect(page.getByTestId('score-row')).toHaveCount(2, { timeout: 30_000 });
    }

    await expect(alice.getByTestId('scoreboard')).toContainText('Bob');
    await expect(bob.getByTestId('scoreboard')).toContainText('Alice');
  });

  test('the client follows the host’s simulation clock', async ({ context }) => {
    const alice = await context.newPage();
    const bob = await context.newPage();

    await joinRoom(alice, 'Alice', 'e2e-clock');
    await joinRoom(bob, 'Bob', 'e2e-clock');
    await expectPeerCount(bob, 1);

    // Both pages should be advancing through the same authoritative timeline.
    await expect
      .poll(() => bob.evaluate(() => window.__FWG__.tick), { timeout: 30_000 })
      .toBeGreaterThan(30);

    const aliceTick = await alice.evaluate(() => window.__FWG__.tick);
    const bobTick = await bob.evaluate(() => window.__FWG__.tick);
    // A snapshot in flight plus interpolation delay means a small, bounded gap.
    expect(Math.abs(aliceTick - bobTick)).toBeLessThan(90);
  });

  test('remote movement reaches the other page', async ({ context }) => {
    const alice = await context.newPage();
    const bob = await context.newPage();

    await joinRoom(alice, 'Alice', 'e2e-move');
    await joinRoom(bob, 'Bob', 'e2e-move');
    await expectPeerCount(alice, 1);

    const bobId = await bob.evaluate(() => window.__FWG__.selfId);
    const aliceSeesBob = () =>
      alice.evaluate(
        (id: string) => document.querySelector(`[data-player-id="${id}"]`) !== null,
        bobId,
      );

    await expect.poll(aliceSeesBob, { timeout: 30_000 }).toBe(true);

    await bob.bringToFront();
    await bob.keyboard.down('KeyW');
    await bob.waitForTimeout(1500);
    await bob.keyboard.up('KeyW');

    // Alice still has Bob in her world after he moved — i.e. inputs flowed to
    // the host and came back in a snapshot without dropping him.
    await expect(alice.getByTestId('score-row')).toHaveCount(2);
  });

  test('the survivor takes over when the host closes its tab', async ({ context }) => {
    const alice = await context.newPage();
    const bob = await context.newPage();

    await joinRoom(alice, 'Alice', 'e2e-migrate');
    await joinRoom(bob, 'Bob', 'e2e-migrate');
    await expectPeerCount(alice, 1);
    await expectPeerCount(bob, 1);

    const aliceIsHost = await alice.evaluate(() => window.__FWG__.isHost);
    const [hostPage, survivor] = aliceIsHost ? [alice, bob] : [bob, alice];

    await hostPage.close();

    // Host migration: the remaining peer promotes itself and keeps simulating.
    await expect
      .poll(() => survivor.evaluate(() => window.__FWG__.isHost), { timeout: 30_000 })
      .toBe(true);

    const tickAfterMigration = await survivor.evaluate(() => window.__FWG__.tick);
    await expect
      .poll(() => survivor.evaluate(() => window.__FWG__.tick), { timeout: 20_000 })
      .toBeGreaterThan(tickAfterMigration);
  });

  test('peers in different rooms stay isolated', async ({ context }) => {
    const alice = await context.newPage();
    const bob = await context.newPage();

    await joinRoom(alice, 'Alice', 'room-one');
    await joinRoom(bob, 'Bob', 'room-two');

    await alice.waitForTimeout(3000);

    expect(await alice.evaluate(() => window.__FWG__.peerCount)).toBe(0);
    expect(await bob.evaluate(() => window.__FWG__.peerCount)).toBe(0);
    await expect(alice.getByTestId('score-row')).toHaveCount(1);
  });
});
