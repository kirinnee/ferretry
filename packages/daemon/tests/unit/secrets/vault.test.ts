import { describe, it } from 'bun:test';
import should from 'should';
import {
  NO_REDACTION,
  combinedReferences,
  NO_REFERENCES,
  type SecretReferenceSource,
  SecretDirectory,
  SecretRedactor,
  SecretStoreError,
  SecretVault,
  secretListView,
  type SecretDocumentStore,
  type SecretVaultDocument,
} from '../../../src/lib/secrets/index.ts';
import { FakeSecretCipher, MemorySecretDocuments } from '../runtime/mounts/support.ts';

const CLOCK = { now: () => '2026-01-01T00:00:00.000Z' };
const LATER = { now: () => '2026-03-01T00:00:00.000Z' };
const TOKEN = 'sk-live-0123456789';

function directory(documents: SecretDocumentStore = new MemorySecretDocuments(), clock = CLOCK): SecretDirectory {
  return new SecretDirectory(documents, new FakeSecretCipher(), clock);
}

/** A store holding a document written by a cipher this daemon does not implement. */
class ForeignCipherDocuments implements SecretDocumentStore {
  async read(): Promise<SecretVaultDocument> {
    return { v: 1, cipher: 'SOMETHING-ELSE', entries: {} };
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

  it('should answer a summary carrying no value', async () => {
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

  it('should let a damaged vault refuse, because text it cannot scrub must not be served', async () => {
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
  it('should open the vault ONCE for every string in the batch', async () => {
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

  it('should revoke the scrub when the batch ends, so plaintext outlives no call', async () => {
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
  it('should report a ready store with its references resolved', async () => {
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

  it('should report a damaged store as damaged, never as empty', async () => {
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
