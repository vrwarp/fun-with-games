import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

/**
 * Bind and poll the *same* literal address.
 *
 * Vite's preview server defaults to binding `localhost`, which on a dual-stack
 * host (GitHub's runners, for one) can resolve to `::1` only. Playwright then
 * polls `127.0.0.1`, never gets an answer, and fails with a bare
 * "Timed out waiting for config.webServer" after the server has quite visibly
 * started. Pinning both sides to 127.0.0.1 removes the ambiguity.
 */
const HOST = '127.0.0.1';

const CHROMIUM_ARGS = [
  // Software WebGL so Babylon renders in headless CI containers.
  '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader',
  '--disable-gpu-sandbox',
  // Deterministic fake media devices; keeps WebRTC happy without hardware.
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
];

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Serial in CI: the multiplayer test drives two pages that must find each
  // other, and a loaded machine makes those timings unreliable.
  ...(process.env.CI ? { workers: 1 } : {}),
  reporter: process.env.CI
    ? [
        ['github'],
        ['html', { open: 'never' }],
        ['junit', { outputFile: 'test-results/e2e-junit.xml' }],
      ]
    : [['list']],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: `http://${HOST}:${PORT}`,
    trace: 'on-first-retry',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      // The mobile spec needs a touch-capable device descriptor, so it runs in
      // its own project rather than here.
      testIgnore: /mobile\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { args: CHROMIUM_ARGS },
      },
    },
    {
      // Mobile is a supported target for this game (see CLAUDE.md), so it gets
      // real coverage on a touch device rather than a narrow desktop window:
      // `Pixel 5` sets hasTouch, isMobile and a phone-sized viewport, which is
      // what actually exercises the thumbstick and the responsive HUD.
      name: 'mobile-chrome',
      testMatch: /mobile\.spec\.ts/,
      use: {
        ...devices['Pixel 5'],
        launchOptions: { args: CHROMIUM_ARGS },
      },
    },
  ],
  webServer: {
    command: `npm run build && npm run preview -- --port ${PORT} --host ${HOST}`,
    url: `http://${HOST}:${PORT}`,
    reuseExistingServer: !process.env.CI,
    // Generous: this builds Babylon from scratch first, which is ~80s on a
    // cold CI runner, and the budget covers the build as well as the wait.
    timeout: 300_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
