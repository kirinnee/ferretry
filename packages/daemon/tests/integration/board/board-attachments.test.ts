import { describe, it } from 'bun:test';
import should from 'should';
import { StoreBoardAttachments } from '../../../src/adapters/board/board-attachments.ts';
import { type AttachmentOriginalsPort, SessionAttachmentStore } from '../../../src/lib/attachments/index.ts';

/** The files of "Not good" with pictures, through the real attachment store over originals held in memory. */

class MemoryOriginals implements AttachmentOriginalsPort {
  readonly trees = new Map<string, Map<string, { readonly original: Uint8Array; readonly manifest: string }>>();

  async attachmentIds(sessionId: string): Promise<readonly string[]> {
    return [...(this.trees.get(sessionId)?.keys() ?? [])];
  }

  async readManifest(sessionId: string, attachmentId: string): Promise<string | undefined> {
    return this.trees.get(sessionId)?.get(attachmentId)?.manifest;
  }

  async readOriginal(sessionId: string, attachmentId: string): Promise<Uint8Array> {
    const entry = this.trees.get(sessionId)?.get(attachmentId);
    if (entry === undefined) throw new Error('missing');
    return entry.original.slice();
  }

  async publish(sessionId: string, attachmentId: string, original: Uint8Array, manifest: string): Promise<void> {
    const tree = this.trees.get(sessionId) ?? new Map();
    tree.set(attachmentId, { original: original.slice(), manifest });
    this.trees.set(sessionId, tree);
  }
}

const harness = () => {
  const originals = new MemoryOriginals();
  const store = new SessionAttachmentStore({
    daemonId: 'daemon-1',
    originals,
    decrypt: async () => new Uint8Array(),
    now: () => new Date('2026-10-30T10:00:00.000Z'),
  });
  return { originals, store, subject: new StoreBoardAttachments(store) };
};

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

describe('the board view of the attachment store', () => {
  it('should name the files a session holds, in the order asked', async () => {
    // Arrange
    const { store, subject } = harness();
    const shot = await store.upload('child-1', { filename: 'flicker.png', mime: 'image/png', bytes: PNG });
    const note = await store.upload('child-1', {
      filename: 'notes.txt',
      mime: 'text/plain',
      bytes: new TextEncoder().encode('still flickers'),
    });

    // Act
    const named = await subject.describe('child-1', [note.id, shot.id]);

    // Assert
    should(named).deepEqual([
      { id: note.id, filename: 'notes.txt', mime: 'text/plain' },
      { id: shot.id, filename: 'flicker.png', mime: 'image/png' },
    ]);
  });

  it('should refuse a file the session does not hold', async () => {
    // Arrange
    const { store, subject } = harness();
    const shot = await store.upload('child-1', { filename: 'flicker.png', mime: 'image/png', bytes: PNG });

    // Act
    const refused = await subject.describe('lead-1', [shot.id]).then(
      () => null,
      (error: unknown) => error,
    );

    // Assert
    should(refused).be.instanceOf(Error);
    should((refused as Error).message).equal(`no attachment ${shot.id}`);
  });

  it('should carry a file into another session under the same id, with its name and type', async () => {
    // Arrange
    const { originals, store, subject } = harness();
    const shot = await store.upload('child-1', { filename: 'flicker.png', mime: 'image/png', bytes: PNG });

    // Act
    const carried = await subject.carry('child-1', 'lead-1', [shot.id]);

    // Assert
    should(carried).deepEqual([shot.id]);
    should(await subject.describe('lead-1', [shot.id])).deepEqual([
      { id: shot.id, filename: 'flicker.png', mime: 'image/png' },
    ]);
    should([...(originals.trees.get('lead-1')?.get(shot.id)?.original ?? [])]).deepEqual([...PNG]);
  });

  it('should leave the files where they are when the ferret told is the one they were uploaded to', async () => {
    // Arrange
    const { originals, subject } = harness();
    const id = `att_${'a'.repeat(64)}`;

    // Act
    const carried = await subject.carry('child-1', 'child-1', [id]);

    // Assert — nothing was read, so a missing file is not even noticed
    should(carried).deepEqual([id]);
    should(originals.trees.size).equal(0);
  });

  it('should reject when a file cannot be read out of its session', async () => {
    // Arrange
    const { subject } = harness();

    // Act
    const refused = await subject.carry('child-1', 'lead-1', [`att_${'a'.repeat(64)}`]).then(
      () => null,
      (error: unknown) => error,
    );

    // Assert
    should(refused).be.instanceOf(Error);
  });
});
