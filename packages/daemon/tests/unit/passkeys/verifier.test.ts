import { describe, it } from 'bun:test';
import { concatBytes, toBase64Url, utf8Bytes } from '@ferretry/relay';
import should from 'should';
import {
  type AssertionInput,
  type PasskeyCrypto,
  type RegistrationInput,
  relyingPartyId,
  type StoredAssertionInput,
  verifyAssertion,
  verifyRegistration,
  verifyStoredAssertion,
} from '../../../src/lib/passkeys/index.ts';
import {
  assertion,
  attestationObject,
  attestedCredential,
  authData,
  type Authenticator,
  CHALLENGE,
  type Cbor,
  CREDENTIAL_ID,
  cbor,
  clientData,
  ed25519Authenticator,
  es256Authenticator,
  ORIGIN,
  registration,
  rs256Authenticator,
  sha256,
  webCrypto,
} from '../../support/passkey-authenticator.ts';

const authenticators = async (): Promise<Authenticator[]> => [
  await es256Authenticator(),
  await ed25519Authenticator(),
  await rs256Authenticator(),
];

/** Every base64 spelling of every byte input, so a refusal can be proved to echo none of them. */
function spellings(input: RegistrationInput | AssertionInput): string[] {
  const fields: Uint8Array[] = [input.clientDataJSON, input.expectedChallenge];
  if ('attestationObject' in input) fields.push(input.attestationObject);
  else fields.push(input.authenticatorData, input.signature, input.credential.publicKeySpki);
  return fields.flatMap(bytes => [
    toBase64Url(bytes),
    Buffer.from(bytes).toString('base64'),
    Buffer.from(bytes).toString('hex'),
  ]);
}

function shouldEchoNothing(result: unknown, input: RegistrationInput | AssertionInput) {
  const rendered = JSON.stringify(result);
  should(Object.keys(result as object).sort()).deepEqual(['ok', 'reason']);
  for (const spelling of spellings(input)) if (spelling.length >= 8) should(rendered.includes(spelling)).be.false();
}

describe('relyingPartyId', () => {
  it('should be the hostname of an origin, without its port, and empty for something that is not a URL', () => {
    should(relyingPartyId('https://ferretry.pages.dev')).equal('ferretry.pages.dev');
    should(relyingPartyId('http://localhost:5173')).equal('localhost');
    should(relyingPartyId('not an origin')).equal('');
  });
});

describe('verifyRegistration', () => {
  it('should accept a genuine registration from each algorithm and return the credential to store', async () => {
    for (const authenticator of await authenticators()) {
      // Arrange
      const input = await registration(authenticator);

      // Act
      const result = await verifyRegistration(webCrypto, input);

      // Assert
      should(result).deepEqual({
        ok: true,
        credentialId: CREDENTIAL_ID,
        algorithm: authenticator.algorithm,
        publicKeySpki: authenticator.spki,
        signCount: 0,
        origin: ORIGIN,
      });
    }
  });

  it('should accept a packed attestation without checking its statement, and refuse any other format', async () => {
    // Arrange
    const authenticator = await es256Authenticator();
    const packed = await registration(authenticator, { fmt: 'packed', attStmt: new Map([['alg', -7]]) });
    const tpm = await registration(authenticator, { fmt: 'tpm' });

    // Act / Assert
    should((await verifyRegistration(webCrypto, packed)).ok).be.true();
    should(await verifyRegistration(webCrypto, tpm)).deepEqual({ ok: false, reason: 'attestation-unsupported' });
  });

  it('should refuse each broken property with its own reason', async () => {
    // Arrange
    const authenticator = await es256Authenticator();
    const cases: [string, Promise<RegistrationInput>][] = [
      ['wrong-type', registration(authenticator, { client: clientData('webauthn.get') })],
      [
        'challenge-mismatch',
        registration(authenticator, {
          client: clientData('webauthn.create', { challenge: toBase64Url(new Uint8Array(32)) }),
        }),
      ],
      [
        'challenge-mismatch',
        registration(authenticator, {
          client: clientData('webauthn.create', { challenge: `${toBase64Url(CHALLENGE)}=` }),
        }),
      ],
      ['challenge-mismatch', registration(authenticator, { client: clientData('webauthn.create', { challenge: 7 }) })],
      [
        'origin-not-allowed',
        registration(authenticator, { client: clientData('webauthn.create', { origin: 'https://evil.example' }) }),
      ],
      [
        'origin-not-allowed',
        registration(authenticator, { client: clientData('webauthn.create', { origin: `${ORIGIN}/` }) }),
      ],
      ['origin-not-allowed', registration(authenticator, { client: clientData('webauthn.create', { origin: 1 }) })],
      [
        'origin-not-allowed',
        registration(authenticator, { client: clientData('webauthn.create', { crossOrigin: true }) }),
      ],
      ['rp-id-mismatch', registration(authenticator, { auth: { rpId: 'evil.example' } })],
      ['user-not-present', registration(authenticator, { auth: { flags: 0x44 } })],
      ['user-not-verified', registration(authenticator, { auth: { flags: 0x41 } })],
      ['malformed', registration(authenticator, { auth: { flags: 0x05 } })],
    ];

    // Act / Assert
    for (const [reason, pending] of cases) {
      const input = await pending;
      const result = await verifyRegistration(webCrypto, input);
      should(result).deepEqual({ ok: false, reason });
      shouldEchoNothing(result, input);
    }
  });

  it('should ignore crossOrigin when it is absent or false', async () => {
    // Arrange
    const authenticator = await ed25519Authenticator();
    const absent = utf8Bytes(
      JSON.stringify({ type: 'webauthn.create', challenge: toBase64Url(CHALLENGE), origin: ORIGIN }),
    );

    // Act / Assert
    should((await verifyRegistration(webCrypto, await registration(authenticator, { client: absent }))).ok).be.true();
  });

  it('should check in the design’s order: type, challenge, origin, rpId, UP, UV, then the key', async () => {
    // Arrange — every later property is broken too, so each answer proves the earlier one ran first.
    const authenticator = await es256Authenticator();
    const badKey = new Map(authenticator.coseKey).set(3, -35);
    const auth = (flags: number, rpId?: string) =>
      authData({ flags, rpId, attested: attestedCredential(cbor(badKey)) });
    const client = (fields: Parameters<typeof clientData>[1]) => clientData('webauthn.create', fields);
    const wrong = { challenge: toBase64Url(new Uint8Array(32)), origin: 'https://evil.example' };
    const input = (clientDataJSON: Uint8Array, authenticatorData: Uint8Array): RegistrationInput => ({
      clientDataJSON,
      attestationObject: attestationObject(authenticatorData, 'tpm'),
      expectedChallenge: CHALLENGE,
      allowedOrigins: [ORIGIN],
    });
    const steps: [string, RegistrationInput][] = [
      ['wrong-type', input(clientData('webauthn.get', wrong), await auth(0x40, 'evil.example'))],
      ['challenge-mismatch', input(client(wrong), await auth(0x40, 'evil.example'))],
      ['origin-not-allowed', input(client({ origin: wrong.origin }), await auth(0x40, 'evil.example'))],
      ['rp-id-mismatch', input(client({}), await auth(0x40, 'evil.example'))],
      ['user-not-present', input(client({}), await auth(0x40))],
      ['user-not-verified', input(client({}), await auth(0x41))],
      ['attestation-unsupported', input(client({}), await auth(0x45))],
    ];

    // Act / Assert
    for (const [reason, step] of steps)
      should(await verifyRegistration(webCrypto, step)).deepEqual({ ok: false, reason });
    const noneFormat = {
      ...(steps[6] as [string, RegistrationInput])[1],
      attestationObject: attestationObject(await auth(0x45)),
    };
    should(await verifyRegistration(webCrypto, noneFormat)).deepEqual({ ok: false, reason: 'unsupported-algorithm' });
  });

  it('should refuse a malformed clientDataJSON or attestation object without throwing', async () => {
    // Arrange
    const authenticator = await es256Authenticator();
    const valid = await registration(authenticator);
    const auth = await authData({ flags: 0x45, attested: attestedCredential(cbor(authenticator.coseKey)) });
    const attested = (credentialId: Uint8Array, key: Uint8Array) =>
      attestationObject(concatBytes([auth.subarray(0, 37), attestedCredential(key, credentialId)]));
    const key = cbor(authenticator.coseKey);
    const malformed: Partial<RegistrationInput>[] = [
      { clientDataJSON: Uint8Array.of(0xff, 0xfe) },
      { clientDataJSON: utf8Bytes('{not json') },
      { clientDataJSON: utf8Bytes('[1]') },
      { clientDataJSON: utf8Bytes('null') },
      { clientDataJSON: new Uint8Array(4097) },
      { attestationObject: new Uint8Array(16 * 1024 + 1) },
      { attestationObject: Uint8Array.of(0xff) },
      { attestationObject: cbor([1]) },
      { attestationObject: attestationObject(auth, 7) },
      { attestationObject: attestationObject(auth, 'none', 'statement') },
      {
        attestationObject: cbor(
          new Map<string, Cbor>([
            ['fmt', 'none'],
            ['attStmt', new Map()],
            ['authData', 'text'],
          ]),
        ),
      },
      { attestationObject: attestationObject(new Uint8Array(4097)) },
      { attestationObject: attestationObject(auth.subarray(0, 36)) },
      { attestationObject: attestationObject(auth.subarray(0, 37 + 16 + 1)) },
      { attestationObject: attested(new Uint8Array(), key) },
      { attestationObject: attested(new Uint8Array(1024), key) },
      {
        attestationObject: attestationObject(
          concatBytes([auth.subarray(0, 37 + 16), Uint8Array.of(0, 16), CREDENTIAL_ID]),
        ),
      },
      { attestationObject: attested(CREDENTIAL_ID, Uint8Array.of(0xf7)) },
      { attestationObject: attested(CREDENTIAL_ID, concatBytes([key, cbor(new Map([['credProtect', 1]]))])) },
      { attestationObject: attested(CREDENTIAL_ID, cbor(new Map(authenticator.coseKey).set(-2, new Uint8Array(31)))) },
    ];

    // Act / Assert
    for (const override of malformed) {
      const input = { ...valid, ...override };
      const result = await verifyRegistration(webCrypto, input);
      should(result).deepEqual({ ok: false, reason: 'malformed' });
      shouldEchoNothing(result, input);
    }
  });

  it('should accept a credential id of the maximum length', async () => {
    // Arrange
    const authenticator = await rs256Authenticator();
    const longest = new Uint8Array(1023).fill(9);
    const auth = await authData({ flags: 0x45, attested: attestedCredential(cbor(authenticator.coseKey), longest) });
    const input = { ...(await registration(authenticator)), attestationObject: attestationObject(auth) };

    // Act
    const result = await verifyRegistration(webCrypto, input);

    // Assert
    should(result.ok && result.credentialId).deepEqual(longest);
  });
});

describe('verifyAssertion', () => {
  it('should accept a genuine assertion from each algorithm and return the new counter', async () => {
    for (const authenticator of await authenticators()) {
      // Arrange
      const input = await assertion(authenticator, { auth: { signCount: 9 }, storedCount: 8 });

      // Act / Assert
      should(await verifyAssertion(webCrypto, input)).deepEqual({ ok: true, signCount: 9, origin: ORIGIN });
    }
  });

  it('should accept an authenticator that keeps no counter, at zero both times', async () => {
    const input = await assertion(await ed25519Authenticator(), { auth: { signCount: 0 }, storedCount: 0 });
    should(await verifyAssertion(webCrypto, input)).deepEqual({ ok: true, signCount: 0, origin: ORIGIN });
  });

  it('should refuse a counter that stalled, rewound, or fell to zero', async () => {
    // Arrange
    const authenticator = await es256Authenticator();
    const counters: [number, number][] = [
      [5, 5],
      [5, 4],
      [5, 0],
    ];

    // Act / Assert
    for (const [stored, next] of counters) {
      const input = await assertion(authenticator, { auth: { signCount: next }, storedCount: stored });
      should(await verifyAssertion(webCrypto, input)).deepEqual({ ok: false, reason: 'counter-not-increased' });
    }
  });

  it('should read the counter as an unsigned 32-bit big-endian value', async () => {
    const input = await assertion(await es256Authenticator(), {
      auth: { signCount: 0xfffffffe },
      storedCount: 0x7fffffff,
    });
    should(await verifyAssertion(webCrypto, input)).deepEqual({ ok: true, signCount: 0xfffffffe, origin: ORIGIN });
  });

  it('should refuse each broken property with its own reason', async () => {
    // Arrange
    const authenticator = await es256Authenticator();
    const other = await es256Authenticator();
    const tampered = async () => {
      const input = await assertion(authenticator);
      const authenticatorData = input.authenticatorData.slice();
      authenticatorData[36] = 2;
      return { ...input, authenticatorData };
    };
    const cases: [string, Promise<AssertionInput>][] = [
      ['wrong-type', assertion(authenticator, { client: clientData('webauthn.create') })],
      [
        'challenge-mismatch',
        assertion(authenticator, {
          client: clientData('webauthn.get', { challenge: toBase64Url(CHALLENGE.subarray(1)) }),
        }),
      ],
      [
        'origin-not-allowed',
        assertion(authenticator, { client: clientData('webauthn.get', { origin: 'http://localhost:5173' }) }),
      ],
      ['origin-not-allowed', assertion(authenticator, { client: clientData('webauthn.get', { crossOrigin: true }) })],
      ['rp-id-mismatch', assertion(authenticator, { auth: { rpId: 'pages.dev' } })],
      ['user-not-present', assertion(authenticator, { auth: { flags: 0x04 } })],
      ['user-not-verified', assertion(authenticator, { auth: { flags: 0x01 } })],
      ['bad-signature', tampered()],
      [
        'bad-signature',
        assertion(authenticator).then(input => ({
          ...input,
          credential: { ...input.credential, publicKeySpki: other.spki },
        })),
      ],
      ['bad-signature', assertion(authenticator).then(input => ({ ...input, signature: input.signature.subarray(1) }))],
      [
        'bad-signature',
        assertion(authenticator).then(input => ({
          ...input,
          credential: { ...input.credential, publicKeySpki: Uint8Array.of(1, 2, 3) },
        })),
      ],
    ];

    // Act / Assert
    for (const [reason, pending] of cases) {
      const input = await pending;
      const result = await verifyAssertion(webCrypto, input);
      should(result).deepEqual({ ok: false, reason });
      shouldEchoNothing(result, input);
    }
  });

  it('should check the signature before the counter', async () => {
    // Arrange — a stalled counter AND a forged signature: the forgery is what is reported.
    const input = await assertion(await ed25519Authenticator(), { auth: { signCount: 1 }, storedCount: 3 });
    const forged = { ...input, signature: new Uint8Array(64) };

    // Act / Assert
    should(await verifyAssertion(webCrypto, forged)).deepEqual({ ok: false, reason: 'bad-signature' });
    should(await verifyAssertion(webCrypto, input)).deepEqual({ ok: false, reason: 'counter-not-increased' });
  });

  it('should sign over authenticatorData ‖ SHA-256(clientDataJSON) and hand ES256 the raw r‖s form', async () => {
    // Arrange — a recording port proves exactly what the verifier asked it.
    const authenticator = await es256Authenticator();
    const input = await assertion(authenticator);
    const seen: { algorithm: number; signature: Uint8Array; data: Uint8Array }[] = [];
    const recording: PasskeyCrypto = {
      sha256,
      async verify(algorithm, spki, signature, data) {
        seen.push({ algorithm, signature, data });
        return webCrypto.verify(algorithm, spki, signature, data);
      },
    };

    // Act
    const result = await verifyAssertion(recording, input);

    // Assert
    should(result.ok).be.true();
    should(seen).have.length(1);
    should(seen[0]?.algorithm).equal(-7);
    should(seen[0]?.signature).have.length(64);
    should(seen[0]?.data).deepEqual(concatBytes([input.authenticatorData, await sha256(input.clientDataJSON)]));
  });

  it('should refuse oversized or truncated inputs as malformed, before any crypto runs', async () => {
    // Arrange
    const valid = await assertion(await ed25519Authenticator());
    let calls = 0;
    const counting: PasskeyCrypto = {
      sha256: async bytes => {
        calls += 1;
        return sha256(bytes);
      },
      verify: async () => {
        calls += 1;
        return true;
      },
    };
    const malformed: Partial<AssertionInput>[] = [
      { clientDataJSON: new Uint8Array(4097) },
      { authenticatorData: new Uint8Array(4097) },
      { signature: new Uint8Array(1025) },
      { clientDataJSON: utf8Bytes('"webauthn.get"') },
      { authenticatorData: valid.authenticatorData.subarray(0, 36) },
    ];

    // Act / Assert
    for (const override of malformed) {
      const input = { ...valid, ...override };
      const result = await verifyAssertion(counting, input);
      should(result).deepEqual({ ok: false, reason: 'malformed' });
      shouldEchoNothing(result, input);
    }
    should(calls).equal(0);
  });

  it('should accept authenticatorData that is a view into a larger buffer', async () => {
    // Arrange — the counter read must honour byteOffset, not assume the view starts the buffer.
    const input = await assertion(await es256Authenticator(), { auth: { signCount: 7 } });
    const host = new Uint8Array(input.authenticatorData.length + 11);
    host.set(input.authenticatorData, 11);

    // Act / Assert
    should(await verifyAssertion(webCrypto, { ...input, authenticatorData: host.subarray(11) })).deepEqual({
      ok: true,
      signCount: 7,
      origin: ORIGIN,
    });
  });
});

describe('verifyStoredAssertion (a kept proof, checked again offline)', () => {
  /** A kept assertion as a rule's record carries it: the signed bytes, the challenge derived again, the passkey now. */
  const kept = async (
    authenticator: Authenticator,
    overrides: Parameters<typeof assertion>[1] = {},
    passkey: { origin?: string; publicKeySpki?: Uint8Array } = {},
  ): Promise<StoredAssertionInput> => {
    const made = await assertion(authenticator, overrides);
    return {
      clientDataJSON: made.clientDataJSON,
      authenticatorData: made.authenticatorData,
      signature: made.signature,
      expectedChallenge: CHALLENGE,
      passkey: {
        algorithm: authenticator.algorithm,
        publicKeySpki: passkey.publicKeySpki ?? authenticator.spki,
        origin: passkey.origin ?? ORIGIN,
      },
    };
  };

  it('should accept a genuine kept assertion from each algorithm, whatever its counter', async () => {
    for (const authenticator of await authenticators()) {
      for (const signCount of [0, 1, 9]) {
        // Arrange
        const input = await kept(authenticator, { auth: { signCount } });

        // Act + Assert — the same bytes verify again and again: nothing offline moves a counter
        should(await verifyStoredAssertion(webCrypto, input)).deepEqual({ ok: true, signCount, origin: ORIGIN });
        should(await verifyStoredAssertion(webCrypto, input)).deepEqual({ ok: true, signCount, origin: ORIGIN });
      }
    }
  });

  it('should refuse an edited, re-aimed or unverified kept assertion, each with its own reason', async () => {
    // Arrange
    const authenticator = await es256Authenticator();
    const other = await es256Authenticator();
    const ANOTHER_CHALLENGE = Uint8Array.from({ length: 32 }, (_, index) => index);
    const edited = async () => {
      // The same challenge and origin, re-spelled: the signature covers SHA-256 of these exact bytes.
      const input = await kept(authenticator);
      const parsed = JSON.parse(new TextDecoder().decode(input.clientDataJSON)) as Record<string, unknown>;
      return { ...input, clientDataJSON: utf8Bytes(JSON.stringify({ ...parsed, extra: 1 })) };
    };
    const cases: [string, Promise<StoredAssertionInput>][] = [
      ['wrong-type', kept(authenticator, { client: clientData('webauthn.create') })],
      ['challenge-mismatch', kept(authenticator).then(input => ({ ...input, expectedChallenge: ANOTHER_CHALLENGE }))],
      [
        'challenge-mismatch',
        kept(authenticator, { client: clientData('webauthn.get', { challenge: toBase64Url(ANOTHER_CHALLENGE) }) }),
      ],
      // Made at the app, but the passkey on file was made at another origin: the kept origin must be the passkey's.
      ['origin-not-allowed', kept(authenticator, {}, { origin: 'https://ferretry.example.com' })],
      [
        'origin-not-allowed',
        kept(authenticator, { client: clientData('webauthn.get', { origin: 'https://ferretry.example.com' }) }),
      ],
      ['origin-not-allowed', kept(authenticator, { client: clientData('webauthn.get', { crossOrigin: true }) })],
      ['rp-id-mismatch', kept(authenticator, { auth: { rpId: 'pages.dev' } })],
      ['user-not-present', kept(authenticator, { auth: { flags: 0x04 } })],
      ['user-not-verified', kept(authenticator, { auth: { flags: 0x01 } })],
      ['bad-signature', edited()],
      ['bad-signature', kept(authenticator, {}, { publicKeySpki: other.spki })],
      ['bad-signature', kept(authenticator).then(input => ({ ...input, signature: new Uint8Array(64) }))],
      [
        'bad-signature',
        kept(authenticator).then(input => {
          const authenticatorData = input.authenticatorData.slice();
          authenticatorData[36] = 7;
          return { ...input, authenticatorData };
        }),
      ],
    ];

    // Act / Assert
    for (const [reason, pending] of cases) {
      const input = await pending;
      should(await verifyStoredAssertion(webCrypto, input)).deepEqual({ ok: false, reason });
    }
  });

  it('should leave the live check as it was: an unmoved counter is still refused there', async () => {
    // Arrange — one assertion whose counter did not move past the one on file
    const authenticator = await es256Authenticator();
    const live = await assertion(authenticator, { auth: { signCount: 5 }, storedCount: 5 });
    const stored: StoredAssertionInput = {
      clientDataJSON: live.clientDataJSON,
      authenticatorData: live.authenticatorData,
      signature: live.signature,
      expectedChallenge: live.expectedChallenge,
      passkey: { algorithm: authenticator.algorithm, publicKeySpki: authenticator.spki, origin: ORIGIN },
    };

    // Act
    const asLive = await verifyAssertion(webCrypto, live);
    const asKept = await verifyStoredAssertion(webCrypto, stored);

    // Assert — the live ceremony refuses the stalled counter; only the offline re-check skips it
    should(asLive).deepEqual({ ok: false, reason: 'counter-not-increased' });
    should(asKept).deepEqual({ ok: true, signCount: 5, origin: ORIGIN });
  });
});
