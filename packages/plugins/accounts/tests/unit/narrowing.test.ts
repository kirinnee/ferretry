import { describe, expect, test } from 'bun:test';
import manifest from '../../manifest.ts';

/**
 * G128a–G128g: the narrowing routes Accounts serves. Each is declared a NARROWING (`narrowing: true`), which is the
 * whole of "never needs a per-act passkey, whatever `stepUpOnActions` says" (G127): the grant, a proven device and the
 * unlock are still asked, nothing more than today. A narrowing route is a person's act that is never held back by a
 * page hold (`guard: none`) and is never unlock-exempt (a locked device cannot narrow either). Descriptors are the
 * ones today's mounts declare (`descriptor-parity`).
 */
const byKey = new Map(manifest.actions.routes.map(route => [route.key as string, route]));

function proveNarrowing(key: string, capability: string, axis: 'use' | 'configure') {
  const route = byKey.get(key);
  expect(route).toBeDefined();
  expect(route?.capability?.narrowing).toBe(true);
  expect(route?.capability?.axis).toBe(axis);
  expect(String(route?.capability?.capability)).toContain(capability);
  expect(route?.caller).toBe('person');
  expect(route?.minimum).toBe('operator');
  expect(route?.unlockExempt).toBeUndefined();
  expect(route?.guard).toEqual({ none: expect.any(String) });
}

describe('G128 Accounts narrowing routes', () => {
  test('G128a plan revoke is a narrowing: never held, never asks a per-act passkey', () => {
    proveNarrowing('POST /v1/ferrets/:ferretId/task-plans/:planId/revoke', 'terminal', 'use');
  });
  test('G128b sign-in rule narrow is a narrowing: never held, never asks a per-act passkey', () => {
    proveNarrowing('POST /v1/sign-in-rules/:id/narrow', 'secrets', 'use');
  });
  test('G128c sign-in rule revoke is a narrowing: never held, never asks a per-act passkey', () => {
    proveNarrowing('DELETE /v1/sign-in-rules/:id', 'secrets', 'use');
  });
  test('G128d revoking every sign-in rule of an account is a narrowing: never held, never asks a per-act passkey', () => {
    proveNarrowing('POST /v1/accounts/:id/sign-in-rules/revoke', 'secrets', 'use');
  });
  test('G128e paste-rule delete is a narrowing: never held, never asks a per-act passkey', () => {
    proveNarrowing('DELETE /v1/copy-rules/:ruleId', 'terminal', 'use');
  });
  test('G128f paste-rule drop is a narrowing: never held, never asks a per-act passkey', () => {
    proveNarrowing('DELETE /v1/copy-rules/stages/:stage', 'terminal', 'use');
  });
  test('G128g removing a default account is a narrowing (setting one is not: G129)', () => {
    proveNarrowing('PUT /v1/accounts/defaults', 'secrets', 'configure');
  });
});
