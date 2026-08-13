// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Layering rules are enforced here, not just documented.
 *
 * The dependency arrow points one way only:
 *
 *   shared  <-  sim  <-  net  <-  render/ui  <-  main
 *
 * `sim` is pure, deterministic, headless TypeScript. If it could reach for
 * Babylon, the DOM, or the network, it would stop being testable in Node and
 * the whole multiplayer test harness would rot. These rules make that a CI
 * failure instead of a code review argument, which is what lets independent
 * agents work in different layers without coordinating.
 */
const denyBabylon = {
  group: ['@babylonjs/*', '@babylonjs/**'],
  message:
    'Babylon.js is renderer-only. This layer must stay headless — put the visual code in src/render/ and drive it from simulation state.',
};

const denyNet = {
  group: ['@/net', '@/net/*', 'trystero', 'trystero/*', '@trystero-p2p/*'],
  message:
    'The simulation must not know about networking. Networking observes the simulation, never the reverse.',
};

const denyRender = {
  group: ['@/render', '@/render/*', '@/ui', '@/ui/*'],
  message: 'Lower layers must not import the render or UI layer.',
};

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'test-results/**',
      'playwright-report/**',
      'public/assets/vendor/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-non-null-assertion': 'error',
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },

  // ---- Layer: shared (leaf; depends on nothing) ----
  {
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [denyBabylon, denyNet, denyRender, { group: ['@/sim', '@/sim/*'] }] },
      ],
    },
  },

  // ---- Layer: sim (pure, deterministic, headless) ----
  {
    files: ['src/sim/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [denyBabylon, denyNet, denyRender] }],
      // Non-determinism is a correctness bug in the simulation, not a style nit.
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'The simulation must run headlessly in Node.' },
        { name: 'document', message: 'The simulation must run headlessly in Node.' },
        { name: 'performance', message: 'Time must be passed in as a fixed timestep, not read.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message:
            'Math.random() breaks determinism and replayability. Use the seeded Rng from @/sim/rng.',
        },
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: 'Date.now() breaks determinism. Derive time from the tick number.',
        },
        {
          selector: "NewExpression[callee.name='Date']",
          message: 'Date breaks determinism. Derive time from the tick number.',
        },
      ],
    },
  },

  // ---- Layer: net (may use sim + shared, never Babylon) ----
  {
    files: ['src/net/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [denyBabylon, denyRender] }],
    },
  },

  // ---- Tests ----
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      'no-console': 'off',
    },
  },

  // ---- Node-side tooling ----
  {
    files: ['scripts/**/*.mjs', '*.config.ts', '*.config.js', 'playwright.config.ts'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', URL: 'readonly' },
    },
    ...tseslint.configs.disableTypeChecked,
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      'no-console': 'off',
      'no-undef': 'off',
    },
  },

  prettier,
);
