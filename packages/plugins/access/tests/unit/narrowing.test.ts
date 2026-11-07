import { describe, expect, test } from 'bun:test';
import manifest from '../../manifest.ts';

/**
 * G128h–G128i: the narrowing routes Access serves. Each is declared a NARROWING (`narrowing: true`), which is the
 * whole of "never needs a per-act passkey, whatever `stepUpOnActions` says" (G127): the grant, a proven device and the
 * unlock are still asked, nothing more than today. A narrowing route is a person's act, never held back by a page hold
 * (`guard: none`) and never unlock-exempt. Descriptors are the ones today's mounts declare (`descriptor-parity`).
 */
const byKey = new Map(manifest.actions.routes.map(route => [route.key as string, route]));

function proveNarrowing(key: string) {
  const route = byKey.get(key);
  expect(route).toBeDefined();
  expect(route?.capability?.narrowing).toBe(true);
  expect(route?.capability?.axis).toBe('use');
  expect(String(route?.capability?.capability)).toBe('pairing');
  expect(route?.caller).toBe('person');
  expect(route?.minimum).toBe('operator');
  expect(route?.unlockExempt).toBeUndefined();
  expect(route?.guard).toEqual({ none: expect.any(String) });
}

describe('G128 Access narrowing routes', () => {
  test('G128h device revoke is a narrowing: never held, never asks a per-act passkey', () => {
    proveNarrowing('DELETE /v1/pair/devices/:deviceId');
  });
  test('G128i device grants PATCH is a narrowing route: never held, never asks a per-act passkey', () => {
    proveNarrowing('PATCH /v1/pair/devices/:deviceId/grants');
  });
});
