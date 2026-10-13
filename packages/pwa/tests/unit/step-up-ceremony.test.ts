/**
 * The step-up ceremony for one machine: options, the passkey sheet, the verdict — in that order, with the
 * app's origin — and the one sentence a person reads when it does not work.
 */

import { afterEach, beforeEach, describe, it } from 'bun:test';
import { FyHttpError } from '@ferretry/protocol/client';
import { toBase64Url } from '@ferretry/relay';
import should from 'should';
import type { z } from 'zod';
import { type DaemonConnection, daemonConnection } from '../../src/lib/daemon-connection.ts';
import { type CredentialsPort, PasskeyCeremonyError, passkeySentence } from '../../src/lib/passkeys.ts';
import { browserCredentials, describeStepUpFailure, stepUpCeremony } from '../../src/lib/step-up-ceremony.ts';
import type { StepUpClient } from '../../src/lib/step-up-client.ts';

const ORIGIN = 'https://ferretry.pages.dev';
const INSTANT = '2026-10-13T10:00:00.000Z';
const daemon = daemonConnection({ daemonId: 'daemon-one', baseUrl: 'https://one.example', deviceId: 'device-one' });
const buffer = (...values: number[]) => Uint8Array.from(values).buffer as ArrayBuffer;

describe('running the ceremony', () => {
  // Bun has no WebAuthn, and the ceremony asks the global whether this browser does.
  const hadPublicKeyCredential = 'PublicKeyCredential' in globalThis;
  beforeEach(() => {
    Object.defineProperty(globalThis, 'PublicKeyCredential', { value: class {}, configurable: true, writable: true });
  });
  afterEach(() => {
    if (!hadPublicKeyCredential) Reflect.deleteProperty(globalThis, 'PublicKeyCredential');
  });

  it('should fetch options, show the passkey sheet, then submit — in that order, at the app origin', async () => {
    // Arrange
    const order: string[] = [];
    const bodies: unknown[] = [];
    const asked: DaemonConnection[] = [];
    const client: StepUpClient = {
      request: async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
        order.push(path);
        bodies.push(JSON.parse(String(init?.body)));
        return schema.parse(
          path === '/v1/step-up/options'
            ? {
                challenge: toBase64Url(Uint8Array.of(5, 6, 7)),
                rpId: 'ferretry.pages.dev',
                allowCredentials: [{ type: 'public-key', id: toBase64Url(Uint8Array.of(0xaa, 0xbb)) }],
                timeout: 60_000,
              }
            : { expiresAt: INSTANT },
        );
      },
    };
    const credentials: CredentialsPort = {
      create: async () => null,
      get: async () => {
        order.push('passkey sheet');
        return {
          type: 'public-key',
          rawId: buffer(0xaa, 0xbb),
          response: { clientDataJSON: buffer(0x7b, 0x7d), authenticatorData: buffer(1, 2, 3), signature: buffer(4, 5) },
        } as unknown as Credential;
      },
    };
    const run = stepUpCeremony({
      client: async connection => {
        asked.push(connection);
        return client;
      },
      credentials,
      origin: ORIGIN,
    });

    // Act
    await run(daemon);

    // Assert
    should(asked).eql([daemon]);
    should(order).eql(['/v1/step-up/options', 'passkey sheet', '/v1/step-up']);
    should(bodies[0]).eql({ origin: ORIGIN });
    should(bodies[1]).eql({
      credentialId: toBase64Url(Uint8Array.of(0xaa, 0xbb)),
      clientDataJSON: toBase64Url(Uint8Array.of(0x7b, 0x7d)),
      authenticatorData: toBase64Url(Uint8Array.of(1, 2, 3)),
      signature: toBase64Url(Uint8Array.of(4, 5)),
    });
  });
});

describe('the sentence for a failed ceremony', () => {
  const describeAt = describeStepUpFailure(ORIGIN);

  it('should use the passkey sentence for a ceremony that ended without a credential', () => {
    for (const kind of ['no-passkey', 'cancelled', 'unsupported', 'insecure-origin'] as const) {
      should(describeAt(new PasskeyCeremonyError(kind))).equal(passkeySentence(kind, ORIGIN));
    }
  });

  it('should say there is no passkey for a daemon that says so', () => {
    should(describeAt(new FyHttpError('refused', 403, 'step_up_no_passkey'))).equal(
      passkeySentence('no-passkey', ORIGIN),
    );
  });

  it('should name the origin and corsOrigins for a copy of the app the machine does not serve', () => {
    const sentence = describeAt(new FyHttpError('refused', 403, 'step_up_origin_not_allowed'));
    should(sentence).containEql(ORIGIN);
    should(sentence).containEql('corsOrigins');
  });

  it('should say a passkey answer that did not check out, without saying why', () => {
    should(describeAt(new FyHttpError('refused', 403, 'step_up_not_verified'))).equal(
      'That passkey confirmation did not check out. Try again.',
    );
  });

  it('should fall back to the message of any other Error', () => {
    should(describeAt(new Error('the network went away'))).equal('the network went away');
    should(describeAt(new FyHttpError('some other refusal', 500, 'something_else'))).equal('some other refusal');
  });

  it('should never print a raw non-Error value', () => {
    should(describeAt('raw string')).equal('The passkey confirmation did not finish. Try again.');
    should(describeAt(undefined)).equal('The passkey confirmation did not finish. Try again.');
  });
});

describe('the browser credential container', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  afterEach(() => {
    if (original === undefined) Reflect.deleteProperty(globalThis, 'navigator');
    else Object.defineProperty(globalThis, 'navigator', original);
  });

  it('should call navigator.credentials with its own receiver, for both create and get', async () => {
    // Arrange — a fake that records `this`, which a WebIDL method called unbound would refuse.
    const seen: { method: string; receiver: unknown; options: unknown }[] = [];
    const credentials = {
      create(this: unknown, options: unknown) {
        seen.push({ method: 'create', receiver: this, options });
        return Promise.resolve(null);
      },
      get(this: unknown, options: unknown) {
        seen.push({ method: 'get', receiver: this, options });
        return Promise.resolve(null);
      },
    };
    Object.defineProperty(globalThis, 'navigator', { value: { credentials }, configurable: true, writable: true });
    const port = browserCredentials();
    const createOptions = { publicKey: {} } as CredentialCreationOptions;
    const getOptions = { publicKey: {} } as CredentialRequestOptions;

    // Act
    await port.create(createOptions);
    await port.get(getOptions);

    // Assert
    should(seen.map(call => call.method)).eql(['create', 'get']);
    should(seen[0]?.receiver).equal(credentials);
    should(seen[1]?.receiver).equal(credentials);
    should(seen[0]?.options).equal(createOptions);
    should(seen[1]?.options).equal(getOptions);
  });
});
