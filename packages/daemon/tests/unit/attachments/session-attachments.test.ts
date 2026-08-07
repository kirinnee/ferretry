import { describe, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { PdfDecryptError, SessionAttachmentStore } from '../../../src/lib/attachments/index.ts';

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

  it('leaves the encrypted original intact and locked after a wrong password', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ferretry-attachments-'));
    try {
      const store = new SessionAttachmentStore({
        root,
        daemonId: 'daemon-a',
        decrypt: async () => {
          throw new PdfDecryptError('wrong_password');
        },
      });
      const uploaded = await store.upload('session-a', {
        filename: 'private.pdf',
        mime: 'application/pdf',
        bytes: encryptedPdf,
      });

      await store.unlock('session-a', uploaded.id, 'wrong password').then(
        () => {
          throw new Error('unlock must refuse a wrong password');
        },
        error => should(error).have.property('failure', 'wrong_password'),
      );

      const downloaded = await store.download('session-a', uploaded.id);
      should(downloaded.attachment.encrypted?.locked).be.true();
      should(new TextDecoder().decode(downloaded.bytes)).equal(new TextDecoder().decode(encryptedPdf));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed when decryption cannot produce plaintext', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ferretry-attachments-'));
    try {
      const store = new SessionAttachmentStore({
        root,
        daemonId: 'daemon-a',
        decrypt: async () => {
          throw new PdfDecryptError('unreadable_document');
        },
      });
      const uploaded = await store.upload('session-a', {
        filename: 'damaged.pdf',
        mime: 'application/pdf',
        bytes: encryptedPdf,
      });

      await store.unlock('session-a', uploaded.id, 'correct password').then(
        () => {
          throw new Error('unlock must refuse an unreadable document');
        },
        error => should(error).have.property('failure', 'decryption_failed'),
      );

      const downloaded = await store.download('session-a', uploaded.id);
      should(downloaded.attachment.encrypted).deepEqual({ kind: 'pdf', locked: true });
      should(downloaded.bytes.byteLength).equal(encryptedPdf.byteLength);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('zeros and forgets every unlocked copy for a released session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ferretry-attachments-'));
    try {
      const store = new SessionAttachmentStore({
        root,
        daemonId: 'daemon-a',
        decrypt: async () => plaintext.slice(),
      });
      const uploaded = await store.upload('session-a', {
        filename: 'private.pdf',
        mime: 'application/pdf',
        bytes: encryptedPdf,
      });
      await store.unlock('session-a', uploaded.id, 'correct password');

      store.releaseSession('session-a');

      should((await store.download('session-a', uploaded.id)).attachment.encrypted?.locked).be.true();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('lists one session durable attachments, in content-address order, and never another session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ferretry-attachments-'));
    try {
      const store = new SessionAttachmentStore({ root, daemonId: 'daemon-a' });
      const first = await store.upload('session-a', {
        filename: 'first.txt',
        mime: 'text/plain',
        bytes: new Uint8Array([1, 2, 3]),
      });
      const second = await store.upload('session-a', {
        filename: 'second.txt',
        mime: 'text/plain',
        bytes: new Uint8Array([4, 5]),
      });
      await store.upload('session-b', {
        filename: 'somebody-else.txt',
        mime: 'text/plain',
        bytes: new Uint8Array([9]),
      });

      const listed = await store.list('session-a');

      should(listed.map(view => view.id)).deepEqual([first.id, second.id].sort());
      should(listed.map(view => view.size).reduce((total, size) => total + size, 0)).equal(5);
      should(await store.list('session-c')).be.empty();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('lists an encrypted original as locked even while this session holds its plaintext', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ferretry-attachments-'));
    try {
      const store = new SessionAttachmentStore({ root, daemonId: 'daemon-a', decrypt: async () => plaintext.slice() });
      const uploaded = await store.upload('session-a', {
        filename: 'private.pdf',
        mime: 'application/pdf',
        bytes: encryptedPdf,
      });
      await store.unlock('session-a', uploaded.id, 'correct password');

      const listed = await store.list('session-a');

      // The unlock is real and per session; a durable inventory must not enumerate it.
      should((await store.download('session-a', uploaded.id)).attachment.encrypted?.locked).be.false();
      should(listed[0]?.encrypted).deepEqual({ kind: 'pdf', locked: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('skips an attachment with no manifest and refuses one whose manifest cannot be parsed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ferretry-attachments-'));
    try {
      const store = new SessionAttachmentStore({ root, daemonId: 'daemon-a' });
      const kept = await store.upload('session-a', {
        filename: 'kept.txt',
        mime: 'text/plain',
        bytes: new Uint8Array([7]),
      });
      const session = join(root, 'attachments', 'daemon-a', 'session-a');
      // A stray file, and a directory a torn upload left with no manifest: neither is an attachment.
      await writeFile(join(session, `att_${'a'.repeat(64)}`), 'not a directory');
      await mkdir(join(session, `att_${'b'.repeat(64)}`), { recursive: true });

      should((await store.list('session-a')).map(view => view.id)).deepEqual([kept.id]);

      await writeFile(join(session, `att_${'b'.repeat(64)}`, 'manifest.json'), '{ truncated');
      await store.list('session-a').then(
        () => {
          throw new Error('an inventory must not silently omit bytes it cannot describe');
        },
        error => should(error).have.property('failure', 'corrupt'),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses to list a session id that is not usable as a directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ferretry-attachments-'));
    try {
      const store = new SessionAttachmentStore({ root, daemonId: 'daemon-a' });

      await store.list('../escape').then(
        () => {
          throw new Error('a path traversal must never be listed');
        },
        error => should(error).have.property('failure', 'invalid'),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a manifest whose facts are damaged, however sound the rest of it looks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ferretry-attachments-'));
    try {
      const store = new SessionAttachmentStore({ root, daemonId: 'daemon-a' });
      const uploaded = await store.upload('session-a', {
        filename: 'kept.txt',
        mime: 'text/plain',
        bytes: new Uint8Array([7]),
      });
      const manifest = join(root, 'attachments', 'daemon-a', 'session-a', uploaded.id, 'manifest.json');
      const sound: Record<string, unknown> = JSON.parse(await readFile(manifest, 'utf8'));

      // Every one of these once passed the id/filename/typeof-size check and became a durable fact
      // in whatever read it: a plan pins the size and the digest, so a manifest half-read here is a
      // transfer that fails much later, about a session, instead of now, about this file.
      const damaged: readonly (readonly [string, Record<string, unknown>])[] = [
        ['no mime at all', { mime: undefined }],
        ['an empty mime', { mime: '' }],
        ['a truncated digest', { sha256: 'abc' }],
        ['a digest that is not this content address', { sha256: 'f'.repeat(64) }],
        ['a fractional size', { size: 1.5 }],
        ['a negative size', { size: -1 }],
        ['a size that is not a number', { size: '7' }],
        ['a createdAt that is not an instant', { createdAt: 'yesterday' }],
        ['an encryption record of another kind', { encrypted: { kind: 'zip' } }],
        ['an encryption record that is not a record', { encrypted: 'yes' }],
        ['a filename that would be read back as a path', { filename: '../escape' }],
        ['an id belonging to other content', { id: `att_${'c'.repeat(64)}` }],
      ];
      for (const [why, override] of damaged) {
        await writeFile(manifest, JSON.stringify({ ...sound, ...override }));
        await store.list('session-a').then(
          () => {
            throw new Error(`an inventory must refuse a manifest with ${why}`);
          },
          error => should(error).have.property('failure', 'corrupt'),
        );
        await store.download('session-a', uploaded.id).then(
          () => {
            throw new Error(`a download must refuse a manifest with ${why}`);
          },
          error => should(error).have.property('failure', 'corrupt'),
        );
      }

      // The untouched manifest still reads, so every refusal above was for its own stated reason.
      await writeFile(manifest, JSON.stringify(sound));
      should((await store.list('session-a')).map(view => view.id)).deepEqual([uploaded.id]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
