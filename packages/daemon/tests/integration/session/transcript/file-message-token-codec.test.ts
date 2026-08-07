import { afterEach, describe, it } from 'bun:test';
import type { Stats } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import should from 'should';
import {
  FileSessionTranscriptMessageTokenCodec,
  type HeldSessionMessageTokenKey,
  NodeSessionMessageTokenKeyFileOperations,
  SESSION_MESSAGE_TOKEN_KEY_BYTES,
  SessionMessageTokenKeyError,
  type SessionMessageTokenKeyFileOperations,
  sessionMessageTokenKeyFile,
} from '../../../../src/adapters/session/transcript/file-message-token-codec.ts';
import { SESSION_MESSAGE_TOKEN_KEY_BASENAME } from '../../../../src/adapters/storage/state-home-layout.ts';
import { cleanupTempDirectories, tempDirectory } from '../../support/repository.ts';

/**
 * The daemon's private token key on a real filesystem.
 *
 * Everything here is a property the tokens depend on: one durable winner under concurrent first
 * use, the same key after a restart, a loser that removes only its own scratch, publication ordered
 * so a power loss cannot leave a key nobody can verify against, and a key that fails closed the
 * moment it is not exactly ours. Every run happens inside a throwaway state home.
 */

const INPUT = Buffer.from('one framed token input');
const OTHER_INPUT = Buffer.from('another framed token input');

/**
 * The repository's scratch grammar, `<basename>.<writerId>.tmp`, over the ONE owned basename.
 *
 * Derived rather than spelled out: a fixture carrying its own copy of the name would keep passing
 * against a file production no longer writes, which is precisely the drift the centralisation exists
 * to prevent.
 */
const scratchNameFor = (writerId: string): string => `${SESSION_MESSAGE_TOKEN_KEY_BASENAME}.${writerId}.tmp`;

/**
 * An fsync that refuses only for DIRECTORY handles.
 *
 * The distinction is the whole point of the tolerance rule, and it can only be drawn from the open
 * handle: a filesystem without directory persistence still flushes files perfectly well.
 */
const refusingDirectorySync =
  (code: string) =>
  async (handle: { sync: () => Promise<void>; stat?: () => Promise<Stats> }): Promise<void> => {
    if ((await handle.stat?.())?.isDirectory() === true)
      throw Object.assign(new Error(`fsync refused with ${code}`), { code });
    await handle.sync();
  };

/** Real operations with a completed-call trace, so publication ORDER can be asserted. */
class RecordingKeyFileOperations implements SessionMessageTokenKeyFileOperations {
  readonly calls: string[] = [];
  private readonly inner: NodeSessionMessageTokenKeyFileOperations;

  constructor(fsync?: (handle: { sync: () => Promise<void> }) => Promise<void>) {
    this.inner = new NodeSessionMessageTokenKeyFileOperations(fsync);
  }

  async ensureDirectory(path: string, mode: number): Promise<string | undefined> {
    const created = await this.inner.ensureDirectory(path, mode);
    this.calls.push(`ensure:${path}`);
    return created;
  }

  async writePrivateSynced(path: string, bytes: Uint8Array, mode: number): Promise<void> {
    await this.inner.writePrivateSynced(path, bytes, mode);
    // Resolves only after exclusive open -> write -> file fsync -> close.
    this.calls.push(`write-synced-closed:${path}`);
  }

  async link(from: string, to: string): Promise<void> {
    try {
      await this.inner.link(from, to);
      this.calls.push(`link:${to}`);
    } catch (error) {
      this.calls.push(`link-refused:${to}`);
      throw error;
    }
  }

  async readPinned<T>(
    path: string,
    use: (held: HeldSessionMessageTokenKey, syncPinned: () => Promise<void>) => Promise<T>,
  ): Promise<T | undefined> {
    return await this.inner.readPinned(path, async (held, syncPinned) => {
      // The bytes and the metadata are in hand and the handle is still open: everything decided
      // from here is decided about this one inode.
      this.calls.push(`read-pinned:${path}`);
      return await use(held, async () => {
        await syncPinned();
        this.calls.push(`sync-file:${path}`);
      });
    });
  }

  async syncDirectory(path: string): Promise<void> {
    await this.inner.syncDirectory(path);
    this.calls.push(`sync-directory:${path}`);
  }

  async identityOf(path: string): Promise<string | undefined> {
    const identity = await this.inner.identityOf(path);
    this.calls.push(`identity-of:${path}`);
    return identity;
  }

  async discard(path: string): Promise<void> {
    await this.inner.discard(path);
    this.calls.push(`discard:${path}`);
  }
}

/**
 * The fakes below EXTEND the recorder rather than spreading it.
 *
 * `{ ...recorder }` copies own properties and no prototype methods, so a spread-based fake has to
 * re-declare every operation by hand — and silently stops satisfying the port the moment one is
 * added to it. That is exactly what happened when `identityOf` arrived. Subclassing inherits every
 * operation, records every call the same way, and cannot fall behind the interface again.
 */

/** Refuses to remove this writer's scratch, the way a permission failure would. */
class ScratchRefusingOperations extends RecordingKeyFileOperations {
  override async discard(): Promise<void> {
    throw Object.assign(new Error('unlink refused with EPERM'), { code: 'EPERM' });
  }
}

/** Sweeps the scratch away before production removes it, so the real discard meets a true ENOENT. */
class ScratchVanishingOperations extends RecordingKeyFileOperations {
  override async discard(path: string): Promise<void> {
    await rm(path, { force: true });
    await super.discard(path);
  }
}

/**
 * Loses the publication race, deterministically.
 *
 * A codec reads the published key BEFORE it tries to publish one, which is correct — writing a
 * temporary on every boot just to lose the link would be worse. So an already-published key alone
 * never produces a loser, and a fixture that assumed otherwise was asserting a path it could not
 * reach. What produces a real loser is the window this models: the key is absent when we look and
 * present by the time we link, because another writer published in between.
 *
 * The first pinned read misses; every later one delegates. Nothing else is faked — the temporary,
 * the `link`, the `EEXIST` it earns from the filesystem, the adoption read and the scratch removal
 * are all real, so the loser branch is proved against production behaviour rather than a stub.
 */
class LosingRaceOperations extends RecordingKeyFileOperations {
  private missedFirstRead = false;

  override async readPinned<T>(
    path: string,
    use: (held: HeldSessionMessageTokenKey, syncPinned: () => Promise<void>) => Promise<T>,
  ): Promise<T | undefined> {
    if (!this.missedFirstRead) {
      this.missedFirstRead = true;
      this.calls.push(`read-pinned-absent:${path}`);
      return undefined;
    }
    return await super.readPinned(path, use);
  }
}

/** Replaces the published key after it was validated and flushed, but before the name is re-checked. */
class KeySwappingOperations extends RecordingKeyFileOperations {
  override async readPinned<T>(
    path: string,
    use: (held: HeldSessionMessageTokenKey, syncPinned: () => Promise<void>) => Promise<T>,
  ): Promise<T | undefined> {
    return await super.readPinned(path, async (held, syncPinned) => {
      const answer = await use(held, syncPinned);
      await rm(path);
      await writeFile(path, Buffer.alloc(SESSION_MESSAGE_TOKEN_KEY_BYTES, 0x11), { mode: 0o600 });
      return answer;
    });
  }
}

interface Harness {
  readonly home: string;
  readonly state: string;
  readonly scratch: string;
  readonly keyFile: string;
  codec(options?: {
    readonly writerId?: string;
    readonly files?: SessionMessageTokenKeyFileOperations;
    readonly random?: (size: number) => Uint8Array;
  }): FileSessionTranscriptMessageTokenCodec;
}

async function harness(label: string): Promise<Harness> {
  const home = await tempDirectory(label);
  const state = join(home, 'state');
  const scratch = join(state, 'tmp');
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const keyFile = sessionMessageTokenKeyFile(state);
  return {
    home,
    state,
    scratch,
    keyFile,
    codec: (options = {}) =>
      new FileSessionTranscriptMessageTokenCodec(
        keyFile,
        // Exactly the repository's scratch grammar: `<state>/tmp/<basename>.<writerId>.tmp`.
        writerId => join(scratch, scratchNameFor(writerId)),
        options.random,
        () => options.writerId ?? 'writer-a',
        options.files,
      ),
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject, but it resolved');
}

describe('FileSessionTranscriptMessageTokenCodec first publication', () => {
  afterEach(async () => await cleanupTempDirectories());

  it('publishes exactly 32 owner-only bytes and then issues a full-width tag', async () => {
    // Arrange
    const { codec, keyFile } = await harness('token-key-publish');

    // Act
    const tag = await codec().tag(INPUT);

    // Assert
    const published = await stat(keyFile);
    should(published.isFile()).be.true();
    should(published.mode & 0o777).equal(0o600);
    should((await readFile(keyFile)).byteLength).equal(SESSION_MESSAGE_TOKEN_KEY_BYTES);
    should(tag).have.length(32);
  });

  it('syncs the scratch bytes and directory before linking, then the key and its parent before any tag', async () => {
    // Arrange
    const { codec, state, scratch, keyFile } = await harness('token-key-order');
    const files = new RecordingKeyFileOperations();
    const temporary = join(scratch, scratchNameFor('writer-a'));

    // Act
    await codec({ files }).tag(INPUT);

    // Assert: the whole durability contract, in order — and step six is not optional.
    should(files.calls).eql([
      `ensure:${state}`,
      `ensure:${scratch}`,
      `write-synced-closed:${temporary}`,
      `sync-directory:${scratch}`,
      `link:${keyFile}`,
      `read-pinned:${keyFile}`,
      `sync-file:${keyFile}`,
      `sync-directory:${state}`,
      `identity-of:${keyFile}`,
      `discard:${temporary}`,
      `sync-directory:${scratch}`,
    ]);
  });

  it('leaves no scratch file behind', async () => {
    // Arrange
    const { codec, scratch } = await harness('token-key-scratch-clean');

    // Act
    await codec().tag(INPUT);

    // Assert
    should(await readdir(scratch)).be.empty();
  });

  it('resolves the key once and reuses it for every later token', async () => {
    // Arrange
    const { codec, keyFile } = await harness('token-key-memoized');
    const subject = codec();

    // Act
    const first = await subject.tag(INPUT);
    const bytesAfterFirst = await readFile(keyFile);
    const second = await subject.tag(INPUT);

    // Assert
    should(Buffer.from(first).equals(Buffer.from(second))).be.true();
    should((await readFile(keyFile)).equals(bytesAfterFirst)).be.true();
  });
});

describe('FileSessionTranscriptMessageTokenCodec create-once', () => {
  afterEach(async () => await cleanupTempDirectories());

  it('keeps ONE durable winner when two writers first use the key at the same moment', async () => {
    // Arrange: two independent codecs, as two processes would be.
    const { codec, keyFile, scratch } = await harness('token-key-race');
    const first = codec({ writerId: 'writer-a' });
    const second = codec({ writerId: 'writer-b' });

    // Act
    const [left, right] = await Promise.all([first.tag(INPUT), second.tag(INPUT)]);

    // Assert: both signed with the published key, and neither left scratch behind.
    should(Buffer.from(left).equals(Buffer.from(right))).be.true();
    should((await readFile(keyFile)).byteLength).equal(SESSION_MESSAGE_TOKEN_KEY_BYTES);
    should(await readdir(scratch)).be.empty();
  });

  it('makes an EEXIST loser adopt the winner and touch nothing but its own scratch', async () => {
    // Arrange: a winner has published, and a stranger's scratch file sits in the same directory this
    // loser will write its own into.
    const { codec, keyFile, scratch } = await harness('token-key-loser');
    const winnerTag = await codec({ writerId: 'winner' }).tag(INPUT);
    const winnerBytes = await readFile(keyFile);
    const strangerScratch = join(scratch, scratchNameFor('stranger'));
    await writeFile(strangerScratch, 'not this writer’s bytes', { mode: 0o600 });

    // The loser looks before the winner's key is visible to it and links after it is — the real
    // race — and mints DIFFERENT bytes, so a key it adopted can be told from one it published.
    const files = new LosingRaceOperations();
    const loser = codec({ writerId: 'loser', files, random: size => Buffer.alloc(size, 0x5a) });

    // Act
    const loserTag = await loser.tag(INPUT);

    // Assert: the link really was refused, so this is the loser branch and not the read path.
    should(files.calls).containEql(`link-refused:${keyFile}`);

    // It adopted the winner's key rather than its own: the bytes on disk are untouched, they are
    // not the ones this codec minted, and the tag it produces is the winner's tag. A loser that
    // signed with its own material would pass the first check and fail this one.
    should((await readFile(keyFile)).equals(winnerBytes)).be.true();
    should((await readFile(keyFile)).equals(Buffer.alloc(SESSION_MESSAGE_TOKEN_KEY_BYTES, 0x5a))).be.false();
    should(Buffer.from(loserTag).equals(Buffer.from(winnerTag))).be.true();

    // It removed its own scratch and nothing else — the stranger's file is untouched.
    should(files.calls).containEql(`discard:${join(scratch, scratchNameFor('loser'))}`);
    should(await readdir(scratch)).eql([scratchNameFor('stranger')]);
    should(await readFile(strangerScratch, 'utf8')).equal('not this writer’s bytes');
  });

  it('reuses the published key across a restart', async () => {
    // Arrange
    const { codec } = await harness('token-key-restart');
    const before = await codec().tag(INPUT);

    // Act: a brand-new codec instance, as a rebooted daemon would build.
    const after = await codec().tag(INPUT);

    // Assert
    should(Buffer.from(before).equals(Buffer.from(after))).be.true();
  });
});

describe('FileSessionTranscriptMessageTokenCodec verification', () => {
  afterEach(async () => await cleanupTempDirectories());

  it('accepts its own tag and refuses a tampered, truncated or foreign one', async () => {
    // Arrange
    const { codec } = await harness('token-key-verify');
    const subject = codec();
    const tag = Buffer.from(await subject.tag(INPUT));
    const tampered = Buffer.from(tag);
    tampered[0] = tampered[0] === 0 ? 1 : 0;

    // Act / Assert
    should(await subject.matches(INPUT, tag)).be.true();
    should(await subject.matches(OTHER_INPUT, tag)).be.false();
    should(await subject.matches(INPUT, tampered)).be.false();
    should(await subject.matches(INPUT, tag.subarray(0, 31))).be.false();
    should(await subject.matches(INPUT, Buffer.alloc(0))).be.false();
  });

  it('refuses a token issued under a key that was replaced', async () => {
    // Arrange: key loss is a durability failure, and the honest consequence is that every
    // outstanding token goes stale rather than a new key quietly accepting them.
    const { codec, keyFile } = await harness('token-key-replaced');
    const tag = await codec().tag(INPUT);
    await rm(keyFile);

    // Act: a fresh codec mints a new key because none is published any more.
    const replaced = codec();

    // Assert
    should(await replaced.matches(INPUT, tag)).be.false();
    should(Buffer.from(await replaced.tag(INPUT)).equals(Buffer.from(tag))).be.false();
  });
});

describe('FileSessionTranscriptMessageTokenCodec fail-closed', () => {
  afterEach(async () => await cleanupTempDirectories());

  it('refuses a key of the wrong length, the wrong mode, or the wrong kind of file', async () => {
    // Arrange
    const short = await harness('token-key-short');
    await writeFile(short.keyFile, Buffer.alloc(16), { mode: 0o600 });
    const loose = await harness('token-key-mode');
    await writeFile(loose.keyFile, Buffer.alloc(SESSION_MESSAGE_TOKEN_KEY_BYTES), { mode: 0o600 });
    await chmod(loose.keyFile, 0o644);
    const directory = await harness('token-key-directory');
    await mkdir(directory.keyFile, { mode: 0o700 });

    // Act / Assert: the directory case is also an ORDERING proof. The kind is decided from the open
    // handle before anything is read, so it surfaces as a key refusal; a read attempted first would
    // fail with a raw `EISDIR` instead, which is not this contract's error at all.
    should(await rejection(short.codec().tag(INPUT))).be.instanceof(SessionMessageTokenKeyError);
    should(await rejection(loose.codec().tag(INPUT))).be.instanceof(SessionMessageTokenKeyError);
    const refusedDirectory = await rejection(directory.codec().tag(INPUT));
    should(refusedDirectory).be.instanceof(SessionMessageTokenKeyError);
    should(String(refusedDirectory)).containEql('is not a regular file');
  });

  /**
   * IF THIS TEST TIMES OUT, THAT IS THE REGRESSION — not a slow or flaky host.
   *
   * A read-only open of a FIFO blocks until a writer appears. The codec's key read therefore carries
   * `O_NONBLOCK`, without which this refusal is unreachable: the open never returns, `stat()` never
   * runs, and the daemon hangs with no error, no timeout and no log line. The timeout below is
   * deliberately far tighter than any real filesystem needs, so a lost flag fails in seconds instead
   * of wedging the suite.
   *
   * The fixture PLANTS the FIFO and nothing else. Nothing in this test opens or reads it — doing so
   * would supply the very writer whose absence is the point, and would recreate the hazard here.
   *
   * It also pins the ORDER. The refusal is the key error rather than a platform errno, which is only
   * possible because the kind is decided from the open handle BEFORE any read: reading a FIFO with a
   * writer attached would block until that writer closed and consume whatever it streamed, so the
   * bytes of a non-regular file are never touched at all.
   */
  it('refuses a FIFO standing in for the key, promptly and with no writer', async () => {
    // Arrange
    const { codec, keyFile } = await harness('token-key-fifo');
    const made = Bun.spawnSync(['mkfifo', keyFile]);
    if (!made.success) throw new Error(`fixture mkfifo failed: ${new TextDecoder().decode(made.stderr)}`);

    // Act
    const error = await rejection(codec().tag(INPUT));

    // Assert
    should(error).be.instanceof(SessionMessageTokenKeyError);
    should(String(error)).containEql('is not a regular file');
  }, 2_000);

  it('refuses to sync a scratch directory that is a symlink or not a directory at all', async () => {
    // Arrange: these are raw node calls, so the state filesystem's own symlink ban never runs in
    // front of them — the open flags are the whole defence. `O_DIRECTORY | O_NOFOLLOW` refuses a
    // non-directory outright rather than following or opening it, so it cannot block either.
    const linked = await harness('token-key-linked-tmp');
    await rm(linked.scratch, { recursive: true });
    const elsewhere = await tempDirectory('token-key-tmp-target');
    await symlink(elsewhere, linked.scratch);

    const notADirectory = await harness('token-key-file-tmp');
    await rm(notADirectory.scratch, { recursive: true });
    await writeFile(notADirectory.scratch, 'not a directory');

    // Act / Assert
    should(await rejection(linked.codec().tag(INPUT))).not.be.undefined();
    should(await rejection(notADirectory.codec().tag(INPUT))).not.be.undefined();
  });

  it('refuses a symlink standing in for the key', async () => {
    // Arrange: another user's file must never be able to answer as the daemon's key.
    const { codec, keyFile, home } = await harness('token-key-symlink');
    const planted = join(home, 'planted.key');
    await writeFile(planted, Buffer.alloc(SESSION_MESSAGE_TOKEN_KEY_BYTES), { mode: 0o600 });
    await symlink(planted, keyFile);

    // Act / Assert
    should(await rejection(codec().tag(INPUT))).not.be.undefined();
  });

  it('refuses a key that was swapped between the pinned read and the return', async () => {
    // Arrange: the pinned handle proves one INODE; only the name check proves the published path
    // still means it. A writer that replaces the key in that window would otherwise be adopted, and
    // this daemon would sign with bytes the path no longer holds.
    const { codec } = await harness('token-key-swapped');
    await codec().tag(INPUT);

    // Act / Assert
    should(await rejection(codec({ files: new KeySwappingOperations() }).tag(INPUT))).be.instanceof(
      SessionMessageTokenKeyError,
    );
  });

  it('does not remember a failure, so a repaired key is picked up', async () => {
    // Arrange
    const { codec, keyFile } = await harness('token-key-repair');
    const subject = codec();
    await writeFile(keyFile, Buffer.alloc(16), { mode: 0o600 });
    await rejection(subject.tag(INPUT));

    // Act
    await rm(keyFile);
    const tag = await subject.tag(INPUT);

    // Assert
    should(tag).have.length(32);
  });

  it('publishes on a filesystem that has no directory fsync at all', async () => {
    // Arrange: a directory-only refusal, exactly as such a filesystem answers. Refusing to publish
    // there would make the daemon unusable rather than safer, and no key byte is at risk.
    for (const code of ['EINVAL', 'ENOTSUP', 'EPERM']) {
      const { codec, keyFile } = await harness(`token-key-no-dir-fsync-${code}`);

      // Act
      const tag = await codec({ files: new RecordingKeyFileOperations(refusingDirectorySync(code)) }).tag(INPUT);

      // Assert
      should(tag).have.length(32);
      should((await readFile(keyFile)).byteLength).equal(SESSION_MESSAGE_TOKEN_KEY_BYTES);
    }
  });

  it('refuses a directory fsync failure that is not a missing platform feature', async () => {
    // Arrange
    const { codec } = await harness('token-key-dir-fsync-eio');

    // Act / Assert
    should(
      await rejection(codec({ files: new RecordingKeyFileOperations(refusingDirectorySync('EIO')) }).tag(INPUT)),
    ).not.be.undefined();
  });

  it('fails the materialization when its own scratch cannot be removed', async () => {
    // Arrange: step six is not decoration. A scratch file this writer cannot delete is foreign
    // state to the layout's recovery, so the publication refuses rather than issuing tokens over it.
    const { codec } = await harness('token-key-discard-refused');

    // Act / Assert
    should(await rejection(codec({ files: new ScratchRefusingOperations() }).tag(INPUT))).not.be.undefined();
  });

  it('proceeds through the mandatory scratch-directory sync when the scratch is already gone', async () => {
    // Arrange: ENOENT is the one tolerated outcome — another writer's crash recovery may have swept
    // it — and the removal's PERSISTENCE is still established afterwards.
    const { codec, scratch } = await harness('token-key-discard-enoent');
    // Swept out from under the codec by an external cleaner AFTER the link, so the real production
    // discard meets a genuine ENOENT — the one absence it may tolerate.
    const files = new ScratchVanishingOperations();

    // Act
    const tag = await codec({ files }).tag(INPUT);

    // Assert
    should(tag).have.length(32);
    should(files.calls.at(-1)).equal(`sync-directory:${scratch}`);
  });

  it('never tolerates a refused FILE fsync, because those are the key’s own bytes', async () => {
    // Arrange
    const { codec, keyFile } = await harness('token-key-file-fsync');
    const refuseEverySync = new RecordingKeyFileOperations(async () => {
      throw Object.assign(new Error('fsync refused with EINVAL'), { code: 'EINVAL' });
    });

    // Act / Assert: the same code a DIRECTORY may answer with is still fatal for a file, and
    // nothing is published.
    should(await rejection(codec({ files: refuseEverySync }).tag(INPUT))).not.be.undefined();
    should(await rejection(stat(keyFile))).not.be.undefined();
  });
});
