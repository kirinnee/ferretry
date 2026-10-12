import { describe, it } from 'bun:test';
import should from 'should';
import {
  type AttachmentOriginalsPort,
  attachmentDirectory,
  PdfDecryptError,
  type PdfDecryptor,
  parseStoredAttachmentManifest,
  releasingAttachmentsOnStop,
  SessionAttachmentStore,
  type SessionAttachmentStoreOptions,
  sessionScopedAttachments,
} from '../../../src/lib/attachments/index.ts';

const encryptedPdf = new TextEncoder().encode('%PDF-1.7\n1 0 obj << /Encrypt 2 0 R >>\n');
const plaintext = new TextEncoder().encode('%PDF-1.7\nsecret plaintext must stay in RAM\n');
const AT = Date.parse('2026-10-09T00:00:00.000Z');
const MINUTE = 60_000;

/** Attachment originals held in memory: what a session's tree holds, without a disk. */
class MemoryOriginals implements AttachmentOriginalsPort {
  readonly trees = new Map<string, Map<string, { original?: Uint8Array; manifest?: string }>>();
  failList = false;
  failManifest = false;
  failPublish = false;

  tree(sessionId: string): Map<string, { original?: Uint8Array; manifest?: string }> {
    const existing = this.trees.get(sessionId);
    if (existing !== undefined) return existing;
    const created = new Map<string, { original?: Uint8Array; manifest?: string }>();
    this.trees.set(sessionId, created);
    return created;
  }

  async attachmentIds(sessionId: string): Promise<readonly string[]> {
    if (this.failList) throw new Error('listing failed');
    return [...(this.trees.get(sessionId)?.keys() ?? [])];
  }

  async readManifest(sessionId: string, attachmentId: string): Promise<string | undefined> {
    if (this.failManifest) throw new Error('read failed');
    return this.trees.get(sessionId)?.get(attachmentId)?.manifest;
  }

  async readOriginal(sessionId: string, attachmentId: string): Promise<Uint8Array> {
    const original = this.trees.get(sessionId)?.get(attachmentId)?.original;
    if (original === undefined) throw new Error('missing');
    return original.slice();
  }

  async publish(sessionId: string, attachmentId: string, original: Uint8Array, manifest: string): Promise<void> {
    if (this.failPublish) throw new Error('disk full');
    this.tree(sessionId).set(attachmentId, { original: original.slice(), manifest });
  }
}

interface Harness {
  readonly store: SessionAttachmentStore;
  readonly originals: MemoryOriginals;
  readonly clock: { now: number };
  readonly scheduled: { delayMs: number; evict: () => void }[];
  readonly decrypted: Uint8Array[];
}

function harness(
  overrides: Partial<SessionAttachmentStoreOptions> & { readonly decrypt?: PdfDecryptor } = {},
): Harness {
  const originals = new MemoryOriginals();
  const clock = { now: AT };
  const scheduled: { delayMs: number; evict: () => void }[] = [];
  const decrypted: Uint8Array[] = [];
  const store = new SessionAttachmentStore({
    daemonId: 'daemon-a',
    originals,
    decrypt: async () => {
      const bytes = plaintext.slice();
      decrypted.push(bytes);
      return bytes;
    },
    now: () => new Date(clock.now),
    scheduleEviction: (delayMs, evict) => scheduled.push({ delayMs, evict }),
    ...overrides,
  });
  return { store, originals, clock, scheduled, decrypted };
}

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    error => error,
  );
}

async function uploadPdf(store: SessionAttachmentStore, sessionId = 'session-a') {
  return await store.upload(sessionId, { filename: 'private.pdf', mime: 'application/pdf', bytes: encryptedPdf });
}

describe('SessionAttachmentStore', () => {
  it('publishes the original and its manifest, and keeps decrypted bytes in memory only', async () => {
    const { store, originals } = harness({
      decrypt: async (_bytes, password) => {
        should(password).equal('correct horse');
        return plaintext.slice();
      },
    });
    const uploaded = await uploadPdf(store);

    should(uploaded.encrypted?.locked).be.true();
    const unlocked = await store.unlock('session-a', uploaded.id, 'correct horse');
    should(unlocked.encrypted).deepEqual({
      kind: 'pdf',
      locked: false,
      expiresAt: new Date(AT + 15 * MINUTE).toISOString(),
      decryptedSize: plaintext.byteLength,
    });

    const stored = originals.trees.get('session-a')?.get(uploaded.id);
    should([...(stored?.original ?? [])]).deepEqual([...encryptedPdf]);
    should(JSON.parse(stored?.manifest ?? '{}')).deepEqual({
      id: uploaded.id,
      filename: 'private.pdf',
      mime: 'application/pdf',
      size: encryptedPdf.byteLength,
      sha256: uploaded.sha256,
      createdAt: new Date(AT).toISOString(),
      encrypted: { kind: 'pdf' },
    });

    await store.lock('session-a', uploaded.id);
    should((await store.download('session-a', uploaded.id)).attachment.encrypted?.locked).be.true();
  });

  it('answers a repeated upload of the same bytes with the attachment already stored', async () => {
    const { store, originals } = harness();
    const first = await store.upload('session-a', { filename: 'a.txt', mime: '', bytes: new Uint8Array([1]) });
    const second = await store.upload('session-a', {
      filename: 'b.txt',
      mime: 'text/plain',
      bytes: new Uint8Array([1]),
    });

    should(second).deepEqual(first);
    should(first.mime).equal('application/octet-stream');
    should(originals.trees.get('session-a')?.size).equal(1);
  });

  it('refuses an unusable upload before anything is published', async () => {
    const { store, originals } = harness();

    for (const filename of ['.', '..', 'dir/..', 'a\0b'])
      should(
        await refusal(store.upload('session-a', { filename, mime: 'text/plain', bytes: new Uint8Array([1]) })),
      ).have.property('failure', 'invalid');
    should(
      await refusal(store.upload('session-a', { filename: 'x', mime: 'text/plain', bytes: new Uint8Array() })),
    ).have.property('failure', 'too_large');
    should(
      await refusal(
        store.upload('session-a', { filename: 'x', mime: 'text/plain', bytes: new Uint8Array(32 * 1024 * 1024 + 1) }),
      ),
    ).have.property('failure', 'too_large');
    should(
      await refusal(store.upload('../escape', { filename: 'x', mime: 'text/plain', bytes: new Uint8Array([1]) })),
    ).have.property('failure', 'invalid');
    should(originals.trees.size).equal(0);
  });

  it('keeps the original basename of a path-shaped upload name', async () => {
    const { store } = harness();
    const uploaded = await store.upload('session-a', {
      filename: 'C:\\Users\\me\\report.txt',
      mime: 'text/plain',
      bytes: new Uint8Array([3]),
    });
    should(uploaded.filename).equal('report.txt');
  });

  it('surfaces a failed publish rather than reporting an attachment', async () => {
    const { store, originals } = harness();
    originals.failPublish = true;
    should(
      await refusal(store.upload('session-a', { filename: 'x', mime: 'text/plain', bytes: new Uint8Array([1]) })),
    ).have.property('message', 'disk full');
  });

  it('scopes an attachment id to its session', async () => {
    const { store } = harness();
    const uploaded = await store.upload('session-a', {
      filename: 'n.txt',
      mime: 'text/plain',
      bytes: new Uint8Array([1]),
    });

    should(await refusal(store.download('session-b', uploaded.id))).have.property('failure', 'not_found');
    should(await refusal(store.download('session-a', 'att_nothex'))).have.property('failure', 'invalid');
  });

  it('refuses an original that is missing or no longer matches its manifest', async () => {
    const { store, originals } = harness();
    const uploaded = await store.upload('session-a', {
      filename: 'n.txt',
      mime: 'text/plain',
      bytes: new Uint8Array([1]),
    });
    const entry = originals.tree('session-a').get(uploaded.id);

    originals.tree('session-a').set(uploaded.id, { ...entry, original: new Uint8Array([2]) });
    should(await refusal(store.download('session-a', uploaded.id))).have.property('failure', 'corrupt');
    originals.tree('session-a').set(uploaded.id, { ...entry, original: new Uint8Array([1, 1]) });
    should(await refusal(store.download('session-a', uploaded.id))).have.property('failure', 'corrupt');
    originals.tree('session-a').set(uploaded.id, { manifest: entry?.manifest });
    should(await refusal(store.download('session-a', uploaded.id))).have.property('failure', 'corrupt');
  });

  it('leaves the original intact and locked after a wrong password or a failed decryption', async () => {
    for (const [failure, expected] of [
      ['wrong_password', 'wrong_password'],
      ['unreadable_document', 'decryption_failed'],
    ] as const) {
      const { store } = harness({
        decrypt: async () => {
          throw new PdfDecryptError(failure);
        },
      });
      const uploaded = await uploadPdf(store);

      should(await refusal(store.unlock('session-a', uploaded.id, 'a password'))).have.property('failure', expected);
      const downloaded = await store.download('session-a', uploaded.id);
      should(downloaded.attachment.encrypted).deepEqual({ kind: 'pdf', locked: true });
      should([...downloaded.bytes]).deepEqual([...encryptedPdf]);
    }
  });

  it('refuses an unlock with no password, of a plain file, or that yields unusable plaintext', async () => {
    const { store } = harness({ decrypt: async () => new Uint8Array() });
    const pdf = await uploadPdf(store);
    const plain = await store.upload('session-a', {
      filename: 'n.txt',
      mime: 'text/plain',
      bytes: new Uint8Array([1]),
    });

    should(await refusal(store.unlock('session-a', pdf.id, ''))).have.property('failure', 'wrong_password');
    should(await refusal(store.unlock('session-a', plain.id, 'pw'))).have.property('failure', 'invalid');
    should(await refusal(store.unlock('session-a', pdf.id, 'pw'))).have.property('failure', 'decryption_failed');

    const thrower = harness({
      decrypt: async () => {
        throw new Error('worker vanished');
      },
    });
    const other = await uploadPdf(thrower.store);
    should(await refusal(thrower.store.unlock('session-a', other.id, 'pw'))).have.property(
      'message',
      'worker vanished',
    );
  });

  it('reads an unlock as locked once it expires, and zeroes its plaintext without being asked', async () => {
    const { store, clock, decrypted } = harness();
    const uploaded = await uploadPdf(store);
    await store.unlock('session-a', uploaded.id, 'correct password');

    clock.now = AT + 15 * MINUTE - 1;
    should((await store.download('session-a', uploaded.id)).attachment.encrypted?.locked).be.false();

    clock.now = AT + 15 * MINUTE;
    should((await store.download('session-a', uploaded.id)).attachment.encrypted).deepEqual({
      kind: 'pdf',
      locked: true,
    });
    should(decrypted[0]?.every(byte => byte === 0)).be.true();
  });

  it('expires every session plaintext on any read, not only the one being read', async () => {
    const { store, clock, decrypted } = harness();
    const uploaded = await uploadPdf(store);
    const other = await store.upload('session-b', {
      filename: 'n.txt',
      mime: 'text/plain',
      bytes: new Uint8Array([1]),
    });
    await store.unlock('session-a', uploaded.id, 'correct password');

    clock.now = AT + 16 * MINUTE;
    await store.download('session-b', other.id);

    should(decrypted[0]?.every(byte => byte === 0)).be.true();
  });

  it('schedules the eviction of an unread plaintext at its expiry', async () => {
    const { store, scheduled, decrypted } = harness();
    const uploaded = await uploadPdf(store);
    await store.unlock('session-a', uploaded.id, 'correct password');

    should(scheduled.map(entry => entry.delayMs)).deepEqual([15 * MINUTE]);
    scheduled[0]?.evict();

    should(decrypted[0]?.every(byte => byte === 0)).be.true();
    should((await store.download('session-a', uploaded.id)).attachment.encrypted?.locked).be.true();
  });

  it('never lets a stale eviction lock a later unlock', async () => {
    const { store, scheduled, decrypted } = harness();
    const uploaded = await uploadPdf(store);
    await store.unlock('session-a', uploaded.id, 'correct password');
    await store.unlock('session-a', uploaded.id, 'correct password');

    // The first plaintext was replaced, so it is zeroed at once and its timer is inert.
    should(decrypted[0]?.every(byte => byte === 0)).be.true();
    scheduled[0]?.evict();
    should((await store.download('session-a', uploaded.id)).attachment.encrypted?.locked).be.false();
  });

  it('expires lazily when no eviction scheduler is wired', async () => {
    const { store, clock } = harness({ scheduleEviction: undefined });
    const uploaded = await uploadPdf(store);
    await store.unlock('session-a', uploaded.id, 'pw');
    clock.now = AT + 15 * MINUTE;
    should((await store.lock('session-a', uploaded.id)).encrypted?.locked).be.true();
  });

  it('zeroes and forgets every unlocked copy for a released session, and only that session', async () => {
    const { store, decrypted } = harness();
    const left = await uploadPdf(store, 'session-a');
    const right = await uploadPdf(store, 'session-b');
    await store.unlock('session-a', left.id, 'pw');
    await store.unlock('session-b', right.id, 'pw');

    store.releaseSession('session-a');

    should(decrypted[0]?.every(byte => byte === 0)).be.true();
    should((await store.download('session-a', left.id)).attachment.encrypted?.locked).be.true();
    should((await store.download('session-b', right.id)).attachment.encrypted?.locked).be.false();
  });

  it('lists one session durable attachments, in content-address order, and never another session', async () => {
    const { store, originals } = harness();
    const first = await store.upload('session-a', {
      filename: 'a.txt',
      mime: 'text/plain',
      bytes: new Uint8Array([1]),
    });
    const second = await store.upload('session-a', {
      filename: 'b.txt',
      mime: 'text/plain',
      bytes: new Uint8Array([2]),
    });
    await store.upload('session-b', { filename: 'c.txt', mime: 'text/plain', bytes: new Uint8Array([9]) });
    // A torn upload (no manifest) and an entry that is not an attachment id are both skipped.
    originals.tree('session-a').set(`att_${'b'.repeat(64)}`, { original: new Uint8Array([5]) });
    originals.tree('session-a').set('not-an-attachment', {});

    should((await store.list('session-a')).map(view => view.id)).deepEqual([first.id, second.id].sort());
    should(await store.list('session-c')).be.empty();
    should(await refusal(store.list('../escape'))).have.property('failure', 'invalid');
  });

  it('lists an encrypted original as locked even while this session holds its plaintext', async () => {
    const { store } = harness();
    const uploaded = await uploadPdf(store);
    await store.unlock('session-a', uploaded.id, 'pw');

    should((await store.list('session-a'))[0]?.encrypted).deepEqual({ kind: 'pdf', locked: true });
  });

  it('refuses an inventory it cannot read rather than omitting what it cannot describe', async () => {
    const { store, originals } = harness();
    const uploaded = await store.upload('session-a', {
      filename: 'a.txt',
      mime: 'text/plain',
      bytes: new Uint8Array([1]),
    });

    originals.tree('session-a').set(`att_${'b'.repeat(64)}`, { manifest: '{ truncated' });
    should(await refusal(store.list('session-a'))).have.property('failure', 'corrupt');
    originals.tree('session-a').delete(`att_${'b'.repeat(64)}`);

    originals.failManifest = true;
    should(await refusal(store.download('session-a', uploaded.id))).have.property('failure', 'corrupt');
    originals.failList = true;
    should(await refusal(store.list('session-a'))).have.property('failure', 'corrupt');
  });

  it('requires a daemon id', () => {
    should(() => harness({ daemonId: ' ' })).throw('a daemon id is required for attachment storage');
  });

  it('reads the wall clock when no clock is injected', async () => {
    const before = Date.now();
    const { store } = harness({ now: undefined });
    const uploaded = await store.upload('session-a', {
      filename: 'a.txt',
      mime: 'text/plain',
      bytes: new Uint8Array([1]),
    });
    should(Date.parse(uploaded.createdAt)).be.aboveOrEqual(before);
  });
});

describe('parseStoredAttachmentManifest', () => {
  const id = `att_${'a'.repeat(64)}`;
  const sound = {
    id,
    filename: 'kept.txt',
    mime: 'text/plain',
    size: 1,
    sha256: 'a'.repeat(64),
    createdAt: '2026-10-09T00:00:00.000Z',
  };

  it('reads a sound manifest, encrypted or not', () => {
    should(parseStoredAttachmentManifest(sound, id)).deepEqual(sound);
    should(parseStoredAttachmentManifest({ ...sound, encrypted: { kind: 'pdf' } }, id)).deepEqual({
      ...sound,
      encrypted: { kind: 'pdf' },
    });
  });

  it('refuses a manifest whose facts are damaged, however sound the rest of it looks', () => {
    const damaged: readonly (readonly [string, unknown])[] = [
      ['not a record', ['an', 'array']],
      ['no mime at all', { ...sound, mime: undefined }],
      ['an empty mime', { ...sound, mime: '' }],
      ['a truncated digest', { ...sound, sha256: 'abc' }],
      ['a digest that is not this content address', { ...sound, sha256: 'f'.repeat(64) }],
      ['a fractional size', { ...sound, size: 1.5 }],
      ['a negative size', { ...sound, size: -1 }],
      ['a createdAt that is not an instant', { ...sound, createdAt: 'yesterday' }],
      ['an encryption record of another kind', { ...sound, encrypted: { kind: 'zip' } }],
      ['an encryption record with extra facts', { ...sound, encrypted: { kind: 'pdf', password: 'x' } }],
      ['an encryption record that is an array', { ...sound, encrypted: [] }],
      ['an encryption record that is not a record', { ...sound, encrypted: 'yes' }],
      ['a field the durable format does not hold', { ...sound, note: 'smuggled' }],
      ['a filename that would be read back as a path', { ...sound, filename: '../escape' }],
      ['a filename of .', { ...sound, filename: '.' }],
      ['a filename of ..', { ...sound, filename: '..' }],
      ['an id belonging to other content', { ...sound, id: `att_${'c'.repeat(64)}` }],
    ];
    for (const [why, document] of damaged) {
      let refused: unknown;
      try {
        parseStoredAttachmentManifest(document, id);
      } catch (error) {
        refused = error;
      }
      if (refused === undefined) throw new Error(`a manifest with ${why} must be refused`);
      should(refused).have.property('failure', 'corrupt');
    }
    should(() => parseStoredAttachmentManifest(sound, `att_${'b'.repeat(64)}`)).throw({ failure: 'corrupt' });
  });
});

describe('attachmentDirectory', () => {
  it('names one daemon and session tree, and refuses an id that would leave it', () => {
    should(attachmentDirectory('/state', 'daemon-a', 'session-a')).equal('/state/attachments/daemon-a/session-a');
    for (const sessionId of ['..', '.', '../escape', 'a/b', ''])
      should(() => attachmentDirectory('/state', 'daemon-a', sessionId)).throw({ failure: 'invalid' });
    should(() => attachmentDirectory('/state', ' ', 'session-a')).throw({ failure: 'invalid' });
  });
});

describe('sessionScopedAttachments', () => {
  it('reaches the store only for a session that exists, and zeroes a vanished session plaintext', async () => {
    const { store, decrypted } = harness();
    const live = new Set(['session-a']);
    const scoped = sessionScopedAttachments(store, async id => live.has(id));

    const uploaded = await scoped.upload('session-a', {
      filename: 'private.pdf',
      mime: 'application/pdf',
      bytes: encryptedPdf,
    });
    should((await scoped.unlock('session-a', uploaded.id, 'pw')).encrypted?.locked).be.false();
    should((await scoped.download('session-a', uploaded.id)).bytes.byteLength).equal(encryptedPdf.byteLength);
    should((await scoped.lock('session-a', uploaded.id)).encrypted?.locked).be.true();
    await scoped.unlock('session-a', uploaded.id, 'pw');

    live.delete('session-a');
    should(await refusal(scoped.download('session-a', uploaded.id))).have.property('failure', 'not_found');
    should(decrypted[1]?.every(byte => byte === 0)).be.true();
    live.add('session-a');
    should((await scoped.download('session-a', uploaded.id)).attachment.encrypted?.locked).be.true();
  });
});

describe('releasingAttachmentsOnStop', () => {
  it('zeroes a stopped session plaintext whether or not the stop succeeded', async () => {
    const released: string[] = [];
    const store = { releaseSession: (id: string) => released.push(id) };
    const control = {
      name: 'control',
      stop: async (id: string, reason: string | undefined) => {
        if (reason === 'fail') throw new Error('kill failed');
        return { id };
      },
    };
    const wrapped = releasingAttachmentsOnStop(control, store);

    should(await wrapped.stop('session-a', undefined)).deepEqual({ id: 'session-a' });
    should(await refusal(wrapped.stop('session-b', 'fail'))).have.property('message', 'kill failed');
    should(released).deepEqual(['session-a', 'session-b']);
    should(wrapped.name).equal('control');
  });
});
