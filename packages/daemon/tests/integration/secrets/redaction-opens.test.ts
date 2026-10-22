import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, describe, it } from 'bun:test';
import should from 'should';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import {
  FileSecretDocumentStore,
  FileSecretKey,
  SECRETS_DOCUMENT,
  WebCryptoSecretCipher,
} from '../../../src/adapters/secrets/index.ts';
import {
  createFoundationPaths,
  resolveStateHome,
  SecretDirectory,
  SecretRedactor,
  SecretVault,
} from '../../../src/lib/index.ts';
import { OperatorReadService } from '../../../src/lib/session/reads/index.ts';
import type { TranscriptEvent } from '../../../src/lib/transcript/types.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

/**
 * What one operator read costs the VAULT, against a real filesystem and real WebCrypto.
 *
 * Opening the vault reads the ciphertext document and the key file from disk, and on a busy Mac a
 * key-file read was measured at 652 ms p95. A page of a session's journal or transcript is up to
 * hundreds of strings, so a read that opened the vault once per string paid that once per row. These
 * cases pin the cost of a whole page to the cost of ONE open, measured here rather than assumed: the
 * baseline is what a single `values()` call reads on this same vault, so the assertion holds however
 * the cipher itself spends its reads.
 */

const VALUE = 'sk-live-super-secret-value-0123456789';
const CLOCK = { now: () => '2026-01-01T00:00:00.000Z' };
const INSTANT = '2026-02-01T09:08:07.000Z';
const ROWS = 100;

/** The real state filesystem, counting each read of the two vault files. */
class CountedFiles extends StateFileSystem {
  readonly reads = new Map<string, number>();

  override async readText(path: string): Promise<string | undefined> {
    this.reads.set(path, (this.reads.get(path) ?? 0) + 1);
    return await super.readText(path);
  }
}

interface Measured {
  readonly reads: OperatorReadService;
  readonly vault: SecretVault;
  /** Reads of the document and of the key file since the last call. */
  readonly delta: () => { readonly document: number; readonly key: number };
}

async function measured(label: string): Promise<Measured> {
  const home = await tempDirectory(label);
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  const files = new CountedFiles(paths);
  await files.ensureDirectory(paths.home, 0o700);
  await files.ensureDirectory(paths.state, 0o700);
  await files.ensureDirectory(paths.temporary, 0o700);
  const documents = new FileSecretDocumentStore(paths, files);
  const cipher = new WebCryptoSecretCipher(new FileSecretKey(documents.keyFile, files));
  const directory = new SecretDirectory(documents, cipher, CLOCK);
  await directory.put('TOKEN', VALUE);
  await directory.put('OTHER', 'another-secret-value-0123456789');
  await directory.put('THIRD', 'a-third-secret-value-0123456789');
  const vault = new SecretVault(documents, cipher);
  const documentPath = join(paths.state, SECRETS_DOCUMENT);
  let seen = { document: 0, key: 0 };
  const delta = (): { readonly document: number; readonly key: number } => {
    const now = { document: files.reads.get(documentPath) ?? 0, key: files.reads.get(documents.keyFile) ?? 0 };
    const spent = { document: now.document - seen.document, key: now.key - seen.key };
    seen = now;
    return spent;
  };
  delta();
  const message = (text: string): TranscriptEvent =>
    ({ kind: 'message', harness: 'claude', role: 'assistant', timestamp: INSTANT, text }) as TranscriptEvent;
  const reads = new OperatorReadService(
    {
      replay: async () =>
        Array.from({ length: ROWS }, (_, index) => ({
          sequence: index + 1,
          sessionId: 's1',
          time: INSTANT,
          type: 'tool.result',
          data: { output: `row ${index} printed ${VALUE}` },
        })),
    },
    { capture: async () => ({ alive: true, dead: false, text: `screen ${VALUE}` }) },
    {
      tail: async () => ({
        kind: 'read',
        events: Array.from({ length: ROWS }, (_, index) => message(`turn ${index} with ${VALUE}`)),
      }),
    },
    {
      read: async () => ({
        kind: 'read',
        context: {
          sessionId: 's1',
          incarnation: 'inc-one',
          provenance: {
            v: 1,
            home: '/harness/home',
            identity: 'minted',
            harnessSessionId: 'harness-one',
            file: '/harness/home/one.jsonl',
            resolvedAt: INSTANT,
          },
        },
        rows: Array.from({ length: ROWS }, (_, index) => ({
          point: { v: 1, byteOffset: index + 1, blockIndex: 0 },
          role: 'assistant' as const,
          text: `row ${index} with ${VALUE}`,
          timestamp: INSTANT,
          rawPrefix: new Uint8Array(32).fill(index),
        })),
      }),
    },
    {
      tag: async input => new Uint8Array(createHmac('sha256', 'redaction-opens-fixture').update(input).digest()),
      matches: async () => false,
    },
    { read: async () => ({ kind: 'absent' }) },
    new SecretRedactor(vault),
  );
  return { reads, vault, delta };
}

afterAll(async () => {
  await cleanupTempDirectories();
});

describe('one operator read costs one vault open', () => {
  it('should read the vault files for a whole journal page as often as for one open', async () => {
    // Arrange
    const subject = await measured('redaction-opens-events');
    await subject.vault.values();
    const oneOpen = subject.delta();

    // Act
    const page = await subject.reads.events('s1', 0, ROWS);

    // Assert
    should(page).have.length(ROWS);
    should(JSON.stringify(page)).not.containEql(VALUE);
    should(subject.delta()).eql(oneOpen);
    should(oneOpen.document).equal(1);
  });

  it('should read the vault files for a whole page of rows as often as for one open', async () => {
    // Arrange
    const subject = await measured('redaction-opens-messages');
    await subject.vault.values();
    const oneOpen = subject.delta();

    // Act
    const page = await subject.reads.messages('s1', undefined, ROWS);

    // Assert
    should(page.messages).have.length(ROWS);
    should(JSON.stringify(page)).not.containEql(VALUE);
    should(subject.delta()).eql(oneOpen);
  });

  it('should read the vault files once per transcript and per screen', async () => {
    // Arrange
    const subject = await measured('redaction-opens-logs');
    await subject.vault.values();
    const oneOpen = subject.delta();

    // Act
    const transcript = await subject.reads.logs('s1', ROWS);
    const afterLogs = subject.delta();
    const screen = await subject.reads.snapshot('s1');

    // Assert
    should(transcript).not.containEql(VALUE);
    should(screen).equal('screen [redacted:TOKEN]');
    should(afterLogs).eql(oneOpen);
    should(subject.delta()).eql(oneOpen);
  });
});
