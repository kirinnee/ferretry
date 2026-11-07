import { describe, expect, test } from 'bun:test';
import manifest from '../../manifest.ts';

const routes = manifest.actions.routes;

describe('accounts manifest', () => {
  test("declares today's account, rule, secure-copy, task-plan and phone-approval routes", () => {
    expect(routes).toHaveLength(62);
  });
  test('the removed saved-login routes and secret entry verbs are not declared (S84)', () => {
    expect(routes.some(entry => entry.key.includes('/v1/secrets/logins'))).toBe(false);
    expect(manifest.actions.cli.some(entry => entry.verb.startsWith('secret'))).toBe(false);
  });
  test('only the hint is a ferret route; every other account route is a person on the operator minimum', () => {
    const ferretRoutes = routes.filter(entry => entry.caller === 'any').map(entry => entry.key);
    expect(ferretRoutes).toEqual(['GET /v1/accounts/hint']);
    for (const entry of routes) expect(entry.minimum).toBe('operator');
  });
  test("declares today's seven account and secure-copy tools, none showing a value", () => {
    expect(manifest.actions.agentTools.map(entry => entry.name)).toEqual([
      'account_hint',
      'account_propose',
      'secure_copy',
      'secure_list',
      'secure_discard',
      'secure_paste',
      'task_plan',
    ]);
    for (const entry of manifest.actions.agentTools) expect(entry.guard).not.toBe('secrets');
  });
  test('needs the Vault and Asks, and takes the sign-in-approval ask source', () => {
    expect(Object.keys(manifest.needs ?? {}).sort()).toEqual(['asks', 'vault']);
    expect(manifest.hooks.takes.map(take => `${take.hook.name}:${take.key}`)).toEqual(['ask.sources:sign-in-approval']);
  });
});
