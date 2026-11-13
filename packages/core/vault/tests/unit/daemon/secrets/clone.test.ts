import { beforeAll, describe, it } from 'bun:test';
import type { Clock as KernelClock } from '@ferretry/kernel/contract';
import {
  CloneableSecretNameSchema,
  SealedSecretBundleSchema,
  SecretCloneNamesSchema,
  SecretImportCompleteRequestSchema,
  SecretImportResultSchema,
  MAX_SECRETS_PER_DAEMON,
  type SealedSecretBundle,
  type SecretCloneRefusal,
  type SecretImportOffer,
} from '../../../../contract/index.ts';
import { WebCryptoCloneCrypto } from '../../../../daemon/adapters/secrets/webcrypto-clone-crypto.ts';
import { fromBase64Url, toBase64Url } from '../../../../daemon/lib/secrets/clone-binary.ts';
import type { CloneCrypto as RelayCrypto, DaemonIdentity } from '../../../../daemon/lib/secrets/clone-crypto.ts';
import should from 'should';
import {
  MAX_OPEN_SECRET_IMPORTS,
  SecretCloneError,
  SecretExportService,
  SecretImportService,
} from '../../../../daemon/lib/secrets/clone.ts';
import { SecretDirectory, SecretVault } from '../../../../daemon/lib/secrets/vault.ts';
import { SecretStoreError, UnknownSecretError } from '../../../../daemon/lib/secrets/types.ts';
import { FakeSecretCipher, MemorySecretDocuments } from '../support.ts';

const crypto_ = new WebCryptoCloneCrypto();
const START = Date.parse('2026-10-20T10:00:00.000Z');
const VALUE = 'sk-live-0123456789';

/** Names as a copy takes them: parsed, so a sign-in's cannot be written here by accident. */
const named = (...names: string[]) => names.map(name => CloneableSecretNameSchema.parse(name));

/** A clock a test moves by hand. */
class Clock {
  constructor(public ms = START) {}
  now() {
    return new Date(this.ms).toISOString() as ReturnType<KernelClock['now']>;
  }
}
const kernel = (clock: Clock): KernelClock => clock as unknown as KernelClock;

async function makeIdentity(): Promise<DaemonIdentity> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as unknown as CryptoKeyPair;
  const der = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  return await crypto_.importDaemonIdentity(
    ['-----BEGIN PRIVATE KEY-----', ...(base64.match(/.{1,64}/gu) ?? []), '-----END PRIVATE KEY-----', ''].join('\n'),
  );
}

let sourceIdentity: DaemonIdentity;
let targetIdentity: DaemonIdentity;
let strangerIdentity: DaemonIdentity;

beforeAll(async () => {
  [sourceIdentity, targetIdentity, strangerIdentity] = await Promise.all([
    makeIdentity(),
    makeIdentity(),
    makeIdentity(),
  ]);
});

interface Machine {
  readonly documents: MemorySecretDocuments;
  readonly directory: SecretDirectory;
  readonly imports: SecretImportService;
  readonly exports: SecretExportService;
}

function machine(identity: DaemonIdentity | undefined, clock: Clock, exportCrypto: RelayCrypto = crypto_): Machine {
  const documents = new MemorySecretDocuments();
  const cipher = new FakeSecretCipher();
  const directory = new SecretDirectory(documents, cipher, kernel(clock));
  const source = { load: async () => identity };
  return {
    documents,
    directory,
    imports: new SecretImportService({ crypto: crypto_, identity: source, directory, clock: kernel(clock) }),
    exports: new SecretExportService({
      crypto: exportCrypto,
      identity: source,
      vault: new SecretVault(documents, cipher),
      clock: kernel(clock),
    }),
  };
}

/** A crypto whose seal encrypts what `replace` says instead of what the exporter built — a careless source. */
function sealing(replace: () => unknown): RelayCrypto {
  return Object.create(crypto_, {
    seal: {
      value: (key: never, nonce: Uint8Array, aad: Uint8Array, _plaintext: Uint8Array) => {
        const body = replace();
        return crypto_.seal(
          key,
          nonce,
          aad,
          new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body)),
        );
      },
    },
  });
}

async function refusal(work: Promise<unknown>): Promise<SecretCloneRefusal> {
  try {
    await work;
  } catch (error) {
    if (error instanceof SecretCloneError) return error.refusal;
    throw error;
  }
  throw new Error('expected a refusal');
}

/** Flips one bit of a base64url field, so the field still parses and no longer authenticates. */
function flipped(field: string): string {
  const bytes = fromBase64Url(field) as Uint8Array;
  bytes[0] = (bytes[0] as number) ^ 1;
  return toBase64Url(bytes);
}

async function pair(clock = new Clock()) {
  const source = machine(sourceIdentity, clock);
  const target = machine(targetIdentity, clock);
  await source.directory.put('API_KEY', VALUE);
  await source.directory.put('DB_PASSWORD', 'correct-horse-battery');
  return { clock, source, target };
}

describe('copying secrets between machines', () => {
  it('S153 open an import signed by the target and carrying only public facts', async () => {
    // Arrange
    const { target } = await pair();

    // Act
    const offer = await target.imports.open();

    // Assert
    should(offer.daemonId).equal(targetIdentity.daemonId);
    should(offer.expiresAt).equal('2026-10-20T10:05:00.000Z');
    should(offer.importId).match(/^fy_secret_import_[A-Za-z0-9_-]{22}$/u);
    should(Object.keys(offer).sort()).deepEqual([
      'daemonId',
      'expiresAt',
      'identityKey',
      'importId',
      'publicKey',
      'signature',
      'v',
    ]);
  });

  it('S160 copy the chosen values into the target, and only those', async () => {
    // Arrange
    const { source, target } = await pair();
    const offer = await target.imports.open();

    // Act
    const exported = await source.exports.seal(offer.importId, { offer, names: named('API_KEY') });
    const result = await target.imports.complete(offer.importId, exported.bundle);

    // Assert — the bundle names its contents and carries no value in clear.
    should(JSON.stringify(exported)).not.containEql(VALUE);
    should(exported.names).deepEqual(['API_KEY']);
    should(result).deepEqual({
      importId: offer.importId,
      sourceDaemonId: sourceIdentity.daemonId,
      imported: ['API_KEY'],
      filedAt: new Date(START).toISOString(),
      kept: [],
    });
    should((await target.directory.list()).map(secret => secret.name)).deepEqual(['API_KEY']);
    should(await new SecretVault(target.documents, new FakeSecretCipher()).values()).deepEqual(
      new Map([['API_KEY', VALUE]]),
    );
  });

  describe('a key this machine already holds', () => {
    const OLD_API = 'old-api-value-here';
    const OLD_DB = 'old-db-value-here';
    const OLD_OTHER = 'untouched-other-value';

    /** A target that holds three keys; the source holds two of them under new values. */
    async function held() {
      const clock = new Clock();
      const { source, target } = await pair(clock);
      await target.directory.put('API_KEY', OLD_API);
      await target.directory.put('DB_PASSWORD', OLD_DB);
      await target.directory.put('OTHER_KEY', OLD_OTHER);
      clock.ms += 60_000;
      const offer = await target.imports.open();
      const { bundle } = await source.exports.seal(offer.importId, { offer, names: named('API_KEY', 'DB_PASSWORD') });
      const values = async () => await new SecretVault(target.documents, new FakeSecretCipher()).values();
      return { target, offer, bundle, values, clock };
    }

    it('S142 S148 never write it: every held entry stays byte for byte as it was, and the answer says they were kept', async () => {
      // Arrange
      const { target, offer, bundle, values } = await held();
      const document = JSON.stringify(await target.documents.read());
      const before = [...(await values())];
      const listed = await target.directory.list();

      // Act
      const result = await target.imports.complete(offer.importId, bundle);

      // Assert — nothing was written: not a value, not a timestamp, not one byte of the sealed document.
      should(JSON.stringify(await target.documents.read())).equal(document);
      should([...(await values())]).deepEqual(before);
      should(await target.directory.list()).deepEqual(listed);
      should(result.kept).deepEqual(['API_KEY', 'DB_PASSWORD']);
      should(result.imported).deepEqual([]);
      should(result.filedAt).be.undefined();
      should(Object.keys(result)).not.containEql('replaced');
    });

    it('should file a name that is new beside it, and leave the held ones untouched', async () => {
      // Arrange
      const clock = new Clock();
      const { source, target } = await pair(clock);
      await target.directory.put('API_KEY', OLD_API);
      await source.directory.put('NEW_KEY', 'a-brand-new-value');
      const heldEntry = (await target.documents.read())?.entries.API_KEY;
      clock.ms += 60_000;
      const offer = await target.imports.open();
      const { bundle } = await source.exports.seal(offer.importId, { offer, names: named('API_KEY', 'NEW_KEY') });

      // Act
      const result = await target.imports.complete(offer.importId, bundle);

      // Assert
      should(result.imported).deepEqual(['NEW_KEY']);
      should(result.kept).deepEqual(['API_KEY']);
      should(result.filedAt).equal(new Date(clock.ms).toISOString());
      const document = await target.documents.read();
      should(document?.entries.API_KEY).deepEqual(heldEntry);
      should(document?.entries.NEW_KEY?.createdAt).equal(result.filedAt);
      should((await new SecretVault(target.documents, new FakeSecretCipher()).values()).get('API_KEY')).equal(OLD_API);
    });

    it('S150 keep a name that is created after the copy began and before it was filed, and not say it was filed', async () => {
      // Arrange — the key does not exist when the copy is opened; somebody sets it just before the filing turn
      const clock = new Clock();
      const { source, target } = await pair(clock);
      const racing = Object.create(target.directory, {
        putMissing: {
          value: async (entries: Parameters<SecretDirectory['putMissing']>[0]) => {
            await target.directory.put('API_KEY', 'raced-in-by-the-person');
            return await target.directory.putMissing(entries);
          },
        },
      }) as SecretDirectory;
      const imports = new SecretImportService({
        crypto: crypto_,
        identity: { load: async () => targetIdentity },
        directory: racing,
        clock: kernel(clock),
      });
      const offer = await imports.open();
      const { bundle } = await source.exports.seal(offer.importId, { offer, names: named('API_KEY', 'DB_PASSWORD') });
      clock.ms += 60_000;

      // Act
      const result = await imports.complete(offer.importId, bundle);

      // Assert
      should(result.kept).deepEqual(['API_KEY']);
      should(result.imported).deepEqual(['DB_PASSWORD']);
      const values = await new SecretVault(target.documents, new FakeSecretCipher()).values();
      should(values.get('API_KEY')).equal('raced-in-by-the-person');
      should(values.get('DB_PASSWORD')).equal('correct-horse-battery');
    });

    it('should let only one of two imports of the same previously absent name file it', async () => {
      // Arrange — two sources, two values, two imports into one target at once
      const clock = new Clock();
      const { source, target } = await pair(clock);
      const other = machine(strangerIdentity, clock);
      await other.directory.put('API_KEY', 'the-other-sources-value');
      const first = await target.imports.open();
      const second = await target.imports.open();
      const firstBundle = await source.exports.seal(first.importId, { offer: first, names: named('API_KEY') });
      const secondBundle = await other.exports.seal(second.importId, { offer: second, names: named('API_KEY') });

      // Act
      const results = await Promise.all([
        target.imports.complete(first.importId, firstBundle.bundle),
        target.imports.complete(second.importId, secondBundle.bundle),
      ]);

      // Assert — exactly one filed it, the other kept what the first filed, and the value is the winner's
      const winner = results.findIndex(result => result.imported.length === 1);
      should(results.flatMap(result => result.imported)).deepEqual(['API_KEY']);
      should(results.flatMap(result => result.kept)).deepEqual(['API_KEY']);
      should((await new SecretVault(target.documents, new FakeSecretCipher()).values()).get('API_KEY')).equal(
        [VALUE, 'the-other-sources-value'][winner],
      );
    });
  });

  it('S155 S161 refuse a replayed bundle: an import is accepted once', async () => {
    // Arrange
    const { source, target } = await pair();
    const offer = await target.imports.open();
    const { bundle } = await source.exports.seal(offer.importId, { offer, names: named('API_KEY') });
    await target.imports.complete(offer.importId, bundle);

    // Act
    const replayed = await refusal(target.imports.complete(offer.importId, bundle));

    // Assert
    should(replayed).equal('import_spent');
  });

  it('S155 refuse a tampered bundle, and spend the import on the attempt', async () => {
    // Arrange
    const { source, target } = await pair();
    const offer = await target.imports.open();
    const { bundle } = await source.exports.seal(offer.importId, { offer, names: named('API_KEY') });

    // Act
    const tampered = await refusal(
      target.imports.complete(offer.importId, { ...bundle, ciphertext: flipped(bundle.ciphertext) }),
    );
    const retried = await refusal(target.imports.complete(offer.importId, bundle));

    // Assert — the genuine bundle cannot be retried against the same key after a failed attempt.
    should(tampered).equal('bundle_invalid');
    should(retried).equal('import_spent');
    should(await target.directory.list()).deepEqual([]);
  });

  it('S155 refuse a bundle whose authenticated header was edited', async () => {
    for (const edit of [
      (bundle: SealedSecretBundle) => ({ ...bundle, names: named('DB_PASSWORD') }),
      (bundle: SealedSecretBundle) => ({ ...bundle, sourceDaemonId: strangerIdentity.daemonId }),
      (bundle: SealedSecretBundle) => ({ ...bundle, nonce: flipped(bundle.nonce) }),
      (bundle: SealedSecretBundle) => ({ ...bundle, ephemeralKey: 'short' }),
      (bundle: SealedSecretBundle) => ({ ...bundle, ciphertext: 'not base64url!' }),
    ]) {
      // Arrange
      const { source, target } = await pair();
      const offer = await target.imports.open();
      const { bundle } = await source.exports.seal(offer.importId, { offer, names: named('API_KEY') });

      // Act
      const answer = await refusal(target.imports.complete(offer.importId, edit(bundle) as SealedSecretBundle));

      // Assert
      should(answer).equal('bundle_invalid');
    }
  });

  it('S161 refuse a bundle sealed to another key (the wrong import)', async () => {
    // Arrange
    const { source, target } = await pair();
    const first = await target.imports.open();
    const second = await target.imports.open();
    const { bundle } = await source.exports.seal(first.importId, { offer: first, names: named('API_KEY') });

    // Act — presented for the second import, whose key never sealed it.
    const answer = await refusal(target.imports.complete(second.importId, { ...bundle, importId: second.importId }));
    const forFirst = await refusal(target.imports.complete(second.importId, bundle));

    // Assert
    should(answer).equal('bundle_invalid');
    should(forFirst).equal('import_spent');
  });

  it('S161 refuse a bundle for another machine', async () => {
    // Arrange
    const { source, target, clock } = await pair();
    const elsewhere = machine(strangerIdentity, clock);
    const offer = await elsewhere.imports.open();
    const { bundle } = await source.exports.seal(offer.importId, { offer, names: named('API_KEY') });
    const mine = await target.imports.open();

    // Act
    const answer = await refusal(target.imports.complete(mine.importId, { ...bundle, importId: mine.importId }));

    // Assert
    should(answer).equal('bundle_invalid');
  });

  it('S155 S161 refuse a bundle that arrives after its import expired', async () => {
    // Arrange
    const { source, target, clock } = await pair();
    const offer = await target.imports.open();
    const { bundle } = await source.exports.seal(offer.importId, { offer, names: named('API_KEY') });
    clock.ms += 5 * 60_000;

    // Act
    const answer = await refusal(target.imports.complete(offer.importId, bundle));

    // Assert
    should(answer).equal('offer_expired');
    should(await target.directory.list()).deepEqual([]);
  });

  it('S153 call an import it never opened, or swept after expiry, unknown', async () => {
    // Arrange
    const { source, target, clock } = await pair();
    const offer = await target.imports.open();
    const { bundle } = await source.exports.seal(offer.importId, { offer, names: named('API_KEY') });
    clock.ms += 6 * 60_000;
    await target.imports.open();

    // Act
    const swept = await refusal(target.imports.complete(offer.importId, bundle));
    const never = await refusal(target.imports.complete(`fy_secret_import_${'z'.repeat(22)}`, bundle));

    // Assert
    should(swept).equal('import_unknown');
    should(never).equal('import_unknown');
  });

  it('should keep only the newest imports open', async () => {
    // Arrange
    const { target } = await pair();
    const first = await target.imports.open();
    for (let count = 1; count < MAX_OPEN_SECRET_IMPORTS; count += 1) await target.imports.open();

    // Act
    await target.imports.open();

    // Assert
    should(await refusal(target.imports.complete(first.importId, {} as SealedSecretBundle))).equal('import_unknown');
  });

  it('S154 refuse to copy a machine to itself, at either end', async () => {
    // Arrange
    const { source, clock } = await pair();
    const offer = await source.imports.open();
    const other = machine(strangerIdentity, clock);
    await other.directory.put('API_KEY', VALUE);
    const { bundle } = await other.exports.seal(offer.importId, { offer, names: named('API_KEY') });

    // Act
    const atSource = await refusal(source.exports.seal(offer.importId, { offer, names: named('API_KEY') }));
    const atTarget = await refusal(
      source.imports.complete(offer.importId, { ...bundle, sourceDaemonId: sourceIdentity.daemonId }),
    );

    // Assert
    should(atSource).equal('same_machine');
    should(atTarget).equal('same_machine');
  });

  it('S154 refuse an offer not signed by the machine it names', async () => {
    // Arrange
    const { source, target } = await pair();
    const offer = await target.imports.open();
    const edits: readonly ((genuine: SecretImportOffer) => SecretImportOffer)[] = [
      genuine => ({ ...genuine, signature: flipped(genuine.signature) }),
      genuine => ({ ...genuine, publicKey: flipped(genuine.publicKey) }),
      genuine => ({ ...genuine, daemonId: strangerIdentity.daemonId }),
      genuine => ({ ...genuine, identityKey: toBase64Url(strangerIdentity.publicKeySpki) }),
      genuine => ({ ...genuine, identityKey: 'not base64url!' }),
      genuine => ({ ...genuine, publicKey: 'c2hvcnQ' }),
    ];

    // Act
    const answers = await Promise.all(
      edits.map(edit => refusal(source.exports.seal(offer.importId, { offer: edit(offer), names: named('API_KEY') }))),
    );

    // Assert
    should(answers).deepEqual(edits.map(() => 'offer_invalid'));
  });

  it('should refuse an offer for another import than the path names', async () => {
    // Arrange
    const { source, target } = await pair();
    const offer = await target.imports.open();

    // Act
    const answer = await refusal(
      source.exports.seal(`fy_secret_import_${'z'.repeat(22)}`, { offer, names: named('API_KEY') }),
    );

    // Assert
    should(answer).equal('offer_invalid');
  });

  it('S154 refuse an expired offer, and one claiming a longer life than any import has', async () => {
    // Arrange
    const { source, target, clock } = await pair();
    const offer = await target.imports.open();

    // Act
    clock.ms -= 2 * 60_000;
    const overlong = await refusal(source.exports.seal(offer.importId, { offer, names: named('API_KEY') }));
    clock.ms += 2 * 60_000 + 6 * 60_000;
    const expired = await refusal(source.exports.seal(offer.importId, { offer, names: named('API_KEY') }));

    // Assert
    should(overlong).equal('offer_invalid');
    should(expired).equal('offer_expired');
  });

  it('should refuse to seal a name the source does not hold, naming it', async () => {
    // Arrange
    const { source, target } = await pair();
    const offer = await target.imports.open();

    // Act
    const sealing = source.exports.seal(offer.importId, { offer, names: named('API_KEY', 'MISSING') });

    // Assert
    const error = await sealing.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    should(error).be.instanceOf(UnknownSecretError);
    should((error as UnknownSecretError).names).deepEqual(['MISSING']);
  });

  it('should refuse a peer key no machine could hold', async () => {
    // Arrange — an all-zero X25519 point, signed genuinely, so only the agreement can refuse it.
    const { source, target } = await pair();
    const genuine = await target.imports.open();
    const zero = toBase64Url(new Uint8Array(32));
    const unsigned = { ...genuine, publicKey: zero };
    const offer = await resign(unsigned);

    // Act
    const answer = await refusal(source.exports.seal(offer.importId, { offer, names: named('API_KEY') }));

    // Assert
    should(answer).equal('offer_invalid');
  });

  it('S144 S146 refuse a bundle that carries a sign-in token, even one a careless source sealed', async () => {
    // Arrange — the source is forced past the type that keeps a sign-in out of a bundle.
    const { source, target } = await pair();
    const token = 'MCP_LINEAR_0123456789ABCDEF_ACCESS';
    await source.directory.put(token, VALUE);
    const offer = await target.imports.open();
    const { bundle } = await source.exports.seal(offer.importId, { offer, names: [token] as never });

    // Act
    const answer = await refusal(target.imports.complete(offer.importId, bundle));

    // Assert
    should(answer).equal('bundle_invalid');
    should(await target.directory.list()).deepEqual([]);
  });

  it('should refuse a bundle whose sealed values are not the secrets its header names', async () => {
    // Arrange — a source whose header promises API_KEY but whose sealed entries hold DB_PASSWORD.
    const clock = new Clock();
    const source = machine(
      sourceIdentity,
      clock,
      sealing(() => ({ entries: [['DB_PASSWORD', VALUE]] })),
    );
    const target = machine(targetIdentity, clock);
    await source.directory.put('API_KEY', VALUE);
    const offer = await target.imports.open();
    const { bundle } = await source.exports.seal(offer.importId, { offer, names: named('API_KEY') });

    // Act
    const answer = await refusal(target.imports.complete(offer.importId, bundle));

    // Assert
    should(answer).equal('bundle_invalid');
    should(await target.directory.list()).deepEqual([]);
  });

  it('should refuse a bundle whose sealed plaintext is not JSON', async () => {
    // Arrange
    const clock = new Clock();
    const source = machine(
      sourceIdentity,
      clock,
      sealing(() => 'not json {'),
    );
    const target = machine(targetIdentity, clock);
    await source.directory.put('API_KEY', VALUE);
    const offer = await target.imports.open();
    const { bundle } = await source.exports.seal(offer.importId, { offer, names: named('API_KEY') });

    // Act
    const answer = await refusal(target.imports.complete(offer.importId, bundle));

    // Assert
    should(answer).equal('bundle_invalid');
    should(await target.directory.list()).deepEqual([]);
  });

  it('S150 copy nothing when the target would be past its limit', async () => {
    // Arrange
    const { source, target } = await pair();
    for (let index = 0; index < MAX_SECRETS_PER_DAEMON; index += 1) await target.directory.put(`HELD_${index}`, VALUE);
    await target.directory.remove('HELD_0');
    const offer = await target.imports.open();
    const { bundle } = await source.exports.seal(offer.importId, { offer, names: named('API_KEY', 'DB_PASSWORD') });

    // Act
    const filing = target.imports.complete(offer.importId, bundle);

    // Assert
    const error = await filing.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    should(error).be.instanceOf(SecretStoreError);
    should((error as SecretStoreError).failure).equal('full');
    should((await target.directory.list()).some(secret => secret.name === 'API_KEY')).be.false();
  });

  it('should refuse at either end when the machine cannot read its own identity', async () => {
    // Arrange
    const { source, target, clock } = await pair();
    const offer = await target.imports.open();
    const blind = machine(undefined, clock);

    // Act
    const opening = await refusal(blind.imports.open());
    const sealing = await refusal(blind.exports.seal(offer.importId, { offer, names: named('API_KEY') }));

    // Assert
    should(opening).equal('identity_unavailable');
    should(sealing).equal('identity_unavailable');
    void source;
  });
});

/** Signs an offer with the TARGET's real identity, as a target with a broken key generator would. */
async function resign(unsigned: SecretImportOffer): Promise<SecretImportOffer> {
  const { signature: _drop, ...fields } = unsigned;
  const label = 'ferretry-secret-import-offer-v1';
  const parts = [
    label,
    String(fields.v),
    fields.importId,
    fields.daemonId,
    fields.identityKey,
    fields.publicKey,
    fields.expiresAt,
  ];
  const encoded = parts.map(part => {
    const bytes = new TextEncoder().encode(part);
    const framed = new Uint8Array(4 + bytes.length);
    new DataView(framed.buffer).setUint32(0, bytes.length, false);
    framed.set(bytes, 4);
    return framed;
  });
  const total = encoded.reduce((sum, part) => sum + part.length, 0);
  const message = new Uint8Array(total);
  let offset = 0;
  for (const part of encoded) {
    message.set(part, offset);
    offset += part.length;
  }
  const signature = await crypto_.signEd25519(targetIdentity.privateKey, message);
  return { ...fields, signature: toBase64Url(signature) };
}

describe('what a copy carries and never carries', () => {
  const SIGN_IN = 'MCP_LINEAR_0123456789ABCDEF_ACCESS';

  it('S145 a copy is typed so it cannot hold a sign-in token name: the request, the bundle names and the filing all use that type', async () => {
    // Arrange / Act
    const typed = CloneableSecretNameSchema.safeParse(SIGN_IN);
    const request = SecretCloneNamesSchema.safeParse([SIGN_IN]);
    const bundle = SealedSecretBundleSchema.shape.names.safeParse([SIGN_IN]);
    const filed = SecretImportResultSchema.shape.imported.safeParse([SIGN_IN]);

    // Assert — the name type, the request, the bundle header and the answer all refuse it; a stored key parses
    should(typed.success).equal(false);
    should(request.success).equal(false);
    should(bundle.success).equal(false);
    should(filed.success).equal(false);
    should(CloneableSecretNameSchema.safeParse('API_KEY').success).equal(true);
  });

  it('S146 a bundle carrying a sign-in token name is refused whole and nothing is filed', async () => {
    // Arrange — one allowed key and one sign-in, the source forced past the type that keeps a sign-in out
    const { source, target } = await pair();
    await source.directory.put(SIGN_IN, VALUE);
    const offer = await target.imports.open();
    const { bundle } = await source.exports.seal(offer.importId, { offer, names: ['API_KEY', SIGN_IN] as never });

    // Act
    const answer = await refusal(target.imports.complete(offer.importId, bundle));

    // Assert — bundle_invalid, and not even the allowed key was filed
    should(answer).equal('bundle_invalid');
    should(await target.directory.list()).deepEqual([]);
  });

  it('S148 a copy never writes a key the machine already holds, and no request field can ask otherwise', async () => {
    // Arrange — the target holds API_KEY under its own value; the source holds another
    const clock = new Clock();
    const { source, target } = await pair(clock);
    await target.directory.put('API_KEY', 'fake-value-held-here');
    const before = JSON.stringify(await target.documents.read());
    const offer = await target.imports.open();
    const { bundle } = await source.exports.seal(offer.importId, { offer, names: named('API_KEY') });

    // Act
    const result = await target.imports.complete(offer.importId, bundle);

    // Assert — kept byte for byte; and the complete request admits nothing but the bundle (no replace flag)
    should(result.kept).deepEqual(['API_KEY']);
    should(result.imported).deepEqual([]);
    should(JSON.stringify(await target.documents.read())).equal(before);
    should(SecretImportCompleteRequestSchema.safeParse({ bundle, replace: true }).success).equal(false);
    should(SecretImportCompleteRequestSchema.safeParse({ bundle, mode: 'replace' }).success).equal(false);
  });

  it('S149 a copy compares and returns timestamps and names only: no value or digest rides in the answer', async () => {
    // Arrange
    const clock = new Clock();
    const { source, target } = await pair(clock);
    const offer = await target.imports.open();
    const { bundle } = await source.exports.seal(offer.importId, { offer, names: named('API_KEY') });
    clock.ms += 60_000;

    // Act
    const result = await target.imports.complete(offer.importId, bundle);

    // Assert — only the fields the contract names, an instant for the baseline, and no value or hash-shaped string
    should(Object.keys(result).sort()).deepEqual(['filedAt', 'imported', 'importId', 'kept', 'sourceDaemonId'].sort());
    should(SecretImportResultSchema.safeParse({ ...result, digest: 'a'.repeat(64) }).success).equal(false);
    const text = JSON.stringify(result);
    should(text).not.containEql(VALUE);
    should(/[0-9a-f]{64}/u.test(text)).equal(false);
  });

  it('S152 the filedAt baseline is the instant the entry was created, and none is recorded when the entry was not', async () => {
    // Arrange — the key is created by somebody else just before the filing turn
    const clock = new Clock();
    const { source, target } = await pair(clock);
    clock.ms += 60_000;
    const racing = Object.create(target.directory, {
      putMissing: {
        value: async (entries: Parameters<SecretDirectory['putMissing']>[0]) => {
          await target.directory.put('API_KEY', 'fake-value-raced-in');
          return await target.directory.putMissing(entries);
        },
      },
    }) as SecretDirectory;
    const imports = new SecretImportService({
      crypto: crypto_,
      identity: { load: async () => targetIdentity },
      directory: racing,
      clock: kernel(clock),
    });
    const racingOffer = await imports.open();
    const racingBundle = await source.exports.seal(racingOffer.importId, {
      offer: racingOffer,
      names: named('API_KEY'),
    });

    // Act
    const raced = await imports.complete(racingOffer.importId, racingBundle.bundle);

    // Assert — it was not created at that instant by this copy, so no baseline is claimed
    should(raced.imported).deepEqual([]);
    should(raced.kept).deepEqual(['API_KEY']);
    should(raced.filedAt).be.undefined();
    // And the plain filing records exactly the creation instant
    const plain = machine(targetIdentity, clock);
    const plainOffer = await plain.imports.open();
    const plainBundle = await source.exports.seal(plainOffer.importId, { offer: plainOffer, names: named('API_KEY') });
    const filed = await plain.imports.complete(plainOffer.importId, plainBundle.bundle);
    should((await plain.documents.read())?.entries.API_KEY?.createdAt).equal(filed.filedAt);
  });
});
