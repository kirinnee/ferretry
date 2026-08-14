import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { SessionAttachmentTransferReader } from '../../../src/adapters/transfer/session-attachment-reader.ts';
import { SessionAttachmentStore } from '../../../src/lib/attachments/session-attachments.ts';

/**
 * The inventory a transfer plan pins, off the real attachment store.
 *
 * Everything asserted here is a fact import later depends on: the content-addressed id, the sha256
 * and byte size the copier verifies against, and the LOCKED state of an encrypted original. The one
 * thing that must never appear is the plaintext cache — an unlock belongs to the session that
 * supplied the password, and a transfer that carried it would hand a new session a document its own
 * operator never unlocked.
 */

const encryptedPdf = new TextEncoder().encode('%PDF-1.7\n1 0 obj << /Encrypt 2 0 R >>\n');
const plaintext = new TextEncoder().encode('%PDF-1.7\nthe decrypted document\n');
const roots = new Set<string>();

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fy-transfer-attachments-'));
  roots.add(root);
  return root;
}

function store(root: string): SessionAttachmentStore {
  return new SessionAttachmentStore({ root, daemonId: 'daemon-a', decrypt: async () => plaintext.slice() });
}

const directory = (root: string, sessionId: string, attachmentId: string): string =>
  join(root, 'attachments', 'daemon-a', sessionId, attachmentId);

describe('SessionAttachmentTransferReader', () => {
  it('should report the identity, size and content hash the plan pins, in content-address order', async () => {
    // Arrange
    const root = await temporaryRoot();
    const attachments = store(root);
    const notes = await attachments.upload('20260806-source', {
      filename: 'notes.txt',
      mime: 'text/plain',
      bytes: new TextEncoder().encode('the working notes'),
    });
    const data = await attachments.upload('20260806-source', {
      filename: 'data.csv',
      mime: 'text/csv',
      bytes: new TextEncoder().encode('a,b\n1,2\n'),
    });

    // Act
    const inventory = await new SessionAttachmentTransferReader(attachments).list('20260806-source');

    // Assert: every fact the copier verifies against, and a stable order for a replayable plan.
    should(inventory.map(view => view.id)).eql([notes.id, data.id].sort());
    should(inventory.find(view => view.id === notes.id)).eql({
      id: notes.id,
      filename: 'notes.txt',
      mime: 'text/plain',
      size: 17,
      sha256: notes.id.slice('att_'.length),
      createdAt: notes.createdAt,
    });
  });

  it('should report an unlocked original as locked, and never its decrypted size', async () => {
    // Arrange: the source session has the password cached right now.
    const root = await temporaryRoot();
    const attachments = store(root);
    const uploaded = await attachments.upload('20260806-source', {
      filename: 'private.pdf',
      mime: 'application/pdf',
      bytes: encryptedPdf,
    });
    const unlocked = await attachments.unlock('20260806-source', uploaded.id, 'correct horse');

    // Act
    const inventory = await new SessionAttachmentTransferReader(attachments).list('20260806-source');

    // Assert: the store knows it is unlocked; the transfer inventory does not carry that.
    should(unlocked.encrypted).have.property('locked', false);
    should(inventory).have.length(1);
    should(inventory[0]?.encrypted).eql({ kind: 'pdf', locked: true });
  });

  it('should answer an empty inventory for a session that has never attached anything', async () => {
    // Arrange: no attachment directory exists at all, which is the ordinary case.
    const root = await temporaryRoot();

    // Act
    const inventory = await new SessionAttachmentTransferReader(store(root)).list('20260806-empty');

    // Assert
    should(inventory).be.empty();
  });

  it('should skip a torn upload and refuse an inventory it cannot describe completely', async () => {
    // Arrange: one attachment with no manifest at all, and one whose manifest is not readable.
    const root = await temporaryRoot();
    const attachments = store(root);
    const kept = await attachments.upload('20260806-source', {
      filename: 'kept.txt',
      mime: 'text/plain',
      bytes: new TextEncoder().encode('still here'),
    });
    const torn = `att_${'0'.repeat(64)}`;
    await mkdir(directory(root, '20260806-source', torn), { recursive: true });
    const reader = new SessionAttachmentTransferReader(attachments);

    // Act
    const withTornUpload = await reader.list('20260806-source');
    const damaged = `att_${'1'.repeat(64)}`;
    await mkdir(directory(root, '20260806-source', damaged), { recursive: true });
    await writeFile(join(directory(root, '20260806-source', damaged), 'manifest.json'), '{not json');
    const failure = await reader.list('20260806-source').then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert: a directory with no manifest is not an attachment; a manifest that will not parse is
    // bytes this daemon cannot describe, and a plan must not silently omit them.
    should(withTornUpload.map(view => view.id)).eql([kept.id]);
    should(failure).have.property('failure', 'corrupt');
  });

  it('should refuse a session id the attachment store would not accept', async () => {
    // Arrange: a path separator in a session id must never become a directory traversal.
    const root = await temporaryRoot();

    // Act
    const failure = await new SessionAttachmentTransferReader(store(root)).list('../escape').then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert
    should(failure).have.property('failure', 'invalid');
  });
});
