/** `@ferretry/plugin-access/contract/testing` (§7.8): the contract's fake and the conformance suite. */
import { describe, expect, test } from 'bun:test';
import { type AccessApi, BuzzSchema, type PairedDevice, PairedDeviceSchema, type PasskeyVerifier } from '../index.ts';

export interface FakeAccessOptions {
  readonly devices?: readonly PairedDevice[];
  /** How many push enrolments a buzz reaches. */
  readonly enrolments?: number;
  /** What every passkey ceremony answers; a fake refuses unless told otherwise. */
  readonly passkeys?: PasskeyVerifier;
  /** The devices that hold a passkey. */
  readonly withPasskeys?: readonly string[];
}

const refusingVerifier: PasskeyVerifier = {
  verifyRegistration: async () => ({ ok: false, reason: 'the fake verifier proves nothing' }),
  verifyAssertion: async () => ({ ok: false, reason: 'the fake verifier proves nothing' }),
};

/** An in-memory `AccessApi` that records every buzz. */
export function fakeAccess(options: FakeAccessOptions = {}): AccessApi & { readonly buzzes: readonly unknown[] } {
  const devices = (options.devices ?? []).map(device => PairedDeviceSchema.parse(device));
  const buzzes: unknown[] = [];
  return {
    buzzes,
    devices: async () => [...devices],
    passkeys: options.passkeys ?? refusingVerifier,
    holdsPasskey: async deviceId => (options.withPasskeys ?? []).includes(deviceId),
    buzz: async message => {
      buzzes.push(BuzzSchema.parse(message));
      return options.enrolments ?? 0;
    },
  };
}

/** What every `AccessApi` (the real one and every fake) keeps. */
export function accessConformance(name: string, make: () => AccessApi): void {
  describe(`AccessApi conformance: ${name}`, () => {
    test('devices carry no key material and parse as the wire view', async () => {
      for (const device of await make().devices()) {
        expect(PairedDeviceSchema.safeParse(device).success).toBe(true);
        expect(Object.keys(device)).not.toContain('publicKey');
      }
    });
    test('a buzz answers how many devices it reached, never a negative count', async () => {
      const reached = await make().buzz({ tag: 'test', title: 'Test', body: '', url: '/' });
      expect(Number.isInteger(reached) && reached >= 0).toBe(true);
    });
    test('a device it never paired holds no passkey', async () => {
      expect(await make().holdsPasskey('d_never-paired')).toBe(false);
    });
    test('a passkey ceremony with garbage bytes is refused, not thrown', async () => {
      const verdict = await make().passkeys.verifyAssertion({
        clientDataJSON: new Uint8Array([1]),
        authenticatorData: new Uint8Array([1]),
        signature: new Uint8Array([1]),
        expectedChallenge: new Uint8Array([1]),
        allowedOrigins: ['https://app.example.test'],
        credential: { algorithm: -7, publicKeySpki: new Uint8Array([1]), signCount: 0 },
      });
      expect(verdict.ok).toBe(false);
    });
  });
}
