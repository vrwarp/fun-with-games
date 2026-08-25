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

/**
 * Presses and holds one driving control.
 *
 * `offset` is a fraction of the element's half-width. It is what the steering
 * track reads — where you press IS the input — and pedals ignore it.
 */
async function holdControl(page: Page, testId: string, holdMs: number, offset = 0): Promise<void> {
  const control = page.getByTestId(testId);
  await expect(control).toBeVisible();

  const box = await control.boundingBox();
  if (!box) throw new Error(`${testId} has no bounding box`);

  const cx = box.x + box.width / 2 + (box.width / 2) * offset;
  const cy = box.y + box.height / 2;

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.waitForTimeout(holdMs);
  await page.mouse.up();
}

/**
 * Waits for the SIMULATION to advance by `ticks`, however long that takes.
 *
 * Anything that measures how far a car moved has to be bounded in ticks rather
 * than milliseconds. A wall-clock window holds however many ticks the machine
 * can fit in it, so on a loaded CI runner the same test quietly measures a
 * shorter drive — which is a flake, not a failure, and indistinguishable from
 * one at the point it fires.
 */
async function advanceTicks(page: Page, ticks: number): Promise<void> {
  const from = await page.evaluate(() => window.__FWG__.tick);
  await expect
    .poll(() => page.evaluate(() => window.__FWG__.tick), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(from + ticks);
}

/**
 * Presses one pedal at a chosen depth and holds it for `ticks`.
 *
 * `depth` is where along the pedal's travel the thumb lands: 0 is the bottom
 * edge (the lightest press the control gives you) and 1 the top (everything
 * it has). That is the whole analog gesture, so it is what the tests below
 * have to be able to express.
 */
async function holdPedal(page: Page, testId: string, ticks: number, depth: number): Promise<void> {
  const pedal = page.getByTestId(testId);
  await expect(pedal).toBeVisible();

  const box = await pedal.boundingBox();
  if (!box) throw new Error(`${testId} has no bounding box`);

  // Inset a hair from each end so a rounding error cannot land outside.
  const y = box.y + box.height * (1 - clampUnit(depth)) * 0.94 + box.height * 0.03;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await advanceTicks(page, ticks);
  await page.mouse.up();
}

const clampUnit = (value: number): number => Math.min(1, Math.max(0, value));

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

    // The panel opens with its handle, so that is the first control to check.
    const toggle = page.getByTestId('panel-toggle');
    const handle = await toggle.boundingBox();
    expect(handle?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(handle?.width ?? 0).toBeGreaterThanOrEqual(44);

    await toggle.tap();
    const box = await page.getByTestId('copy-link').boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  });

  test('the panel stays out of the way until it is asked for', async ({ page }) => {
    // On a phone this panel sits directly on top of the game. What it holds is
    // setup information — the invite link, the goal line, the bot controls,
    // the connection status — and none of that is worth a corner of the track
    // while playing. It opens on a tap and closes again on the next one.
    await launch(page);

    const panel = page.locator('.hud__panel');
    await expect(panel).toHaveClass(/is-collapsed/);
    await expect(page.getByTestId('copy-link')).toBeHidden();
    await expect(page.getByTestId('mode-goal')).toBeHidden();
    await expect(page.getByTestId('net-status')).toBeHidden();

    // What survives is what a player reads mid-corner: the room, and the score.
    await expect(page.getByTestId('room-code')).toBeVisible();
    await expect(page.getByTestId('score-row').first()).toBeVisible();

    const shut = await panel.boundingBox();
    await page.getByTestId('panel-toggle').tap();
    await expect(panel).not.toHaveClass(/is-collapsed/);
    await expect(page.getByTestId('copy-link')).toBeVisible();

    const open = await panel.boundingBox();
    expect((shut?.height ?? 0) * (shut?.width ?? 0)).toBeLessThan(
      (open?.height ?? 0) * (open?.width ?? 0) * 0.75,
    );

    await page.getByTestId('panel-toggle').tap();
    await expect(panel).toHaveClass(/is-collapsed/);
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
    await expect(fire).toHaveText('Fire');
    const box = await fire.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  });

  test('modes without an action keep the screen clear of buttons', async ({ page }) => {
    await launch(page); // default gather mode
    await expect(page.getByTestId('touch-buttons')).toBeHidden();
  });

  test('a car gets a wheel and pedals, not a thumbstick', async ({ page }) => {
    // Racing is the mode with the most to lose on a phone, and a stick is the
    // wrong control for it: holding a steering angle while lifting off means
    // pinning one thumb to a diagonal, so "turn a bit less" and "slow down"
    // stop being separable. Two thumbs, two controls (CLAUDE.md §7).
    await page.goto(`/?net=broadcast&autojoin=1&room=${ROOM}-gp&mode=grandprix&name=Driver`);
    await expect(page.getByTestId('hud')).toBeVisible({ timeout: 30_000 });

    await expect(page.getByTestId('touch-controls')).toHaveCount(0);
    const steer = page.getByTestId('driving-steer');
    const throttle = page.getByTestId('driving-throttle');
    const brake = page.getByTestId('driving-brake');
    const drs = page.getByTestId('touch-button-primary');
    await expect(drs).toHaveText('DRS');

    // Every one of them has to be findable by a thumb.
    for (const control of [steer, throttle, brake, drs]) {
      const box = await control.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }

    // Steering on the left, pedals on the right: one thumb each, or the split
    // buys nothing.
    const steerBox = (await steer.boundingBox())!;
    const throttleBox = (await throttle.boundingBox())!;
    expect(steerBox.x + steerBox.width).toBeLessThanOrEqual(throttleBox.x);

    // Nothing may sit on top of anything else down there.
    const drsBox = (await drs.boundingBox())!;
    const brakeBox = (await brake.boundingBox())!;
    expect(drsBox.y + drsBox.height).toBeLessThanOrEqual(brakeBox.y + 1);
    expect(brakeBox.y + brakeBox.height).toBeLessThanOrEqual(throttleBox.y + 1);

    // The pit board has to fit a phone alongside all of it.
    const board = page.getByTestId('race-board');
    await expect(board).toBeVisible();
    const boardBox = await board.boundingBox();
    const viewport = page.viewportSize();
    expect((boardBox?.x ?? 0) + (boardBox?.width ?? 0)).toBeLessThanOrEqual(viewport?.width ?? 0);
  });

  test('never leaves the wheel stuck when a touch goes missing', async ({ page }) => {
    // The reported bug, both halves of it. Every missed `pointerup` — a
    // capture torn away, the tab backgrounded with a thumb down — used to
    // strand the pointer id: the last steering angle stuck, so the car turned
    // until it span, and no later touch was accepted, so the driver could not
    // take it back. Backgrounding is the interruption a phone actually does.
    //
    // Asserted on the CONTROL rather than on the car, and that is the point.
    // An earlier version drove the car for several seconds and measured how
    // far it rotated, which made a bug in fifty lines of pointer handling
    // depend on the entire handling model, the countdown, whether a solo
    // driver's round ever starts, and whether the car had found the grass
    // yet. It duly broke the moment the tyre model changed — reporting a
    // correctly-stationary car as a dead control — and every threshold I
    // moved to appease it made it measure less.
    //
    // The knob is the honest witness. It is positioned by the same `#update`
    // that feeds `read()`, so a stuck `#steer` leaves it parked off-centre and
    // a refused `pointerdown` leaves it unmoved. That the wheel's output
    // reaches the simulation at all is covered by the two tests below, which
    // do not need an interruption to prove it.
    await page.goto(`/?net=broadcast&autojoin=1&room=${ROOM}-stuck&mode=grandprix&name=Driver`);
    await expect(page.getByTestId('hud')).toBeVisible({ timeout: 30_000 });

    const track = page.getByTestId('driving-steer');
    await expect(track).toBeVisible();

    /**
     * How far the knob sits from centre, in pixels.
     *
     * One `evaluate` rather than two `boundingBox` calls, and not for
     * elegance: each protocol round-trip has to wait for SwiftShader to
     * finish a frame, so on a pegged CI runner a single sample of a
     * two-round-trip version costs several seconds — which is how this
     * test once timed out with the wheel behaving perfectly.
     */
    const offset = (): Promise<number> =>
      page.evaluate(() => {
        const trackEl = document.querySelector('[data-testid="driving-steer"]')!;
        const knobEl = trackEl.querySelector('.driving__knob')!;
        const trackBox = trackEl.getBoundingClientRect();
        const knobBox = knobEl.getBoundingClientRect();
        return knobBox.x + knobBox.width / 2 - (trackBox.x + trackBox.width / 2);
      });

    const box = (await track.boundingBox())!;
    const midY = box.y + box.height / 2;
    const leftEnd = box.x + box.width * 0.05;
    const rightEnd = box.x + box.width * 0.95;

    expect(Math.abs(await offset())).toBeLessThan(2);

    // Full left lock, thumb still down.
    await page.mouse.move(leftEnd, midY);
    await page.mouse.down();
    const held = await offset();
    expect(held).toBeLessThan(-box.width * 0.3);

    // The interruption. No pointerup will ever arrive for that thumb.
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));

    // Half one: the wheel let go. Without this the car steers for ever.
    //
    // No tightened timeout, on purpose. The blur handler resets the knob
    // transform synchronously — by the time the dispatch above returns, a
    // healthy wheel is already centred — so this poll is not waiting on the
    // game at all; it is absorbing protocol latency (see `offset`). A
    // genuinely stuck wheel never re-centres, so the config's generous
    // expect budget detects it just as surely as a tight one did.
    await expect.poll(async () => Math.abs(await offset())).toBeLessThan(2);

    // Lift the synthetic thumb so the next press can reach the track again.
    // The blur re-centred the wheel; this undoes the browser-level capture.
    await page.mouse.up();

    // Half two: a NEW touch is accepted, the half that used to leave steering
    // dead for the rest of the race. Opposite lock, so a stale reading cannot
    // pass for a fresh one.
    await page.mouse.move(rightEnd, midY);
    await page.mouse.down();
    const retaken = await offset();
    await page.mouse.up();

    expect(retaken).toBeGreaterThan(box.width * 0.3);

    // And it releases again, rather than latching on the way back. Config
    // budget for the same reason as the poll above: the release is
    // synchronous, the wait is pure protocol latency.
    await expect.poll(async () => Math.abs(await offset())).toBeLessThan(2);
  });

  test('the throttle drives and the wheel only steers', async ({ page }) => {
    // The property the split exists for: one control changes speed, the other
    // changes direction, and neither does the other one's job.
    await page.goto(`/?net=broadcast&autojoin=1&room=${ROOM}-gp2&mode=grandprix&name=Driver`);
    await expect(page.getByTestId('hud')).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => page.evaluate(() => window.__FWG__.tick), { timeout: 30_000 })
      .toBeGreaterThan(90);

    const self = () =>
      page.evaluate(() => {
        const handle = window.__FWG__;
        return handle.players.find((player) => player.id === handle.selfId);
      });

    // Full lock, no throttle. A car steers by rolling, so a parked one with the
    // wheel hard over turns its WHEELS and does nothing else: it neither
    // creeps nor pirouettes.
    const parked = await self();
    await holdControl(page, 'driving-steer', 2000, 0.9);
    const stillParked = await self();
    expect(parked).toBeDefined();
    const crept = Math.hypot(stillParked!.x - parked!.x, stillParked!.z - parked!.z);
    expect(crept).toBeLessThan(1);
    const spun = Math.atan2(
      Math.sin(stillParked!.heading - parked!.heading),
      Math.cos(stillParked!.heading - parked!.heading),
    );
    expect(Math.abs(spun)).toBeLessThan(0.05);

    // Throttle alone, no steering: now it moves.
    const before = await self();
    await holdControl(page, 'driving-throttle', 2500);
    const after = await self();
    expect(Math.hypot(after!.x - before!.x, after!.z - before!.z)).toBeGreaterThan(3);
  });

  test('the pedals are analog: how far you press is how hard it goes', async ({ page }) => {
    // The property the travel exists for. A discrete pedal passes every other
    // driving test in this file, so without this one the analog behaviour is
    // untested on the only device that has it.
    await page.goto(`/?net=broadcast&autojoin=1&room=${ROOM}-pedal&mode=grandprix&name=Driver`);
    await expect(page.getByTestId('hud')).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => page.evaluate(() => window.__FWG__.tick), { timeout: 30_000 })
      .toBeGreaterThan(60);

    const self = () =>
      page.evaluate(() => {
        const handle = window.__FWG__;
        return handle.players.find((player) => player.id === handle.selfId)!;
      });

    /** How far the car travels over a fixed number of ticks at this depth. */
    const drivenAt = async (depth: number): Promise<number> => {
      const before = await self();
      await holdPedal(page, 'driving-throttle', 30, depth);
      const after = await self();
      return Math.hypot(after.x - before.x, after.z - before.z);
    };

    // Feathered first, from a standstill, then buried from wherever that left
    // it. Ordering it this way is deliberate: the light press starts with the
    // least speed to carry, so if anything it is flattered.
    const feathered = await drivenAt(0);
    // Let it coast back down so the second run is not just carrying the first.
    await advanceTicks(page, 90);
    const buried = await drivenAt(1);

    expect(feathered).toBeGreaterThan(0.5);
    expect(buried).toBeGreaterThan(feathered * 1.3);
  });

  test('shows how far down a pedal is, rather than only whether', async ({ page }) => {
    // A control whose state you cannot see is one you have to learn by
    // crashing, and the whole point of travel is that there are now more than
    // two states to show.
    await page.goto(`/?net=broadcast&autojoin=1&room=${ROOM}-fill&mode=grandprix&name=Driver`);
    await expect(page.getByTestId('hud')).toBeVisible({ timeout: 30_000 });

    const throttle = page.getByTestId('driving-throttle');
    await expect(throttle).toBeVisible();
    // A slider, not a button: it has travel, and a screen reader saying
    // "button" for it would be a lie.
    await expect(throttle).toHaveAttribute('role', 'slider');
    expect(await throttle.getAttribute('aria-valuenow')).toBe('0');

    const box = (await throttle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.9);
    await page.mouse.down();
    const light = Number(await throttle.getAttribute('aria-valuenow'));

    await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.1);
    const heavy = Number(await throttle.getAttribute('aria-valuenow'));
    await page.mouse.up();

    // Pressing at all is worth something; sliding up is worth more.
    expect(light).toBeGreaterThan(0);
    expect(heavy).toBeGreaterThan(light);
    expect(heavy).toBeGreaterThan(90);
    // And it lets go completely on release, rather than latching.
    expect(await throttle.getAttribute('aria-valuenow')).toBe('0');
  });

  test('every setting is reachable and thumb-sized', async ({ page }) => {
    // These were all query parameters, which on a phone means typing one into
    // a browser bar mid-game. The panel is the affordance that replaces that,
    // so it has to be openable and operable with a thumb (CLAUDE.md §7).
    await page.goto(`/?net=broadcast&autojoin=1&room=${ROOM}-set&mode=grandprix&name=Set`);
    await expect(page.getByTestId('hud')).toBeVisible({ timeout: 30_000 });

    const gear = page.getByTestId('settings-button');
    const gearBox = await gear.boundingBox();
    expect(gearBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(gearBox?.width ?? 0).toBeGreaterThanOrEqual(44);

    await gear.tap();
    for (const id of ['settings-view', 'settings-sprites', 'settings-sound', 'settings-close']) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box?.height ?? 0, id).toBeGreaterThanOrEqual(40);
    }

    // The dialog has to fit a phone rather than run off the side of it.
    const dialog = await page.getByTestId('settings-dialog').boundingBox();
    const viewport = page.viewportSize();
    expect((dialog?.x ?? 0) + (dialog?.width ?? 0)).toBeLessThanOrEqual((viewport?.width ?? 0) + 1);

    await page.getByTestId('settings-view').selectOption('first');
    await expect.poll(() => page.evaluate(() => window.__FWG__.view)).toBe('first');
  });

  test('the camera can be chosen without a keyboard', async ({ page }) => {
    // Views used to be URL-only, which on a phone means typing a query string
    // into a browser bar. The lobby offers them instead.
    await page.goto('/?net=broadcast&room=mobile-view&mode=grandprix');

    const picker = page.getByTestId('view-select');
    await expect(picker).toBeVisible();
    const box = await picker.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);

    await picker.selectOption('first');
    await page.getByTestId('join-button').tap();
    await expect(page.getByTestId('hud')).toBeVisible({ timeout: 30_000 });

    expect(await page.evaluate(() => window.__FWG__.view)).toBe('first');
  });

  test('the 2D platformer is playable with a thumb', async ({ page }) => {
    // The whole 2D story has to survive the primary target. Jumping is the
    // one interaction a side-scroller cannot do without, so it needs a real
    // thumb-sized button, not just a keyboard binding.
    await page.goto(`/?net=broadcast&autojoin=1&room=${ROOM}-plat&mode=platformer&name=Jump`);
    await expect(page.getByTestId('hud')).toBeVisible({ timeout: 30_000 });

    const jump = page.getByTestId('touch-button-primary');
    await expect(jump).toBeVisible();
    // The label is the affordance on a phone: "A" says a button exists, "Jump"
    // says what it does.
    await expect(jump).toHaveText('Jump');
    const box = await jump.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);

    // Wait for GO, not for a tick count. Players are frozen for the whole
    // countdown (90 ticks here), and a frozen player cannot jump — pressing
    // early tests the freeze, not the jump.
    await expect
      .poll(() => page.evaluate(() => window.__FWG__.phase), { timeout: 30_000 })
      .toBe('playing');

    const heightOf = () =>
      page.evaluate(() => {
        const id = window.__FWG__.selfId;
        return window.__FWG__.players.find((p) => p.id === id)?.y ?? -1;
      });

    const resting = await heightOf();
    expect(resting).toBeGreaterThanOrEqual(0);

    // Hold the button and sample the arc over real time: at this preset's
    // gravity a jump apexes ~400ms after the press, which is many simulation
    // ticks away. Sampling in a tight loop would read the pre-jump height
    // eight times and conclude, wrongly, that nothing happened.
    const jumpBox = await jump.boundingBox();
    if (!jumpBox) throw new Error('jump button has no bounding box');

    let peak = resting;
    await page.mouse.move(jumpBox.x + jumpBox.width / 2, jumpBox.y + jumpBox.height / 2);
    await page.mouse.down();
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(60);
      peak = Math.max(peak, await heightOf());
    }
    await page.mouse.up();

    expect(peak).toBeGreaterThan(resting + 0.3);

    // Nothing overflows a phone viewport in the side view.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
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
