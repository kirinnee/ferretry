import { describe, it } from 'bun:test';
import { FY_DEFAULT_DAEMON_URL } from '@ferretry/protocol';
import should from 'should';
import { DaemonConfigDocumentError, FileDaemonConfig } from '../../../src/adapters/runtime/daemon-config.ts';
import {
  DEFAULT_CAPABILITY_GRANTS,
  type FileSystemPort,
  type FoundationPaths,
  supersededCarrierKeys,
} from '../../../src/lib/index.ts';

const paths = { daemonConfig: '/state/config/daemon.json' } as FoundationPaths;

/** One in-memory document, so what actually reaches the disk is what the assertions read. */
function documentStore(initial?: string): {
  readonly store: FileDaemonConfig;
  text: () => string | undefined;
  set: (next: string) => void;
} {
  let text = initial;
  const files = {
    readText: async () => text,
    writeTextAtomic: async (_path: string, next: string) => {
      text = next;
    },
  } as Pick<FileSystemPort, 'readText' | 'writeTextAtomic'> as FileSystemPort;
  return {
    store: new FileDaemonConfig(paths, files),
    text: () => text,
    set: (next: string) => {
      text = next;
    },
  };
}

describe('FileDaemonConfig', () => {
  it('should persist private defaults once and reload an explicit configuration', async () => {
    // Arrange
    const documents = documentStore();

    // Act
    const created = await documents.store.load();
    documents.set(JSON.stringify({ host: 'localhost', port: 8_123 }));
    const loaded = await documents.store.load();

    // Assert
    should(created.publicUrl).equal(FY_DEFAULT_DAEMON_URL);
    should(loaded.publicUrl).equal('http://localhost:8123');
    should(loaded.bindUrl).equal('http://localhost:8123');
  });

  it('should never seed a derived address into the document an operator edits', async () => {
    // Arrange
    const documents = documentStore();

    // Act
    await documents.store.load();
    const seeded = JSON.parse(documents.text() ?? '{}') as Record<string, unknown>;

    // Assert — the defect this closes: the derived public URL was written back as though an operator
    // had chosen it, so it stopped tracking `port` and editing the port appeared to do nothing.
    should(seeded).not.have.property('publicUrl');
    should(seeded).not.have.property('bindUrl');
    should(seeded).not.have.property('port');
    // What IS seeded is still a usable document: defaults an operator can see and change.
    should(seeded).have.property('host', '127.0.0.1');
  });

  it('should record the address this daemon took and leave every other field alone', async () => {
    // Arrange: an operator has already set things in this document.
    const documents = documentStore(
      JSON.stringify({ host: '127.0.0.1', healthIntervalSeconds: 90, projectRoots: ['~/Code'] }),
    );

    // Act
    await documents.store.record(7_432);
    const recorded = await documents.store.load();
    const written = JSON.parse(documents.text() ?? '{}') as Record<string, unknown>;

    // Assert — recording is what makes choosing safe: the next boot binds exactly this or refuses.
    should(written).have.property('port', 7_432);
    should(recorded.portIsRecorded).be.true();
    should(recorded.bindUrl).equal('http://127.0.0.1:7432');
    // Exactly one key is written; the operator's own settings survive untouched.
    should(written).have.property('healthIntervalSeconds', 90);
    should(written).have.property('projectRoots', ['~/Code']);
    // And still nothing derived, so a recorded port cannot freeze an advertisement beside it.
    should(written).not.have.property('publicUrl');
    // EXACTLY ONE KEY, literally: the document that goes back to disk is the one that came off it,
    // plus `port`. A write that also planted every schema default would put values into a file the
    // operator never typed, which is the only evidence anything downstream has of what they chose.
    should(Object.keys(written)).deepEqual(['host', 'healthIntervalSeconds', 'projectRoots', 'port']);
  });

  it('should record a settled port into the bind carrier rather than the key it supersedes', async () => {
    // Arrange: an operator who has moved their bind into `carriers` and left the old key in place.
    const documents = documentStore(
      JSON.stringify({
        port: 7_431,
        carriers: [
          { kind: 'bind', host: 'box.lan' },
          { kind: 'relay', source: 'discovery' },
        ],
      }),
    );

    // Act
    await documents.store.record(7_432);
    const written = JSON.parse(documents.text() ?? '{}') as Record<string, unknown>;
    const reloaded = await documents.store.load();

    // Assert — writing `port` here would write a key with no effect on where this daemon listens,
    // which is the defect the carrier list exists to remove rather than reproduce.
    should(written).have.property('carriers', [
      // The operator's own relay entry comes back exactly as they wrote it. A write that filled in
      // `enabled` and `reconnectSeconds` would be this daemon typing lines into their file and then
      // reading them back as their decisions.
      { kind: 'bind', host: 'box.lan', port: 7_432 },
      { kind: 'relay', source: 'discovery' },
    ]);
    should(written).have.property('port', 7_431);
    should(Object.keys(written)).deepEqual(['port', 'carriers']);
    should(reloaded.bindUrl).equal('http://box.lan:7432');
    should(reloaded.carrierSet.bind).deepEqual({ kind: 'bind', host: 'box.lan', port: 7_432 });
  });

  it('should never accuse an operator of a legacy key that this daemon wrote itself', async () => {
    // THE ROUND TRIP IS THE TEST. `supersededCarrierKeys` reads key PRESENCE in the raw document, so
    // a `record()` that wrote schema defaults planted a `host` the operator never typed — and every
    // boot afterwards told them to go and delete a line that is not in their file.
    // Arrange
    const documents = documentStore(JSON.stringify({ carriers: [{ kind: 'bind', host: 'box.lan' }] }));

    // Act
    await documents.store.record(7_432);
    const settled = await documents.store.peek();

    // Assert
    should(settled.document).deepEqual({ carriers: [{ kind: 'bind', host: 'box.lan', port: 7_432 }] });
    should(supersededCarrierKeys({ rawDocument: settled.document ?? {}, carriers: settled.config.carriers })).deepEqual(
      [],
    );
  });

  it('should answer what is on disk without writing anything', async () => {
    // Arrange
    const fresh = documentStore();
    const written = documentStore(JSON.stringify({ host: '127.0.0.1', port: 7_432 }));

    // Act
    const nothingYet = await fresh.store.peek();
    const existing = await written.store.peek();

    // Assert — `--print-config` and `--check` read through this, and a question must never provision:
    // creating a state home as a side effect of asking is the `--version` defect all over again.
    should(nothingYet.document).be.undefined();
    should(fresh.text()).be.undefined();
    should(nothingYet.config.portIsRecorded).be.false();
    // The RAW document comes back beside the parsed one because provenance needs it: whether a value
    // was written down or defaulted is exactly the question, and the parsed form has lost it.
    should(existing.document).deepEqual({ host: '127.0.0.1', port: 7_432 });
    should(existing.config.bindUrl).equal('http://127.0.0.1:7432');
    // The document is named rather than described, so a refusal can point at the file to edit.
    should(fresh.store.path).equal(paths.daemonConfig);
  });

  it('should record into a state home whose document has not been written yet', async () => {
    // Arrange: the boot decides its address before anything else writes the document.
    const documents = documentStore();

    // Act
    await documents.store.record(7_433);

    // Assert
    should(JSON.parse(documents.text() ?? '{}')).have.property('port', 7_433);
  });
});

describe('a configuration document this daemon will not act on', () => {
  it('should name the FILE in every refusal rather than dumping a validation error', async () => {
    // Refusing is only half the contract. This already stopped the daemon — the schema is strict and
    // nothing falls back — but what reached the operator was a raw dump with no path in it, which is
    // the "non-zero exit that explains nothing" this package already corrected for occupied
    // addresses. The cause travels underneath, because the field name in it is the actual answer.
    // Arrange
    const unknownKey = documentStore(JSON.stringify({ grants: { kubernetes: { use: true } } }));
    const brokenJson = documentStore('{ not json');

    // Act
    const peeked = await unknownKey.store.peek().catch((error: unknown) => error);
    const loaded = await unknownKey.store.load().catch((error: unknown) => error);
    const grants = await unknownKey.store.readGrants().catch((error: unknown) => error);
    const written = await brokenJson.store.writtenGrants().catch((error: unknown) => error);
    const recorded = await brokenJson.store.record(7_431).catch((error: unknown) => error);

    // Assert — one sentence, one file, wherever the mistake is met.
    for (const raised of [peeked, loaded, grants, written, recorded]) {
      should(raised).be.instanceof(DaemonConfigDocumentError);
      should((raised as Error).message).match(/\/state\/config\/daemon\.json could not be read/u);
    }
    should((peeked as DaemonConfigDocumentError).cause).not.be.undefined();
  });

  it('should refuse to write grants over a document it could not read', async () => {
    // Rewriting a document this daemon does not understand would discard whatever the operator
    // actually wrote there — including the very field that is wrong, which is the one they need.
    // Arrange
    const documents = documentStore(JSON.stringify({ port: 'not a number' }));

    // Act
    const raised = await documents.store
      .writeGrants(DEFAULT_CAPABILITY_GRANTS)
      .then(() => undefined)
      .catch((error: unknown) => error);

    // Assert
    should(raised).be.instanceof(DaemonConfigDocumentError);
    should(documents.text()).equal(JSON.stringify({ port: 'not a number' }));
  });
});
