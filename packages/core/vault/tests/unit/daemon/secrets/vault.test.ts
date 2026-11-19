import { describe, it } from 'bun:test';
import { MAX_SECRETS_PER_DAEMON } from '../../../../contract/index.ts';
import type { Clock } from '@ferretry/kernel/contract';
import should from 'should';
import { combinedReferences, NO_REFERENCES, secretListView } from '../../../../daemon/lib/secrets/view.ts';
import { NO_REDACTION, SecretRedactor } from '../../../../daemon/lib/secrets/redaction.ts';
import { SecretDirectory, SecretVault } from '../../../../daemon/lib/secrets/vault.ts';
import {
  type SecretDocumentStore,
  type SecretReferenceSource,
  SecretStoreError,
  type SecretVaultDocument,
} from '../../../../daemon/lib/secrets/types.ts';
import { FakeSecretCipher, MemorySecretDocuments } from '../support.ts';

const CLOCK = { now: () => '2026-01-01T00:00:00.000Z' } as unknown as Clock;
const LATER = { now: () => '2026-03-01T00:00:00.000Z' } as unknown as Clock;
const TOKEN = 'sk-live-0123456789';

function directory(documents: SecretDocumentStore = new MemorySecretDocuments(), clock = CLOCK): SecretDirectory {
  return new SecretDirectory(documents, new FakeSecretCipher(), clock);
}

/** A store holding a document written by a cipher this daemon does not implement. */
class ForeignCipherDocuments implements SecretDocumentStore {
  async read(): Promise<SecretVaultDocument> {
    return { format: 1, cipher: 'SOMETHING-ELSE', entries: {} };
  }

  async write(): Promise<void> {
    throw new Error('not written by this fixture');
  }
}

describe('the secret directory', () => {
  it('should report an empty list for a store that has never been written', async () => {
    should(await directory().list()).deepEqual([]);
  });

  it('should list what it holds, sorted by name', async () => {
    // Arrange
    const documents = new MemorySecretDocuments();
    const store = directory(documents);
    await store.put('ZETA', TOKEN);
    await store.put('ALPHA', TOKEN);

    // Act
    const listed = await store.list();

    // Assert
    should(listed.map(secret => secret.name)).deepEqual(['ALPHA', 'ZETA']);
  });

  it('S2 S6 answer a summary carrying no value', async () => {
    // Act
    const summary = await directory().put('TOKEN', TOKEN);

    // Assert — the whole management surface: a name and two instants.
    should(Object.keys(summary).sort()).deepEqual(['createdAt', 'name', 'updatedAt']);
  });

  it('should keep createdAt across a replacement and move updatedAt', async () => {
    // Arrange
    const documents = new MemorySecretDocuments();
    await directory(documents).put('TOKEN', TOKEN);

    // Act — "it has existed since January and was rotated in March" is two facts.
    const replaced = await directory(documents, LATER).put('TOKEN', 'rotated-value');

    // Assert
    should(replaced.createdAt).equal('2026-01-01T00:00:00.000Z');
    should(replaced.updatedAt).equal('2026-03-01T00:00:00.000Z');
  });

  it('should remove a secret and say whether there was one', async () => {
    // Arrange
    const documents = new MemorySecretDocuments();
    const store = directory(documents);
    await store.put('TOKEN', TOKEN);

    // Act / Assert
    should(await store.remove('TOKEN')).be.true();
    should(await store.remove('TOKEN')).be.false();
    should(await store.list()).deepEqual([]);
  });

  it('should refuse a new name once the daemon holds its limit, yet still let one be replaced', async () => {
    // Arrange
    const store = directory();
    for (let index = 0; index < MAX_SECRETS_PER_DAEMON; index += 1) await store.put(`HELD_${index}`, TOKEN);

    // Act
    const refused = await store.put('ONE_TOO_MANY', TOKEN).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    const replaced = await store.put('HELD_0', 'rotated-value');

    // Assert
    should(refused).be.instanceof(SecretStoreError);
    should((refused as SecretStoreError).failure).equal('full');
    should(replaced.name).equal('HELD_0');
    should(await store.list()).have.length(MAX_SECRETS_PER_DAEMON);
  });

  it('should refuse a document written by a cipher it does not open, rather than report it empty', async () => {
    // Arrange / Act / Assert — a person shown "no secrets" over unreadable entries recreates them
    // all on top of a file that is still there.
    await directory(new ForeignCipherDocuments())
      .list()
      .then(
        () => should.fail('', '', 'the foreign cipher should have been refused'),
        (error: unknown) => {
          should(error).be.instanceof(SecretStoreError);
          should((error as SecretStoreError).failure).equal('unreadable');
        },
      );
  });

  it('should let a store failure travel rather than swallowing it', async () => {
    // Arrange
    const failing = new MemorySecretDocuments(new SecretStoreError('key_missing', 'the key is gone'));

    // Act / Assert
    await directory(failing)
      .list()
      .then(
        () => should.fail('', '', 'the damaged store should have refused'),
        (error: unknown) => should((error as SecretStoreError).failure).equal('key_missing'),
      );
  });
});

describe('the vault', () => {
  it('should answer an empty map for a store that has never been written', async () => {
    should([...(await new SecretVault(new MemorySecretDocuments(), new FakeSecretCipher()).values())]).deepEqual([]);
  });

  it('should open what the directory sealed', async () => {
    // Arrange
    const documents = new MemorySecretDocuments();
    await directory(documents).put('TOKEN', TOKEN);

    // Act
    const opened = await new SecretVault(documents, new FakeSecretCipher()).values();

    // Assert
    should(opened.get('TOKEN')).equal(TOKEN);
  });

  it('should refuse a foreign cipher', async () => {
    await new SecretVault(new ForeignCipherDocuments(), new FakeSecretCipher()).values().then(
      () => should.fail('', '', 'the foreign cipher should have been refused'),
      (error: unknown) => should((error as SecretStoreError).failure).equal('unreadable'),
    );
  });
});

describe('the redactor', () => {
  it('should mask a stored value in text and in data', async () => {
    // Arrange
    const documents = new MemorySecretDocuments();
    await directory(documents).put('TOKEN', TOKEN);
    const redactor = new SecretRedactor(new SecretVault(documents, new FakeSecretCipher()));

    // Act / Assert
    should(await redactor.redact(`header ${TOKEN}`)).equal('header [redacted:TOKEN]');
    should(await redactor.redactData({ a: TOKEN })).deepEqual({ a: '[redacted:TOKEN]' });
  });

  it('S19 let a damaged vault refuse, because text it cannot scrub must not be served', async () => {
    // Arrange
    const redactor = new SecretRedactor(
      new SecretVault(
        new MemorySecretDocuments(new SecretStoreError('undecipherable', 'wrong key')),
        new FakeSecretCipher(),
      ),
    );

    // Act / Assert
    await redactor.redact('anything').then(
      () => should.fail('', '', 'a vault that cannot be opened must not pass text through'),
      (error: unknown) => should((error as SecretStoreError).failure).equal('undecipherable'),
    );
  });

  it('should pass everything through when the daemon has no store wired', async () => {
    should(await NO_REDACTION.redact('untouched')).equal('untouched');
    should(await NO_REDACTION.redactData({ a: 1 })).deepEqual({ a: 1 });
    should(await NO_REDACTION.batch(scrub => [scrub.text('untouched'), scrub.data({ a: 1 })])).deepEqual([
      'untouched',
      { a: 1 },
    ]);
  });
});

/** The memory store, counting how often the vault document is read — once per vault open. */
class CountedDocuments extends MemorySecretDocuments {
  reads = 0;

  override async read(): Promise<SecretVaultDocument | undefined> {
    this.reads += 1;
    return await super.read();
  }
}

describe('a batch of redactions', () => {
  it('S20 open the vault ONCE for every string in the batch', async () => {
    // Arrange
    const documents = new CountedDocuments();
    await directory(documents).put('TOKEN', TOKEN);
    const redactor = new SecretRedactor(new SecretVault(documents, new FakeSecretCipher()));
    const opensBefore = documents.reads;
    const page = Array.from({ length: 50 }, (_, index) => `row ${index} ${TOKEN}`);

    // Act
    const scrubbed = await redactor.batch(scrub => [...page.map(text => scrub.text(text)), scrub.data({ a: TOKEN })]);

    // Assert
    should(documents.reads - opensBefore).equal(1);
    should(scrubbed).have.length(51);
    should(scrubbed[0]).equal('row 0 [redacted:TOKEN]');
    should(scrubbed[49]).equal('row 49 [redacted:TOKEN]');
    should(scrubbed[50]).deepEqual({ a: '[redacted:TOKEN]' });
  });

  it('should mask exactly what a redaction per string masks', async () => {
    // Arrange — two values where one contains the other, so the longest-first order is observable.
    const documents = new MemorySecretDocuments();
    await directory(documents).put('TOKEN', TOKEN);
    await directory(documents).put('SHORT', 'sk-live');
    const redactor = new SecretRedactor(new SecretVault(documents, new FakeSecretCipher()));
    const texts = [`a ${TOKEN} b sk-live c`, 'nothing here', ''];

    // Act
    const one = await Promise.all(texts.map(async text => await redactor.redact(text)));
    const batched = await redactor.batch(scrub => texts.map(text => scrub.text(text)));

    // Assert
    should(batched).deepEqual(one);
    should(batched[0]).equal('a [redacted:TOKEN] b [redacted:SHORT] c');
  });

  it('S20 revoke the scrub when the batch ends, so plaintext outlives no call', async () => {
    // Arrange
    const documents = new MemorySecretDocuments();
    await directory(documents).put('TOKEN', TOKEN);
    const redactor = new SecretRedactor(new SecretVault(documents, new FakeSecretCipher()));

    // Act
    const kept = await redactor.batch(scrub => scrub);

    // Assert
    should(() => kept.text(TOKEN)).throw(/after the batch that opened its values ended/u);
    should(() => kept.data({ a: TOKEN })).throw(/after the batch that opened its values ended/u);
  });

  it('should refuse a scrub after an await inside the work, rather than mask with values let go', async () => {
    // Arrange
    const documents = new MemorySecretDocuments();
    await directory(documents).put('TOKEN', TOKEN);
    const redactor = new SecretRedactor(new SecretVault(documents, new FakeSecretCipher()));

    // Act
    const act = redactor.batch(async scrub => {
      await Promise.resolve();
      return scrub.text(TOKEN);
    });

    // Assert
    await should(act).be.rejectedWith(/after the batch that opened its values ended/u);
  });

  it('should refuse before the work runs when the vault cannot be opened', async () => {
    // Arrange
    let ran = false;
    const redactor = new SecretRedactor(
      new SecretVault(
        new MemorySecretDocuments(new SecretStoreError('undecipherable', 'wrong key')),
        new FakeSecretCipher(),
      ),
    );

    // Act
    const act = redactor.batch(scrub => {
      ran = true;
      return scrub.text('anything');
    });

    // Assert
    await should(act).be.rejectedWith(SecretStoreError);
    should(ran).be.false();
  });
});

describe('the management view', () => {
  it('S65 report a ready store with its references resolved', async () => {
    // Arrange
    const documents = new MemorySecretDocuments();
    await directory(documents).put('TOKEN', TOKEN);

    // Act
    const view = await secretListView(directory(documents), {
      references: async () => [
        { name: 'TOKEN', origin: 'config/daemon.json → secretEnvironment.AUTH' },
        { name: 'ABSENT', origin: 'config/daemon.json → secretEnvironment.OTHER' },
      ],
    });

    // Assert
    should(view.health).equal('ready');
    should(view.secrets.map(secret => secret.name)).deepEqual(['TOKEN']);
    should(view.references.map(reference => [reference.name, reference.resolved])).deepEqual([
      ['TOKEN', true],
      ['ABSENT', false],
    ]);
  });

  it('should report NO references when nothing is configured', async () => {
    should((await secretListView(directory(), NO_REFERENCES)).references).deepEqual([]);
  });

  it('S141 report a damaged store as damaged, never as empty', async () => {
    // Arrange
    const failing = new MemorySecretDocuments(new SecretStoreError('key_missing', 'gone'));

    // Act
    const view = await secretListView(directory(failing), {
      references: async () => [{ name: 'TOKEN', origin: 'config/daemon.json → secretEnvironment.AUTH' }],
    });

    // Assert — the list is empty AND the health says why, so a UI cannot render "no secrets".
    should(view.health).equal('damaged');
    should(view.diagnosis).match(/key/u);
    should(view.references[0]?.resolved).be.false();
  });

  it('should diagnose each way a store can be damaged in terms an operator can act on', async () => {
    // Arrange
    const cases: readonly [SecretStoreError['failure'], RegExp][] = [
      ['key_missing', /restore the key file/u],
      ['undecipherable', /does not open/u],
      ['full', /full/u],
      ['unreadable', /could not be read/u],
    ];

    // Act / Assert
    for (const [failure, expected] of cases) {
      const view = await secretListView(
        directory(new MemorySecretDocuments(new SecretStoreError(failure, 'raised'))),
        NO_REFERENCES,
      );
      should(view.diagnosis).match(expected);
    }
  });

  it('should let a failure that is not a store failure through, so a real bug is still a bug', async () => {
    // Arrange
    class Broken implements SecretDocumentStore {
      async read(): Promise<SecretVaultDocument | undefined> {
        throw new TypeError('a genuine defect');
      }

      async write(): Promise<void> {
        throw new TypeError('a genuine defect');
      }
    }

    // Act / Assert
    await secretListView(directory(new Broken()), NO_REFERENCES).then(
      () => should.fail('', '', 'a TypeError must not be reported as a damaged store'),
      (error: unknown) => should(error).be.instanceof(TypeError),
    );
  });
});

/**
 * A daemon has more than one place that names secrets now: the operator's own recipes, and the fleet
 * accounts a profile authenticates. The listing must show all of them, because a person deciding
 * whether a secret is still wanted is reading exactly this.
 */
describe('several places that name secrets, as one source', () => {
  const source = (...references: readonly { name: string; origin: string }[]): SecretReferenceSource => ({
    references: async () => references,
  });

  it('should concatenate every source in order', async () => {
    // Act
    const actual = await combinedReferences(
      source({ name: 'RECIPE_KEY', origin: 'config/daemon.json → secretEnvironment.AUTH' }),
      source({ name: 'WORK_KEY', origin: 'fleet account claude-kirin → ANTHROPIC_API_KEY' }),
    ).references();

    // Assert
    should(actual.map(reference => reference.name)).deepEqual(['RECIPE_KEY', 'WORK_KEY']);
  });

  it('should keep one secret named twice as two facts, because deleting it breaks both', async () => {
    // Act
    const actual = await combinedReferences(
      source({ name: 'WORK_KEY', origin: 'fleet account claude-kirin → ANTHROPIC_API_KEY' }),
      source({ name: 'WORK_KEY', origin: 'fleet account claude-hadi → ANTHROPIC_API_KEY' }),
    ).references();

    // Assert
    should(actual).have.length(2);
  });

  it('should answer nothing when it is given nothing', async () => {
    // Act & Assert
    should(await combinedReferences().references()).deepEqual([]);
  });

  it('should let a source that cannot answer take the read down with it', async () => {
    // Arrange — a half-read list shows a complete-looking screen with somebody's account missing.
    const broken: SecretReferenceSource = {
      references: async () => {
        throw new Error('fleet config at /state/fleet/config.yaml is unreadable');
      },
    };

    // Act
    const raised = await combinedReferences(source({ name: 'A', origin: 'x' }), broken)
      .references()
      .catch((error: unknown) => error);

    // Assert
    should((raised as Error).message).match(/config\.yaml/u);
  });
});

describe('SecretDirectory, changes taking turns', () => {
  it('should keep both of two puts made at once, never let the second drop the first', async () => {
    // Arrange
    const secrets = directory();

    // Act
    await Promise.all([secrets.put('FIRST', TOKEN), secrets.put('SECOND', TOKEN), secrets.remove('NONE')]);

    // Assert
    should((await secrets.list()).map(summary => summary.name)).deepEqual(['FIRST', 'SECOND']);
  });

  it('should store only while the name is as the caller saw it, and say what it found otherwise', async () => {
    // Arrange
    const secrets = directory();
    await secrets.put('HELD', TOKEN);

    // Act
    const outcomes = [
      await secrets.putIf('NEW', TOKEN, false),
      await secrets.putIf('NEW', TOKEN, false),
      await secrets.putIf('HELD', TOKEN, true),
      await secrets.putIf('GONE', TOKEN, true),
    ];

    // Assert
    should(outcomes).deepEqual(['stored', 'changed', 'stored', 'changed']);
    should((await secrets.list()).map(summary => summary.name)).deepEqual(['HELD', 'NEW']);
  });

  it('should let only one of two pastes into one new name store it', async () => {
    // Arrange
    const secrets = directory();

    // Act
    const outcomes = await Promise.all([secrets.putIf('NEW', 'first', false), secrets.putIf('NEW', 'second', false)]);

    // Assert
    should(outcomes).deepEqual(['stored', 'changed']);
  });

  describe('storing only the names that are missing', () => {
    it('S36 S150 store the missing names and leave a held one exactly as it was, timestamps included', async () => {
      // Arrange
      const documents = new MemorySecretDocuments();
      const secrets = directory(documents);
      await secrets.put('HELD', 'held-value');
      const held = (await documents.read())?.entries.HELD;
      const later = directory(documents, LATER);

      // Act
      const answer = await later.putMissing([
        ['HELD', 'a-different-value'],
        ['NEW', 'new-value'],
      ]);

      // Assert
      should(answer).deepEqual({ at: LATER.now(), stored: ['NEW'], kept: ['HELD'] });
      const document = await documents.read();
      should(document?.entries.HELD).deepEqual(held);
      should(document?.entries.NEW).containDeep({ createdAt: LATER.now(), updatedAt: LATER.now() });
      should((await new SecretVault(documents, new FakeSecretCipher()).values()).get('NEW')).equal('new-value');
    });

    it('should write nothing at all when every name is held', async () => {
      // Arrange
      const documents = new MemorySecretDocuments();
      const secrets = directory(documents);
      await secrets.put('HELD', 'held-value');
      const before = JSON.stringify(await documents.read());

      // Act
      const answer = await secrets.putMissing([['HELD', 'a-different-value']]);

      // Assert
      should(answer.stored).deepEqual([]);
      should(answer.kept).deepEqual(['HELD']);
      should(JSON.stringify(await documents.read())).equal(before);
    });

    it('should store a name given twice once, with its first value', async () => {
      // Arrange
      const documents = new MemorySecretDocuments();
      const secrets = directory(documents);

      // Act
      const answer = await secrets.putMissing([
        ['TWICE', 'first'],
        ['TWICE', 'second'],
      ]);

      // Assert
      should(answer.stored).deepEqual(['TWICE']);
      should((await new SecretVault(documents, new FakeSecretCipher()).values()).get('TWICE')).equal('first');
    });

    it('should keep a name written in the turn before it, even when that write was started after the call', async () => {
      // Arrange
      const secrets = directory();

      // Act — the paste is queued first; the batch checks the store only when its own turn comes
      const [stored, batch] = await Promise.all([
        secrets.put('RACED', 'the-persons-value'),
        secrets.putMissing([['RACED', 'copied-value']]),
      ]);

      // Assert
      should(stored.name).equal('RACED');
      should(batch.kept).deepEqual(['RACED']);
      should(batch.stored).deepEqual([]);
    });

    it('S150 refuse the whole batch, writing nothing, when the missing names would pass the limit', async () => {
      // Arrange
      const documents = new MemorySecretDocuments();
      const full = directory(documents);
      for (let index = 0; index < MAX_SECRETS_PER_DAEMON - 1; index += 1) await full.put(`K${String(index)}`, TOKEN);
      const before = JSON.stringify(await documents.read());

      // Act
      const refused = await full
        .putMissing([
          ['K0', 'held already'],
          ['ONE', TOKEN],
          ['TWO', TOKEN],
        ])
        .catch((error: unknown) => error);

      // Assert
      should(refused).be.instanceOf(SecretStoreError);
      should(JSON.stringify(await documents.read())).equal(before);
    });
  });

  it('should refuse before writing when the store is full or cannot be read, and run the next change after a failure', async () => {
    // Arrange
    const full = directory();
    for (let index = 0; index < MAX_SECRETS_PER_DAEMON; index += 1) await full.put(`K${String(index)}`, TOKEN);
    const unreadable = directory(new MemorySecretDocuments(new SecretStoreError('unreadable', 'damaged')));

    // Act
    const failed = await unreadable.put('X', TOKEN).catch((error: unknown) => error);
    const outcomes = [await full.putIf('ONE_MORE', TOKEN, false), await unreadable.putIf('X', TOKEN, false)];

    // Assert
    should(failed).be.instanceOf(SecretStoreError);
    should(outcomes).deepEqual(['full', 'unreadable']);
  });
});

describe('the identity of a write, and one entry opened alone', () => {
  /** Seals with a fresh nonce each time, as the real cipher does: a replacement is a different write. */
  class NonceCipher extends FakeSecretCipher {
    #seals = 0;

    override async seal(
      _name: string,
      plaintext: string,
    ): Promise<{ readonly iv: string; readonly ciphertext: string }> {
      this.#seals += 1;
      return { iv: `nonce-${String(this.#seals)}`, ciphertext: [...plaintext].reverse().join('') };
    }

    override async openAll(
      entries: Readonly<Record<string, { readonly iv: string; readonly ciphertext: string }>>,
    ): Promise<ReadonlyMap<string, string>> {
      return new Map(
        Object.entries(entries).map(([name, sealed]) => [name, [...sealed.ciphertext].reverse().join('')]),
      );
    }
  }

  const world = () => {
    const documents = new MemorySecretDocuments();
    const cipher = new NonceCipher();
    return {
      documents,
      store: new SecretDirectory(documents, cipher, CLOCK),
      vault: new SecretVault(documents, cipher),
    };
  };

  it('should answer the identity of the write it just made, and that same identity afterwards', async () => {
    const { store } = world();
    const first = await store.putIdentified('TOKEN', TOKEN);
    should(await store.writeIdentity('TOKEN')).equal(first);
    const second = await store.putIdentified('TOKEN', 'another-value-0123');
    should(second).not.equal(first);
    should(await store.writeIdentity('TOKEN')).equal(second);
  });

  it('should answer no identity for a name that holds nothing', async () => {
    const { store } = world();
    should(await store.writeIdentity('MISSING')).equal(undefined);
    await store.put('OTHER', TOKEN);
    should(await store.writeIdentity('MISSING')).equal(undefined);
  });

  it('should open one entry with the identity of that very write, and nothing else', async () => {
    const { store, vault } = world();
    const identity = await store.putIdentified('TOKEN', TOKEN);
    await store.put('OTHER', 'other-value-0123');
    should(await vault.openEntry('TOKEN')).deepEqual({ write: identity, value: TOKEN });
  });

  it('should answer nothing for a name that is not held, or for a store never written', async () => {
    const { store, vault } = world();
    should(await vault.openEntry('TOKEN')).equal(undefined);
    await store.put('OTHER', TOKEN);
    should(await vault.openEntry('TOKEN')).equal(undefined);
  });

  it('should refuse to open an entry of a document written by a cipher it does not open', async () => {
    const refused = await new SecretVault(new ForeignCipherDocuments(), new FakeSecretCipher())
      .openEntry('TOKEN')
      .catch((error: unknown) => error);
    should(refused).be.instanceOf(SecretStoreError);
  });
});

describe('the create-only write (putNewIdentified)', () => {
  it('should store a name the store does not hold and answer the identity of that write', async () => {
    const documents = new MemorySecretDocuments();
    const store = directory(documents);
    const answer = await store.putNewIdentified('ANTHROPIC_API_KEY', TOKEN);
    should(answer.kind).equal('stored');
    should(await store.writeIdentity('ANTHROPIC_API_KEY')).equal(answer.kind === 'stored' ? answer.write : undefined);
    should((await store.list()).map(secret => secret.name)).deepEqual(['ANTHROPIC_API_KEY']);
  });

  it('should refuse a held name and leave its value, createdAt, updatedAt and write identity exactly as they were', async () => {
    const documents = new MemorySecretDocuments();
    const first = directory(documents, CLOCK);
    const held = await first.putIdentified('ANTHROPIC_API_KEY', TOKEN);
    const before = await first.list();
    const answer = await directory(documents, LATER).putNewIdentified('ANTHROPIC_API_KEY', 'another-value-0123');
    should(answer).deepEqual({ kind: 'exists' });
    should(await first.list()).deepEqual(before);
    should(await first.writeIdentity('ANTHROPIC_API_KEY')).equal(held);
    // The ciphertext in the document is the first value's, not the second's.
    const vault = new SecretVault(documents, new FakeSecretCipher());
    should((await vault.values()).get('ANTHROPIC_API_KEY')).equal(TOKEN);
  });

  it('should let exactly one of two racing creators win, and keep the winner', async () => {
    const store = directory();
    const answers = await Promise.all([
      store.putNewIdentified('RACED', 'first-value-0123'),
      store.putNewIdentified('RACED', 'second-value-0123'),
    ]);
    should(answers.map(answer => answer.kind).sort()).deepEqual(['exists', 'stored']);
    const vault = new SecretVault((store as unknown as { store: SecretDocumentStore }).store, new FakeSecretCipher());
    should((await vault.values()).get('RACED')).equal('first-value-0123');
  });

  it('should refuse past the limit with the store full, writing nothing', async () => {
    const store = directory();
    for (let index = 0; index < MAX_SECRETS_PER_DAEMON; index += 1) await store.put(`KEY_${String(index)}`, TOKEN);
    let raised: unknown;
    try {
      await store.putNewIdentified('ONE_TOO_MANY', TOKEN);
    } catch (error) {
      raised = error;
    }
    should(raised).be.instanceOf(SecretStoreError);
    should(await store.list()).have.length(MAX_SECRETS_PER_DAEMON);
  });
});
