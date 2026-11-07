import { describe, expect, test } from 'bun:test';
import {
  HarnessLoginSubmissionSchema,
  HarnessLoginSubmitRequestSchema,
  LOGIN_KINDS,
  LoginListSchema,
  LoginViewSchema,
  loginLoosening,
} from '../../contract/index.ts';
import { fakeLogins, loginsConformance, sampleLogin } from '../../contract/testing/index.ts';
import manifest from '../../manifest.ts';

const route = (key: string) => manifest.actions.routes.find(candidate => candidate.key === key);

describe('logins contract', () => {
  test('the fake passes the conformance suite, empty and with a login', async () => {
    expect((await loginsConformance(() => fakeLogins())).ok).toBe(true);
    expect((await loginsConformance(() => fakeLogins([sampleLogin('work')]))).ok).toBe(true);
  });

  test('the manifest declares eleven routes under /v1/logins and the five login keys', () => {
    expect(manifest.actions.routes).toHaveLength(11);
    expect(manifest.actions.routes.every(declared => declared.path.startsWith('/v1/logins'))).toBe(true);
    expect(manifest.hooks.takes.map(take => `${take.hook.name}:${take.key}`)).toEqual(
      LOGIN_KINDS.map(kind => `logins:${kind}`),
    );
  });

  test('every sign-in route is a person act on fleet/configure, never stored', () => {
    for (const key of [
      'POST /v1/logins/sign-in',
      'GET /v1/logins/sign-in/:flowId',
      'POST /v1/logins/sign-in/:flowId',
      'DELETE /v1/logins/sign-in/:flowId',
    ]) {
      const declared = route(key);
      expect(declared?.caller).toBe('person');
      expect(String(declared?.capability?.capability)).toBe('fleet');
      expect(declared?.capability?.axis).toBe('configure');
      expect(declared?.noStore).toBe(true);
    }
  });

  test('Check now and Test are fleet/configure open to a ferret caller; the list and presets are fleet/use reads', () => {
    expect(route('POST /v1/logins/:loginId/check')?.capability?.axis).toBe('configure');
    expect(route('POST /v1/logins/:loginId/test')?.capability?.axis).toBe('configure');
    expect(route('GET /v1/logins')?.capability?.axis).toBe('use');
    expect(route('GET /v1/logins/presets')?.noStore).toBeUndefined();
  });

  test('S167 (declaration only) a login Test is recorded as a secret use and spends no value out', () => {
    expect(route('POST /v1/logins/:loginId/test')?.audit as unknown).toEqual({ record: 'secrets.used:login-test' });
  });

  test('a login row and the list have no field that could carry a token', () => {
    const row = sampleLogin('work');
    expect(LoginViewSchema.safeParse({ ...row, refreshToken: 'x' }).success).toBe(false);
    expect(LoginListSchema.safeParse({ format: 1, machine: 'm', logins: [row], accessToken: 'x' }).success).toBe(false);
  });

  test('a sign-in submission carries the value in, and no flow shape can hold a token out', () => {
    expect(HarnessLoginSubmitRequestSchema.safeParse({ code: 'abc' }).success).toBe(true);
    expect(HarnessLoginSubmitRequestSchema.safeParse({ method: 'recheck' }).success).toBe(true);
    expect(HarnessLoginSubmissionSchema.safeParse({ outcome: 'refused', reason: 'x', token: 'y' }).success).toBe(false);
  });

  test('dropping or raising a budget limit is a loosening; lowering or adding one is not', () => {
    const budget = (daily: number | undefined) => ({
      budget: daily === undefined ? undefined : { daily: { hard: daily } },
    });
    expect(loginLoosening('a', budget(5), budget(10))).toHaveLength(1);
    expect(loginLoosening('a', budget(5), {})).toHaveLength(1);
    expect(loginLoosening('a', budget(10), budget(5))).toEqual([]);
    expect(loginLoosening('a', {}, budget(5))).toEqual([]);
    expect(loginLoosening('a', undefined, budget(5))).toEqual([]);
  });
});
