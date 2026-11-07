import { describe, it } from 'bun:test';
import type { StatePort } from '@ferretry/kernel/contract';
import { MemoryStateFolder, SimulatedCrash } from '@ferretry/kernel/testing';
import should from 'should';
import { TransferBriefFiles } from '../../../../contract/transfer-state.ts';
import { FileSessionTransferBriefWriter } from '../../../../daemon/adapters/transfer/brief-writer.ts';

const TARGET = 'target-session';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

interface Harness {
  readonly folder: MemoryStateFolder;
  readonly state: StatePort;
  /** Every read and write the writer made through the port, in order. */
  readonly calls: string[];
  readonly subject: FileSessionTransferBriefWriter;
}

/** A writer over a memory state folder; the port is wrapped so the ORDER of what the writer asked of it is observable. */
function harness(
  folder = new MemoryStateFolder(),
  onWrite: (bytes: unknown) => Promise<void> | void = () => undefined,
): Harness {
  const real = folder.port([TransferBriefFiles]);
  const calls: string[] = [];
  const state: StatePort = {
    ...real,
    read: async (file, name) => {
      calls.push('read');
      return await real.read(file, name);
    },
    write: async (file, value, name) => {
      calls.push('write');
      await real.write(file, value, name);
      await onWrite(value);
    },
  };
  return { folder, state, calls, subject: new FileSessionTransferBriefWriter(state) };
}

async function reject(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject, but it resolved');
}

const stored = (folder: MemoryStateFolder, id = TARGET): string | undefined => {
  const bytes = folder.rawBytes(TransferBriefFiles, id);
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
};

describe('FileSessionTransferBriefWriter', () => {
  it("writes turn one under only the explicit target key, at the declared file's own path", async () => {
    const { folder, subject } = harness();
    const document = '# Frozen transfer brief\n';

    const file = await subject.write(TARGET, document);

    should(file).equal(subject.file(TARGET));
    should(file).endWith(`${TARGET}/turns/turn-001.md`);
    should(stored(folder)).equal(document);
    should(await folder.port([TransferBriefFiles]).list(TransferBriefFiles)).deepEqual([TARGET]);
    // Private, as the declaration says; the port writes it atomically and flushes it.
    should(TransferBriefFiles.mode).equal(0o600);
    should(TransferBriefFiles.store).equal('opaque');
  });

  it('is idempotent when replay supplies the same deterministic bytes', async () => {
    const { folder, subject } = harness();
    const document = '# Same persisted plan\n';
    const file = await subject.write(TARGET, document);

    const replayed = await subject.write(TARGET, document);

    should(replayed).equal(file);
    should(stored(folder)).equal(document);
  });

  it('replaces a torn partial brief', async () => {
    const { folder, subject } = harness();
    folder.plantBytes(TransferBriefFiles, encode('# Frozen transfer'), TARGET);

    await subject.write(TARGET, '# Frozen transfer brief\n\nComplete.\n');

    should(stored(folder)).equal('# Frozen transfer brief\n\nComplete.\n');
  });

  it('publishes through the port, then confirms the name holds what it published', async () => {
    // The receipt advances to `imported` the moment this returns, so the ORDER is the guarantee: the
    // first read finds nothing to vouch for, the port writes (atomically, flushed), and only then is the
    // name read back and found to hold the document.
    const { calls, subject } = harness();

    await subject.write(TARGET, '# Ordered publication\n');

    should(calls).deepEqual(['read', 'write', 'read']);
  });

  it('re-establishes durability on a matching replay by writing the proved bytes through the port again', async () => {
    // A replay that reads the same bytes back has proved only that they are VISIBLE, which is exactly
    // what a page cache offers a moment before power is cut. The port is the only thing that can make a
    // name durable, so the proved bytes go through it again before the replay is vouched for.
    const folder = new MemoryStateFolder();
    const document = '# Same persisted plan\n';
    await harness(folder).subject.write(TARGET, document);
    const replay = harness(folder);

    const file = await replay.subject.write(TARGET, document);

    should(file).equal(replay.subject.file(TARGET));
    // prove (read), republish the proved bytes (write), confirm the name (read).
    should(replay.calls).deepEqual(['read', 'write', 'read']);
    should(stored(folder)).equal(document);
  });

  it('proves an already-imported brief read-only, writing and repairing nothing', async () => {
    // The fork's pre-launch check must REFUSE drift rather than repair it, so it may not write at all.
    const folder = new MemoryStateFolder();
    const { calls, subject } = harness(folder);

    // Act + Assert — nothing written yet, then the exact document, then a drifted one.
    should(await subject.matches(TARGET, '# Frozen transfer brief\n')).be.false();
    await harness(folder).subject.write(TARGET, '# Frozen transfer brief\n');
    calls.length = 0;
    should(await subject.matches(TARGET, '# Frozen transfer brief\n')).be.true();
    should(await subject.matches(TARGET, '# A different document\n')).be.false();
    should(calls.filter(call => call === 'write')).deepEqual([]);
    should(stored(folder)).equal('# Frozen transfer brief\n');
  });

  it('reconstructs the exact brief from the frozen document after a loss before durability', async () => {
    // Arrange — power is cut inside the publication window: the write landed for this process, but the
    // process died before it could return, and after the reboot the bytes are not there. The frozen plan
    // renders the same document, so a NEW writer replays it exactly.
    const document = '# Frozen transfer brief\n\nOne cut, one document.\n';
    const folder = new MemoryStateFolder();
    folder.armCrash();

    // Act — the interrupted attempt, the loss, then a fresh writer after the reboot.
    const error = await reject(harness(folder).subject.write(TARGET, document));
    folder.revive();
    folder.bytes.clear();
    const recovered = await harness(folder).subject.write(TARGET, document);

    // Assert — the interrupted attempt did not return successfully.
    should(error).be.instanceOf(SimulatedCrash);
    should(recovered).endWith('turn-001.md');
    should(stored(folder)).equal(document);
  });

  it('accepts what a crashed attempt left whole, and still makes it durable before returning', async () => {
    // Arrange — the crash came AFTER the write landed: the document is complete and visible.
    const document = '# Frozen transfer brief\n';
    const folder = new MemoryStateFolder();
    folder.armCrash();
    await reject(harness(folder).subject.write(TARGET, document));
    folder.revive();
    const replay = harness(folder);

    // Act
    await replay.subject.write(TARGET, document);

    // Assert — it was proved and republished, not trusted.
    should(replay.calls).deepEqual(['read', 'write', 'read']);
    should(stored(folder)).equal(document);
  });

  it('recovers from one writer replacing the name mid-publication, and fails closed on a second', async () => {
    // Arrange — after this writer's write lands another writer puts different bytes under the name.
    const document = '# Frozen transfer brief\n';
    const folder = new MemoryStateFolder();
    let substitutions = 1;
    const once = harness(folder, async () => {
      if (substitutions-- > 0) folder.plantBytes(TransferBriefFiles, encode('# someone else\n'), TARGET);
    });

    // Act + Assert — one substitution is a race worth re-reading: the next publication stands.
    await once.subject.write(TARGET, document);
    should(stored(folder)).equal(document);

    // A second writer that substitutes every time is not chased forever: the call fails, so no receipt advances.
    const hostile = new MemoryStateFolder();
    const always = harness(hostile, async () => {
      hostile.plantBytes(TransferBriefFiles, encode('# someone else\n'), TARGET);
    });
    const error = await reject(always.subject.write(TARGET, document));
    should((error as Error).message).containEql('replaced by another writer');
  });

  it('refuses an unusable target key before resolving a path', async () => {
    const { subject, calls } = harness();

    const error = await reject(subject.write('../source-session', 'never written'));

    should((error as Error).message).equal('target session id is not usable');
    should(calls).deepEqual([]);
  });
});
