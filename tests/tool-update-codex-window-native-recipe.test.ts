import { expect, test } from 'vitest';
import { deriveWindowNativeRecipe } from '../scripts/tool-update/codex-window-native-recipe.mjs';

test('the frozen native recipe preserves argument boundaries and replaces inherited manager markers', () => {
  const recipe = deriveWindowNativeRecipe('/synthetic/prefix', {
    argv_tail: ['--config', 'value with spaces', '--version'],
    environment: {
      PATH: '/synthetic/tools',
      CODEX_MANAGED_PACKAGE_ROOT: '/wrong/root',
      CODEX_MANAGED_BY_NPM: '0',
      CODEX_MANAGED_BY_BUN: '0',
      CODEX_MANAGED_BY_PNPM: '0',
      CODEX_MANAGED_BY_VITE_PLUS: '0'
    }
  });
  expect(recipe.argv).toEqual([
    '/synthetic/prefix/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex',
    '--config',
    'value with spaces',
    '--version'
  ]);
  expect(recipe.environment).toEqual({
    PATH: '/synthetic/tools',
    CODEX_MANAGED_PACKAGE_ROOT: '/synthetic/prefix/node_modules/@openai/codex',
    CODEX_MANAGED_BY_NPM: '1'
  });
});

test.each([{ npm_config_user_agent: 'bun/1.4.4' }, { npm_config_user_agent: 'npm/11', npm_execpath: '/synthetic/bun' }])(
  'the frozen environment models the launcher Bun fallback from explicit inputs %j',
  environment => {
    const recipe = deriveWindowNativeRecipe('/synthetic/prefix', {
      argv_tail: [],
      environment
    });
    expect(recipe.environment.CODEX_MANAGED_BY_BUN).toBe('1');
    expect(recipe.environment.CODEX_MANAGED_BY_NPM).toBeUndefined();
  }
);
