import { describe, expect, test } from 'bun:test';
import manifest from '../../manifest.ts';

const routes = manifest.actions.routes;
const members = manifest.actions.memberRoutes;

describe('catalogs manifest', () => {
  test('declares the catalog, share, member, link and install routes and the eleven member routes (the new GET /v1/shared/contract is one)', () => {
    expect(routes).toHaveLength(47);
    expect(members).toHaveLength(11);
  });
  test("Projects' and Skills' routes, mounted from catalogs.ts today, are not declared here", () => {
    expect(routes.some(entry => /\/v1\/(projects|skills)\b/u.test(entry.key))).toBe(false);
    expect(routes.some(entry => /\/v1\/sessions\/:sessionId\/skills/u.test(entry.key))).toBe(false);
    expect(routes.some(entry => entry.key.includes('/v1/skill-installs'))).toBe(false);
  });
  test('joining and unlocking need only a member key; everything else a member reads needs the unlock', () => {
    const keyOnly = members.filter(entry => entry.member === 'key').map(entry => entry.key);
    expect(keyOnly.sort()).toEqual([
      'POST /v1/shared/passkeys',
      'POST /v1/shared/passkeys/options',
      'POST /v1/shared/unlock',
      'POST /v1/shared/unlock/options',
    ]);
    for (const entry of members) expect(entry.noStore).toBe(true);
  });
  // A member unlocks with its own passkeys and never steps up: Gate's `step-up` hook has Access as its only taker.
  test('needs Access by token name and takes the member credential and session mode (never a step-up)', () => {
    expect(Object.keys(manifest.needs ?? {})).toEqual(['access', 'gate', 'vault', 'sealed']);
    expect(Object.keys(manifest.uses)).toEqual(['connections', 'projects', 'skills']);
    expect(manifest.hooks.takes.map(take => `${take.hook.name}:${take.key}`)).toEqual([
      'credentials:member',
      'session.modes:member',
    ]);
  });
});
