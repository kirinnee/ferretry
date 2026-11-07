import { describe, expect, test } from 'bun:test';
import { AUDIT } from '../../contract/index.ts';
import manifest from '../../manifest.ts';

const routes = manifest.actions.routes;
const byKey = new Map(routes.map(route => [route.key, route]));

describe('access manifest', () => {
  test("declares today's pairing, passkey, unlock and push routes, and not the daemon-wide grants", () => {
    expect(routes).toHaveLength(20);
    expect(byKey.has('POST /v1/pair/code')).toBe(true);
    expect(byKey.has('POST /v1/unlock')).toBe(true);
    expect([...byKey.keys()].some(key => key.includes('/v1/grants'))).toBe(false);
  });
  test('minting an invite is a person route on pairing.use, kept in the audit log, never stored', () => {
    const mint = byKey.get('POST /v1/pair/code');
    expect(mint?.caller).toBe('person');
    expect(mint?.capability?.axis).toBe('use');
    expect(mint?.noStore).toBe(true);
    expect(mint?.audit).toEqual({ record: AUDIT.pairingCodeMinted });
  });
  test('revoking a device only narrows, so it is never harder than granting', () => {
    expect(byKey.get('DELETE /v1/pair/devices/:deviceId')?.capability?.narrowing).toBe(true);
  });
  test('only the ceremonies a locked device needs are unlock-exempt', () => {
    expect(
      routes
        .filter(route => route.unlockExempt)
        .map(route => route.key)
        .sort(),
    ).toEqual([
      'GET /v1/passkeys',
      'POST /v1/passkeys',
      'POST /v1/passkeys/options',
      'POST /v1/unlock',
      'POST /v1/unlock/options',
    ]);
  });
  test('takes the device credential, step-up and both session modes', () => {
    expect(manifest.hooks.takes.map(take => `${take.hook.name}:${take.key}`)).toEqual([
      'credentials:device',
      'step-up:device',
      'session.modes:device',
      'session.modes:pair',
    ]);
  });
  test('every half is a skeleton', async () => {
    for (const half of ['daemon', 'app', 'cli']) {
      const module = await import(`../../${half}/index.ts`);
      expect(module.default.skeleton).toBe(true);
    }
  });
});
