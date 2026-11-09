/**
 * The app's build config loads under Node exactly as `vite build` loads it.
 *
 * Vite bundles `vite.config.ts` but leaves workspace packages external, so Node imports them with its own type
 * stripping, which refuses TypeScript-only syntax (parameter properties, enums). Bun accepts that syntax, so no other
 * test sees it: the 5.0 preview deploy failed on exactly this when a config import reached the kernel contract barrel.
 * This spawns Node and asks Vite to load the config the way the build does.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const appDir = join(import.meta.dir, '..', '..');
const configFile = join(appDir, 'vite.config.ts');

const program = `
const { loadConfigFromFile } = await import('vite');
const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, ${JSON.stringify(configFile)}, ${JSON.stringify(appDir)}, 'silent');
process.stdout.write(loaded ? 'config-loaded' : 'no-config');
`;

describe('vite.config.ts under Node', () => {
  test('Vite loads the build config through Node without a type-stripping refusal', () => {
    const result = spawnSync('node', ['--input-type=module', '-e', program], {
      cwd: appDir,
      encoding: 'utf8',
      timeout: 4_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.stderr).not.toContain('ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX');
    expect(result.stdout).toBe('config-loaded');
    expect(result.status).toBe(0);
  });
});
