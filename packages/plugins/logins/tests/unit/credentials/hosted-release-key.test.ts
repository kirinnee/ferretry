import { afterEach, describe, expect, it } from 'bun:test';

const GLOBAL = '__FY_HOSTED_APP_RELEASE_KEY__';
const PREVIEW_KEY =
  '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAPREVIEWKEYPREVIEWKEYPREVIEWKEYPREVIEWKEY=\n-----END PUBLIC KEY-----\n';

/** Load the module afresh under a build-time value, as a build that defines the constant would. */
async function loadWith(value: unknown): Promise<string> {
  const scope = globalThis as unknown as Record<string, unknown>;
  if (value === undefined) delete scope[GLOBAL];
  else scope[GLOBAL] = value;
  const module = (await import(`../../../daemon/lib/shared/hosted.ts?release-key=${String(Math.random())}`)) as {
    HOSTED_APP_RELEASE_KEY: string;
  };
  return module.HOSTED_APP_RELEASE_KEY;
}

afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>)[GLOBAL];
});

describe('the hosted app’s release key', () => {
  it('should be the production key when the build names no other', async () => {
    const key = await loadWith(undefined);
    expect(key).toContain('BEGIN PUBLIC KEY');
    expect(key).not.toBe(PREVIEW_KEY);
  });

  it('should be the key a build for another hosted app is given, so its catalog verifies against its own origin', async () => {
    expect(await loadWith(PREVIEW_KEY)).toBe(PREVIEW_KEY);
  });

  it('should fall back to the production key when the build’s value is not a PEM public key', async () => {
    const production = await loadWith(undefined);
    expect(await loadWith('not a key')).toBe(production);
    expect(await loadWith(42)).toBe(production);
  });
});
