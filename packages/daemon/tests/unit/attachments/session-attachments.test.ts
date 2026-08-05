import { describe, it } from 'bun:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { SessionAttachmentStore } from '../../../src/lib/attachments/index.ts';

const encryptedPdf = new TextEncoder().encode('%PDF-1.7\n1 0 obj << /Encrypt 2 0 R >>\n');
const plaintext = new TextEncoder().encode('%PDF-1.7\nsecret plaintext must stay in RAM\n');

describe('SessionAttachmentStore', () => {
  it('keeps decrypted bytes out of the filesystem and retains the encrypted original', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ferretry-attachments-'));
    try {
      const store = new SessionAttachmentStore({
        root,
        daemonId: 'daemon-a',
        decrypt: async (_bytes, password) => {
          should(password).equal('correct horse');
          return plaintext.slice();
        },
      });
      const uploaded = await store.upload('session-a', {
        filename: 'private.pdf',
        mime: 'application/pdf',
        bytes: encryptedPdf,
      });

      should(uploaded.encrypted?.locked).be.true();
      const unlocked = await store.unlock('session-a', uploaded.id, 'correct horse');
      should(unlocked.encrypted?.locked).be.false();

      const attachmentRoot = join(root, 'attachments', 'daemon-a', 'session-a', uploaded.id);
      const names = await readdir(attachmentRoot);
      should(names.sort()).deepEqual(['manifest.json', 'original']);
      const original = await readFile(join(attachmentRoot, 'original'), 'utf8');
      should(original).equal(new TextDecoder().decode(encryptedPdf));
      should(original.includes('secret plaintext must stay in RAM')).be.false();

      await store.lock('session-a', uploaded.id);
      should((await store.download('session-a', uploaded.id)).attachment.encrypted?.locked).be.true();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('scopes an attachment id to its daemon and session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ferretry-attachments-'));
    try {
      const left = new SessionAttachmentStore({ root, daemonId: 'daemon-a' });
      const right = new SessionAttachmentStore({ root, daemonId: 'daemon-b' });
      const uploaded = await left.upload('session-a', {
        filename: 'note.txt',
        mime: 'text/plain',
        bytes: new Uint8Array([1]),
      });

      await right.download('session-a', uploaded.id).then(
        () => {
          throw new Error('the second daemon must not read the first daemon attachment');
        },
        error => should(error).have.property('failure', 'not_found'),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
