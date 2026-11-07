import { describe, expect, test } from 'bun:test';
import {
  cap,
  DEFAULT_CAPABILITY_GRANTS,
  FULL_DEVICE_GRANTS,
  GateConfigSchema,
  LIMITED_DEVICE_GRANTS,
} from '../../../../contract/index.ts';
import { resolveApiActor } from '../../../../daemon/lib/api/actor.ts';
import { authenticate, bearerDigest, bearerToken, secretsMatch } from '../../../../daemon/lib/api/authentication.ts';
import { decideCapability, demandNeedsStepUp, intersectGrants } from '../../../../daemon/lib/api/capability.ts';
import { FakeFerretBearers } from '../../../../contract/testing/index.ts';

const governed = { grants: DEFAULT_CAPABILITY_GRANTS, governed: true, hostLocal: false, stepUp: false } as const;

describe('the grant decision', () => {
  test('G98 a governed caller steps up for every configure and the use of terminal, browser, pairing, secrets, sharing', () => {
    for (const name of ['fleet', 'terminal', 'browser', 'filesystem', 'warden', 'pairing', 'secrets', 'sharing'] as const)
      expect(demandNeedsStepUp(cap(name, 'configure'))).toBe(true);
    const use = Object.fromEntries(
      (['fleet', 'terminal', 'browser', 'filesystem', 'warden', 'pairing', 'secrets', 'sharing'] as const).map(name => [
        name,
        demandNeedsStepUp(cap(name, 'use')),
      ]),
    );
    expect(use).toEqual({
      fleet: false,
      terminal: true,
      browser: true,
      filesystem: false,
      warden: false,
      pairing: true,
      secrets: true,
      sharing: true,
    });
  });

  test('G99 G58 G60 the step-up rule is read where the grant is: one decision answers both', () => {
    expect(decideCapability(cap('secrets', 'use'), governed)).toEqual({ allowed: false, refusal: 'step-up-required' });
    expect(decideCapability(cap('sharing', 'use'), { ...governed, stepUp: true })).toEqual({
      allowed: true,
      refusal: 'granted',
      steppedUp: true,
    });
    expect(decideCapability(cap('fleet', 'use'), governed)).toEqual({ allowed: true, refusal: 'granted' });
  });

  test('G46 G121 no step-up buys a governed caller a capability the daemon-wide half has off', () => {
    const off = { ...DEFAULT_CAPABILITY_GRANTS, fleet: { use: false, configure: false } };
    expect(decideCapability(cap('fleet', 'configure'), { ...governed, grants: off, stepUp: true })).toEqual({
      allowed: false,
      refusal: 'not-granted',
    });
  });

  test('G133 G135 effective = daemon-wide ∧ device; a newly paired device holds everything', () => {
    expect(intersectGrants(DEFAULT_CAPABILITY_GRANTS, FULL_DEVICE_GRANTS)).toEqual(FULL_DEVICE_GRANTS);
    expect(intersectGrants(DEFAULT_CAPABILITY_GRANTS, LIMITED_DEVICE_GRANTS)).toEqual(LIMITED_DEVICE_GRANTS);
  });

  test('G152 no grants key means every axis takes the product default; G153 a wrong key fails to parse', () => {
    expect(GateConfigSchema.parse({}).grants).toEqual(DEFAULT_CAPABILITY_GRANTS);
    expect(GateConfigSchema.safeParse({ grantz: {} }).success).toBe(false);
  });

  test('G35 the capability list is closed: an unknown capability is undetermined, never granted', () => {
    expect(decideCapability({ capability: 'sessions' as never, axis: 'use' }, governed)).toEqual({
      allowed: false,
      refusal: 'undetermined',
    });
  });
});

describe('authentication', () => {
  test('a blank configured token authenticates nothing', () => {
    expect(authenticate({ admin: '' }, undefined, { bearer: '', privilegedLocal: true })).toEqual({ kind: 'anonymous' });
  });

  test('secrets compare in full and bearer reads only the Bearer scheme', () => {
    expect(secretsMatch('abc', 'abc')).toBe(true);
    expect(secretsMatch('abc', 'abd')).toBe(false);
    expect(secretsMatch('abc', 'abcd')).toBe(false);
    expect(bearerToken('Bearer x')).toBe('x');
    expect(bearerToken('Basic x')).toBeUndefined();
  });

  test('S56 removed: only a fys_-shaped value is ever looked up as a ferret token', () => {
    const ferrets = new FakeFerretBearers();
    ferrets.issue(bearerDigest('unprefixed-value'), 'F1' as never);
    expect(authenticate({ admin: 'a' }, ferrets, { bearer: 'unprefixed-value', privilegedLocal: true })).toEqual({
      kind: 'anonymous',
    });
  });

  test('actors are attributed from the token class, never a header’s class', () => {
    expect(resolveApiActor({ tokenClass: 'admin', client: 'cli' })).toBe('admin-cli');
    expect(resolveApiActor({ tokenClass: 'admin' })).toBe('admin-ui');
    expect(resolveApiActor({ tokenClass: 'admin', ferret: 'F1' })).toBe('ferret:F1');
    expect(resolveApiActor({ tokenClass: 'warden', ferret: 'W1' })).toBe('warden:W1');
    expect(resolveApiActor({ tokenClass: 'ferret', ferret: 'F2' })).toBe('ferret:F2');
  });
});
