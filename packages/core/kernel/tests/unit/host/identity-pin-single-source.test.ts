import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { IDENTITY_FILE } from '../../../host/identity.ts';
import { PINNED_KEY_PATHS } from '../../../host/fence-guard.ts';

/**
 * F-0033, one owner for the fact: where the daemon's identity key lives is `IDENTITY_FILE` in `host/identity.ts`, and
 * the fence pins THAT constant. A second spelling of the path in the host (the way a stale `state/daemon-identity.json`
 * pin once drifted from the file the kernel really writes) fails here.
 */
const HOST = new URL('../../../host/', import.meta.url);
const HOST_DIR = HOST.pathname.replace(/\/$/u, '');
const sources = (): { name: string; code: string }[] =>
  readdirSync(HOST, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.ts'))
    .map(entry => {
      const name = relative(HOST_DIR, `${entry.parentPath}/${entry.name}`);
      const code = readFileSync(`${entry.parentPath}/${entry.name}`, 'utf8')
        .split('\n')
        .filter(line => !/^\s*(\/\/|\*|\/\*)/u.test(line))
        .join('\n');
      return { name, code };
    });

describe('F-0033 the identity key path has one owner', () => {
  test('F-0033 the fence pins the exported constant, and the stale pin is gone', () => {
    expect(IDENTITY_FILE).toBe('state/kernel/identity.json');
    expect(PINNED_KEY_PATHS).toContain(IDENTITY_FILE);
    expect(PINNED_KEY_PATHS).not.toContain('state/daemon-identity.json');
  });

  test('F-0033 the fence imports the constant from identity.ts', () => {
    const fence = readFileSync(new URL('fence-guard.ts', HOST), 'utf8');
    expect(fence).toMatch(/import \{[^}]*\bIDENTITY_FILE\b[^}]*\} from '\.\/identity\.ts'/u);
  });

  test('F-0033 no host source but identity.ts spells the key path or names the old identity file', () => {
    const spelled = sources()
      .filter(source => source.name !== 'identity.ts')
      .filter(source => /kernel\/identity\.json|daemon-identity/u.test(source.code))
      .map(source => source.name);
    expect(spelled).toEqual([]);
  });
});
