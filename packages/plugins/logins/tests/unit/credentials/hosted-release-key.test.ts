import { afterEach, describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';

const GLOBAL = '__FY_HOSTED_APP_RELEASE_KEY__';
const PREVIEW_KEY = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();

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

  it('should refuse a malformed supplied key without falling back to production or quoting the value', async () => {
    for (const value of ['not a key', '', 42, PREVIEW_KEY.replace('MCow', 'broken')]) {
      await expect(loadWith(value)).rejects.toThrow('The hosted app release key must be an Ed25519 public key.');
    }
  });

  it('should refuse a valid PEM key for the wrong signing algorithm', async () => {
    const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      .publicKey.export({ type: 'spki', format: 'pem' })
      .toString();
    await expect(loadWith(key)).rejects.toThrow('The hosted app release key must be an Ed25519 public key.');
  });
});
