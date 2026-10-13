/**
 * The browser's passkey ceremony client, driven through a fake `navigator.credentials` that returns
 * objects shaped like a `PublicKeyCredential` (ArrayBuffer `rawId` and response fields).
 */

import { describe, it } from 'bun:test';
import { toBase64Url } from '@ferretry/relay';
import should from 'should';
import {
  type AssertionOptionsWire,
  assertPasskey,
  type CredentialsPort,
  createPasskey,
  PasskeyCeremonyError,
  passkeySentence,
  type RegistrationOptionsWire,
} from '../../src/lib/passkeys.ts';

const ORIGIN = 'https://ferretry.pages.dev';
const buffer = (...values: number[]) => Uint8Array.from(values).buffer as ArrayBuffer;
const bytes = (value: BufferSource | undefined) => Array.from(new Uint8Array(value as ArrayBuffer));

const registrationOptions: RegistrationOptionsWire = {
  challenge: toBase64Url(Uint8Array.of(1, 2, 3, 4)),
  rp: { id: 'ferretry.pages.dev', name: 'Ferretry' },
  user: { id: toBase64Url(Uint8Array.of(9, 9)), name: 'phone', displayName: 'Phone' },
  pubKeyCredParams: [
    { type: 'public-key', alg: -7 },
    { type: 'public-key', alg: -8 },
    { type: 'public-key', alg: -257 },
  ],
};

const assertionOptions: AssertionOptionsWire = {
  challenge: toBase64Url(Uint8Array.of(5, 6, 7)),
  rpId: 'ferretry.pages.dev',
  allowCredentials: [{ type: 'public-key', id: toBase64Url(Uint8Array.of(0xaa, 0xbb)) }],
};

interface Recorded {
  created: CredentialCreationOptions[];
  got: CredentialRequestOptions[];
}

function port(answer: () => Promise<unknown>): CredentialsPort & Recorded {
  const recorded: Recorded = { created: [], got: [] };
  return {
    ...recorded,
    create: async options => {
      recorded.created.push(options);
      return (await answer()) as Credential | null;
    },
    get: async options => {
      recorded.got.push(options);
      return (await answer()) as Credential | null;
    },
  };
}

const attestation = () =>
  Promise.resolve({
    type: 'public-key',
    rawId: buffer(0xaa, 0xbb),
    response: { clientDataJSON: buffer(0x7b, 0x7d), attestationObject: buffer(0xa0) },
  });

const signedAssertion = () =>
  Promise.resolve({
    type: 'public-key',
    rawId: buffer(0xaa, 0xbb),
    response: { clientDataJSON: buffer(0x7b, 0x7d), authenticatorData: buffer(1, 2, 3), signature: buffer(4, 5) },
  });

async function kindOf(pending: Promise<unknown>): Promise<string> {
  try {
    await pending;
  } catch (error) {
    if (error instanceof PasskeyCeremonyError) return error.kind;
    throw error;
  }
  throw new Error('the ceremony unexpectedly succeeded');
}

describe('createPasskey', () => {
  it('should ask for a user-verified, discoverable-if-possible passkey with no attestation', async () => {
    // Arrange
    const credentials = port(attestation);

    // Act
    const wire = await createPasskey(
      credentials,
      {
        ...registrationOptions,
        timeout: 60000,
        excludeCredentials: [{ type: 'public-key', id: toBase64Url(Uint8Array.of(7)) }],
      },
      true,
    );

    // Assert
    should(wire).deepEqual({
      credentialId: toBase64Url(Uint8Array.of(0xaa, 0xbb)),
      clientDataJSON: toBase64Url(Uint8Array.of(0x7b, 0x7d)),
      attestationObject: toBase64Url(Uint8Array.of(0xa0)),
    });
    const publicKey = credentials.created[0]?.publicKey;
    should(bytes(publicKey?.challenge)).deepEqual([1, 2, 3, 4]);
    should(bytes(publicKey?.user.id)).deepEqual([9, 9]);
    should(publicKey?.rp).deepEqual({ id: 'ferretry.pages.dev', name: 'Ferretry' });
    should(publicKey?.user.name).equal('phone');
    should(publicKey?.pubKeyCredParams.map(parameter => parameter.alg)).deepEqual([-7, -8, -257]);
    should(publicKey?.authenticatorSelection).deepEqual({ residentKey: 'preferred', userVerification: 'required' });
    should(publicKey?.attestation).equal('none');
    should(publicKey?.timeout).equal(60000);
    should(bytes(publicKey?.excludeCredentials?.[0]?.id)).deepEqual([7]);
  });

  it('should send no timeout and an empty exclusion list when the daemon names neither', async () => {
    // Arrange
    const credentials = port(attestation);

    // Act
    await createPasskey(credentials, registrationOptions, true);

    // Assert
    const publicKey = credentials.created[0]?.publicKey;
    should(publicKey).not.have.property('timeout');
    should(publicKey?.excludeCredentials).deepEqual([]);
  });

  it('should refuse as unsupported without calling the browser when PublicKeyCredential is missing', async () => {
    // Arrange
    const credentials = port(attestation);

    // Act / Assert — the default reads the real global, which this runtime does not have.
    should(await kindOf(createPasskey(credentials, registrationOptions))).equal('unsupported');
    should(credentials.created).have.length(0);
  });

  it('should refuse a result that is not shaped like a registration credential', async () => {
    const shapes: unknown[] = [
      { rawId: 'aabb', response: {} },
      { rawId: buffer(1), response: null },
      { rawId: buffer(1), response: { clientDataJSON: buffer(1) } },
      { rawId: buffer(1), response: { clientDataJSON: 'x', attestationObject: buffer(1) } },
    ];
    for (const shape of shapes) {
      should(
        await kindOf(
          createPasskey(
            port(() => Promise.resolve(shape)),
            registrationOptions,
            true,
          ),
        ),
      ).equal('unsupported');
    }
  });
});

describe('assertPasskey', () => {
  it('should ask for user verification against exactly the credentials the daemon allows', async () => {
    // Arrange
    const credentials = port(signedAssertion);

    // Act
    const wire = await assertPasskey(credentials, { ...assertionOptions, timeout: 30000 }, true);

    // Assert
    should(wire).deepEqual({
      credentialId: toBase64Url(Uint8Array.of(0xaa, 0xbb)),
      clientDataJSON: toBase64Url(Uint8Array.of(0x7b, 0x7d)),
      authenticatorData: toBase64Url(Uint8Array.of(1, 2, 3)),
      signature: toBase64Url(Uint8Array.of(4, 5)),
    });
    const publicKey = credentials.got[0]?.publicKey;
    should(bytes(publicKey?.challenge)).deepEqual([5, 6, 7]);
    should(publicKey?.rpId).equal('ferretry.pages.dev');
    should(publicKey?.userVerification).equal('required');
    should(publicKey?.timeout).equal(30000);
    should(publicKey?.allowCredentials?.map(credential => [credential.type, bytes(credential.id)])).deepEqual([
      ['public-key', [0xaa, 0xbb]],
    ]);
  });

  it('should omit the timeout when the daemon names none', async () => {
    const credentials = port(signedAssertion);
    await assertPasskey(credentials, assertionOptions, true);
    should(credentials.got[0]?.publicKey).not.have.property('timeout');
  });

  it('should say there is no passkey BEFORE asking the browser when the daemon allows none', async () => {
    // Arrange
    const credentials = port(signedAssertion);

    // Act / Assert — even in a browser without passkeys, the missing passkey is the truer answer.
    should(await kindOf(assertPasskey(credentials, { ...assertionOptions, allowCredentials: [] }, true))).equal(
      'no-passkey',
    );
    should(await kindOf(assertPasskey(credentials, { ...assertionOptions, allowCredentials: [] }))).equal('no-passkey');
    should(credentials.got).have.length(0);
  });

  it('should refuse as unsupported without calling the browser when PublicKeyCredential is missing', async () => {
    const credentials = port(signedAssertion);
    should(await kindOf(assertPasskey(credentials, assertionOptions))).equal('unsupported');
    should(credentials.got).have.length(0);
  });

  it('should refuse a result that is not shaped like an assertion credential', async () => {
    const shapes: unknown[] = [
      { rawId: buffer(1), response: { clientDataJSON: buffer(1), authenticatorData: buffer(1) } },
      { rawId: buffer(1), response: { clientDataJSON: buffer(1), signature: buffer(1) } },
      { rawId: buffer(1), response: { authenticatorData: buffer(1), signature: buffer(1) } },
      { response: { clientDataJSON: buffer(1), authenticatorData: buffer(1), signature: buffer(1) } },
    ];
    for (const shape of shapes) {
      should(
        await kindOf(
          assertPasskey(
            port(() => Promise.resolve(shape)),
            assertionOptions,
            true,
          ),
        ),
      ).equal('unsupported');
    }
  });
});

describe('the ceremony’s failures', () => {
  const failing = (error: unknown) => port(() => Promise.reject(error));

  it('should map each browser refusal to its kind, for both ceremonies', async () => {
    // Arrange
    const cases: [unknown, string][] = [
      [new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError'), 'cancelled'],
      [new DOMException('aborted', 'AbortError'), 'cancelled'],
      [
        new DOMException('The relying party ID is not a registrable domain suffix.', 'SecurityError'),
        'insecure-origin',
      ],
      [new DOMException('Unsupported', 'NotSupportedError'), 'unsupported'],
    ];

    // Act / Assert
    for (const [error, kind] of cases) {
      should(await kindOf(createPasskey(failing(error), registrationOptions, true))).equal(kind);
      should(await kindOf(assertPasskey(failing(error), assertionOptions, true))).equal(kind);
    }
  });

  it('should treat a null credential as a dismissal', async () => {
    should(
      await kindOf(
        assertPasskey(
          port(() => Promise.resolve(null)),
          assertionOptions,
          true,
        ),
      ),
    ).equal('cancelled');
  });

  it('should let an error it does not recognise through unchanged', async () => {
    // Arrange
    const invalidState = new DOMException('already registered', 'InvalidStateError');
    const thrown = 'a string';

    // Act / Assert
    await should(createPasskey(failing(invalidState), registrationOptions, true)).be.rejectedWith(invalidState);
    should(await assertPasskey(failing(thrown), assertionOptions, true).catch((caught: unknown) => caught)).equal(
      thrown,
    );
  });

  it('should refuse options it cannot decode without repeating the value', async () => {
    // Arrange
    const challenge = 'not base64url!';

    // Act
    const error = await createPasskey(port(attestation), { ...registrationOptions, challenge }, true).catch(
      (caught: unknown) => caught,
    );

    // Assert
    should(error).be.instanceOf(TypeError);
    should((error as Error).message.includes(challenge)).be.false();
  });

  it('should carry a message that names the kind and nothing the browser said', () => {
    const error = new PasskeyCeremonyError('cancelled');
    should(error.name).equal('PasskeyCeremonyError');
    should(error.message).not.match(/NotAllowedError/);
  });
});

describe('passkeySentence', () => {
  it('should say the design’s exact sentence when there is no passkey', () => {
    should(passkeySentence('no-passkey', ORIGIN)).equal(
      `This copy of the app at ${ORIGIN} has no passkey for this machine. Add one from a device that already has access, or pair this device again at the machine.`,
    );
  });

  it('should write every kind as plain sentences naming the origin, never a DOMException name', () => {
    for (const kind of ['no-passkey', 'cancelled', 'unsupported', 'insecure-origin'] as const) {
      const sentence = passkeySentence(kind, ORIGIN);
      should(sentence).containEql(ORIGIN);
      should(sentence).not.match(/Error|`|<|\*/);
      should(sentence.endsWith('.')).be.true();
    }
  });

  it('should admit a dismissal, a timeout and a missing passkey look alike', () => {
    should(passkeySentence('cancelled', ORIGIN)).match(/dismissed or timed out, or this browser had no passkey/);
  });
});
