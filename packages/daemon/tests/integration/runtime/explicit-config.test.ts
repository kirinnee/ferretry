import { afterEach, describe, it } from 'bun:test';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import should from 'should';
import { ExplicitDaemonConfig } from '../../../src/adapters/runtime/explicit-config.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

describe('ExplicitDaemonConfig', () => {
  afterEach(async () => await cleanupTempDirectories());

  it('should read a document an operator named outside any state home', async () => {
    // Arrange: the whole reason this adapter exists — the state home's filesystem port refuses every
    // path outside the home, which is right for the daemon's own state and wrong for `--config`.
    const directory = await tempDirectory('fyd-explicit');
    const path = join(directory, 'daemon.json');
    await writeFile(path, JSON.stringify({ host: '0.0.0.0', port: 9_100 }));

    // Act
    const peeked = await new ExplicitDaemonConfig(path).peek();

    // Assert
    should(peeked.document).deepEqual({ host: '0.0.0.0', port: 9_100 });
    should(peeked.config.bindUrl).equal('http://0.0.0.0:9100');
    should(peeked.config.portIsRecorded).be.true();
  });

  it('should treat an absent document as one that is not written yet, without creating it', async () => {
    // Arrange
    const directory = await tempDirectory('fyd-explicit-absent');
    const path = join(directory, 'nothing-here.json');

    // Act
    const peeked = await new ExplicitDaemonConfig(path).peek();

    // Assert — a question must never provision. The operator names where the file SHOULD live.
    should(peeked.document).be.undefined();
    should(peeked.config.portIsRecorded).be.false();
    await should(stat(path)).be.rejected();
  });

  it('should record a settled port into the bind carrier rather than the key it supersedes', async () => {
    // Arrange: the same document an operator mid-migration hands to `--config`.
    const directory = await tempDirectory('fyd-explicit-carriers');
    const path = join(directory, 'daemon.json');
    await writeFile(path, JSON.stringify({ port: 7_431, carriers: [{ kind: 'bind', host: 'box.lan' }] }));
    const store = new ExplicitDaemonConfig(path);

    // Act
    await store.record(9_800);
    const recorded = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    const reloaded = await store.load();

    // Assert — both adapters answer this the same way, because an operator moving between the state
    // home and their own file must not find the port landing in a different key.
    should(recorded).have.property('carriers', [{ kind: 'bind', host: 'box.lan', port: 9_800 }]);
    should(recorded).have.property('port', 7_431);
    // What goes back is what came off, plus that one value. A `host` this daemon wrote itself would
    // be read on the next boot as a key the operator typed and then be reported as superseded.
    should(Object.keys(recorded)).deepEqual(['port', 'carriers']);
    should(recorded).not.have.property('host');
    should(reloaded.carrierSet.bind).deepEqual({ kind: 'bind', host: 'box.lan', port: 9_800 });
    should(reloaded.bindUrl).equal('http://box.lan:9800');
  });

  it('should refuse to record over a document it could not read as a configuration', async () => {
    // Writing the raw document plus one key must not become a way to persist a shape this daemon
    // would refuse to boot on: the parse boundary stays exactly where it was.
    // Arrange
    const directory = await tempDirectory('fyd-explicit-refuse');
    const path = join(directory, 'daemon.json');
    await writeFile(path, JSON.stringify({ port: 'not a number' }));
    const store = new ExplicitDaemonConfig(path);

    // Act
    const raised = await store
      .record(9_900)
      .then(() => undefined)
      .catch((error: unknown) => error);

    // Assert
    should(raised).not.be.undefined();
    should(JSON.parse(await readFile(path, 'utf8'))).deepEqual({ port: 'not a number' });
  });

  it('should seed and record privately, and never persist a derived address', async () => {
    // Arrange
    const directory = await tempDirectory('fyd-explicit-write');
    const path = join(directory, 'daemon.json');
    const store = new ExplicitDaemonConfig(path);

    // Act
    await store.load();
    const seeded = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    await store.record(9_200);
    const recorded = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    const information = await stat(path);

    // Assert
    should(seeded).not.have.property('publicUrl');
    should(seeded).not.have.property('port');
    should(recorded).have.property('port', 9_200);
    should(recorded).not.have.property('publicUrl');
    // Recording adds the settled port and nothing else — the seeded defaults an operator can see and
    // edit are theirs from the moment they are written, and a record must not re-author them.
    should(Object.keys(recorded)).deepEqual([...Object.keys(seeded), 'port']);
    // A daemon configuration can name a secrets file and the address a machine is administered on.
    should(information.mode & 0o077).equal(0);
  });
});
