import { describe, expect, test } from 'bun:test';
import { AUDIT, CONFIGURE, NARROW_CONFIGURE, SKIP_READ, USE } from '../../contract/index.ts';
import manifest from '../../manifest.ts';

const routes = manifest.actions.routes;
const oneOf = (given: unknown, allowed: readonly unknown[]): boolean =>
  allowed.some(each => JSON.stringify(each) === JSON.stringify(given));

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
  test('I178 login routes need secrets use to list and secrets configure to change, and each change is a kept secrets.changed', () => {
    const login = routes.filter(
      entry =>
        entry.key.includes(' /v1/accounts') &&
        !entry.key.includes('/v1/accounts/plans') &&
        !entry.key.includes('/sign-in-rules/'),
    );
    expect(login.length).toBeGreaterThan(20);
    const list = login.find(entry => entry.key === 'GET /v1/accounts');
    expect(list?.capability).toEqual(USE.secrets);
    for (const entry of login) {
      if (entry.key.startsWith('GET ')) {
        // A read: never recorded as a change, never below secrets use (a stage read is the owner's configure).
        expect(oneOf(entry.capability, [USE.secrets, CONFIGURE.secrets])).toBe(true);
        expect(entry.audit).toEqual(SKIP_READ);
      } else {
        // A change: secrets configure (the default's line may narrow), and a kept secrets.changed record.
        expect(oneOf(entry.capability, [CONFIGURE.secrets, NARROW_CONFIGURE.secrets])).toBe(true);
        expect(entry.audit).toEqual({ record: AUDIT.secretsChanged });
      }
    }
  });
  test('lists the agent tools that are built (account_hint, account_propose, task_plan), none showing a value; the four secure-copy tools are not offered to agents', () => {
    expect(manifest.actions.agentTools.map(entry => entry.name)).toEqual([
      'account_hint',
      'account_propose',
      'task_plan',
    ]);
    for (const entry of manifest.actions.agentTools) expect(entry.guard).not.toBe('secrets');
  });
  test('needs the Vault, its sealed documents and Asks, and takes the phone-approval, sign-in-approval and four step-up stage hooks', () => {
    expect(Object.keys(manifest.needs ?? {}).sort()).toEqual(['asks', 'gate', 'sealed', 'vault']);
    expect(manifest.hooks.takes.map(take => `${take.hook.name}:${take.key}`)).toEqual([
      'redaction.sources:source',
      'input.phone-approval:phone',
      'ask.sources:sign-in-approval',
      'step-up.stages:add-2fa-key',
      'step-up.stages:approve-task-plan',
      'step-up.stages:approve-sign-in-rule',
      'step-up.stages:approve-paste-rule',
    ]);
  });
});
