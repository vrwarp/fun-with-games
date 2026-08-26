/**
 * Shoots the car's turnaround sheet — the customary modelling views — from
 * the `/studio.html` stage, headlessly.
 *
 * Orthographic front/rear/side/top elevations (the projection measurement
 * comparisons need) plus perspective three-quarters (the views a car is
 * actually judged in), written as PNGs ready to put in front of a critic:
 *
 *   node scripts/car-studio.mjs [outDir] [--url http://host:port]
 *
 * With no `--url` it starts its own vite dev server on a spare port and
 * stops it afterwards. Default output: `test-results/car-studio/`
 * (gitignored — the sheet is a working document, not an artefact).
 */
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const urlFlag = args.indexOf('--url');
const givenUrl = urlFlag >= 0 ? args[urlFlag + 1] : null;
const outDir = resolve(
  args.find((a, i) => !a.startsWith('--') && i !== urlFlag + 1) ??
    join(root, 'test-results', 'car-studio'),
);

const PORT = 4179;
const HALF_PI = Math.PI / 2;

/**
 * The sheet. `span` is the orthographic half-width; perspective views give a
 * radius instead. Every angle is chosen to answer a different question:
 * elevations for proportion, three-quarters for how the volumes meet, the
 * low hero for the stance the game's own chase camera sees.
 */
const VIEWS = [
  { name: 'front', yaw: HALF_PI, beta: HALF_PI, ortho: true, span: 1.7 },
  { name: 'rear', yaw: -HALF_PI, beta: HALF_PI, ortho: true, span: 1.7 },
  { name: 'side', yaw: Math.PI, beta: HALF_PI, ortho: true, span: 2.9 },
  // The plan view's long axis lies along the frame's SHORT side, so its
  // span must cover the car's length times the aspect ratio, not its width.
  { name: 'top', yaw: HALF_PI, beta: 0.03, ortho: true, span: 4.1 },
  { name: 'front34', yaw: HALF_PI - 0.75, beta: 1.15, radius: 8.5 },
  { name: 'rear34', yaw: -HALF_PI + 0.75, beta: 1.15, radius: 8.5 },
  { name: 'hero', yaw: HALF_PI - 0.6, beta: 1.42, radius: 7 },
];

async function waitForServer(url) {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`dev server never answered at ${url}`);
}

async function main() {
  await mkdir(outDir, { recursive: true });

  let server = null;
  let base = givenUrl;
  if (!base) {
    base = `http://127.0.0.1:${PORT}`;
    server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
      cwd: root,
      stdio: 'ignore',
    });
  }

  try {
    await waitForServer(`${base}/studio.html`);
    const browser = await chromium.launch();
    const page = await browser.newPage({
      viewport: { width: 1000, height: 700 },
      deviceScaleFactor: 1,
    });
    page.on('pageerror', (error) => console.error('PAGEERROR', error.message));

    for (const view of VIEWS) {
      const params = new URLSearchParams({
        yaw: String(view.yaw),
        beta: String(view.beta),
        radius: String(view.radius ?? 14),
      });
      if (view.ortho) {
        params.set('ortho', '1');
        params.set('span', String(view.span));
      }
      await page.goto(`${base}/studio.html?${params}`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => globalThis.__STUDIO__ > 25, undefined, {
        timeout: 120_000,
        polling: 250,
      });
      const path = join(outDir, `${view.name}.png`);
      await page.screenshot({ path, timeout: 60_000 });
      console.log(`shot ${view.name} -> ${path}`);
    }
    await browser.close();
  } finally {
    server?.kill();
  }
}

await main();
