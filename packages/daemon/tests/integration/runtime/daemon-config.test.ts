import { describe, it } from 'bun:test';
import { FY_DEFAULT_DAEMON_URL } from '@ferretry/protocol';
import should from 'should';
import { FileDaemonConfig } from '../../../src/adapters/runtime/daemon-config.ts';
import type { FileSystemPort, FoundationPaths } from '../../../src/lib/index.ts';

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
