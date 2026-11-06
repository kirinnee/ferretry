import { describe, it } from 'bun:test';
import should from 'should';
import {
  safeRelativePath,
  type TarDestination,
  UnsafeArchiveError,
  unpackTar,
} from '../../../src/lib/voice-install/index.ts';
import { chunked, tarBytes } from './support.ts';

const LIMITS = { maxBytes: 1_000_000, maxEntries: 100, strip: 1 } as const;

function destination() {
  const written = new Map<string, string>();
  const directories: string[] = [];
  const executable = new Set<string>();
  const sink: TarDestination = {
    makeDirectory: async path => void directories.push(path),
    openFile: async (path, exec) => {
      const parts: Uint8Array[] = [];
      if (exec) executable.add(path);
      return {
        write: async chunk => void parts.push(chunk.slice()),
        close: async () => void written.set(path, new TextDecoder().decode(Buffer.concat(parts))),
      };
    },
  };
  return { sink, written, directories, executable };
}

async function refusal(promise: Promise<unknown>): Promise<UnsafeArchiveError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UnsafeArchiveError) return error;
    throw error;
  }
  throw new Error('expected the archive to be refused');
}

describe('unpackTar', () => {
  it('should write files and directories under the stripped top directory, whatever the chunk size', async () => {
    // Arrange
    const tar = tarBytes([
      { name: 'top/' },
      { name: 'top/a.txt', body: 'hello' },
      { name: 'top/sub/' },
      { name: 'top/sub/b.bin', body: 'x'.repeat(1300) },
      { name: 'top/run.node', body: 'N', mode: 0o755 },
    ]);
    const out = destination();

    // Act
    const outcome = await unpackTar(chunked(tar, 333), out.sink, LIMITS);

    // Assert
    should([...out.written.keys()]).deepEqual(['a.txt', 'sub/b.bin', 'run.node']);
    should(out.written.get('sub/b.bin')?.length).equal(1300);
    should(out.directories).deepEqual(['sub']);
    should([...out.executable]).deepEqual(['run.node']);
    should(outcome.totalBytes).equal(5 + 1300 + 1);
  });

  it('should read past files the policy does not include, and count them against the cap', async () => {
    // Arrange
    const tar = tarBytes([
      { name: 'package/README.md', body: 'x'.repeat(900) },
      { name: 'package/a.node', body: 'ADDON' },
    ]);
    const out = destination();

    // Act
    const outcome = await unpackTar(chunked(tar, 512), out.sink, { ...LIMITS, include: path => path === 'a.node' });

    // Assert
    should([...out.written.keys()]).deepEqual(['a.node']);
    should(outcome.files).deepEqual([{ path: 'a.node', bytes: 5 }]);
  });

  it.each([
    ['/etc/passwd', 'absolute-path'],
    ['top/../../escape', 'parent-path'],
    ['top/a/../../../x', 'parent-path'],
    ['top//double', 'bad-path'],
    ['top\\evil', 'bad-path'],
  ])('should refuse the entry name %p as %s and write nothing', async (name, reason) => {
    // Arrange
    const out = destination();

    // Act
    const error = await refusal(unpackTar(chunked(tarBytes([{ name, body: 'x' }]), 512), out.sink, LIMITS));

    // Assert
    should(error.reason).equal(reason);
    should(out.written.size).equal(0);
  });

  it.each([
    ['symbolic link', '2', 'link'],
    ['hard link', '1', 'link'],
    ['character device', '3', 'special-file'],
    ['block device', '4', 'special-file'],
    ['FIFO', '6', 'special-file'],
  ])('should refuse a %s and never create it', async (_label, type, reason) => {
    // Arrange
    const out = destination();
    const tar = tarBytes([{ name: 'top/thing', type, linkName: '/etc/passwd' }]);

    // Act
    const error = await refusal(unpackTar(chunked(tar, 512), out.sink, LIMITS));

    // Assert
    should(error.reason).equal(reason);
    should(out.written.size + out.directories.length).equal(0);
  });

  it('should stop at the byte cap before writing the entry that crosses it', async () => {
    // Arrange — each entry is a 512-byte header and a 1,024-byte padded body: the first fits in 2,100, the second does not.
    const out = destination();
    const tar = tarBytes([
      { name: 'top/a', body: 'a'.repeat(600) },
      { name: 'top/b', body: 'b'.repeat(600) },
    ]);

    // Act
    const error = await refusal(unpackTar(chunked(tar, 512), out.sink, { ...LIMITS, maxBytes: 2100 }));

    // Assert
    should(error.reason).equal('too-large');
    should([...out.written.keys()]).deepEqual(['a']);
  });

  it('should count extended headers against both caps: ten 500-byte global headers, one entry and one byte allowed', async () => {
    // Arrange
    const out = destination();
    const tar = tarBytes(Array.from({ length: 10 }, () => ({ name: 'global-pax', type: 'g', body: 'x'.repeat(500) })));

    // Act
    const byEntries = await refusal(
      unpackTar(chunked(tar, 512), out.sink, { ...LIMITS, maxBytes: 1_000_000, maxEntries: 1 }),
    );
    const byBytes = await refusal(unpackTar(chunked(tar, 512), out.sink, { ...LIMITS, maxBytes: 1, maxEntries: 1 }));

    // Assert
    should(byEntries.reason).equal('too-many-entries');
    should(byBytes.reason).equal('too-large');
  });

  it('should count GNU long-name and pax records as entries too', async () => {
    // Arrange — five long-name records before one file: six headers in all.
    const out = destination();
    const records = Array.from({ length: 5 }, () => ({ name: '././@LongLink', type: 'L', body: 'top/long\0' }));
    const tar = tarBytes([...records, { name: 'top/a', body: 'x' }]);

    // Act
    const error = await refusal(unpackTar(chunked(tar, 512), out.sink, { ...LIMITS, maxEntries: 5 }));

    // Assert
    should(error.reason).equal('too-many-entries');
  });

  it('should bound the bytes of a directory payload, even though a directory holds no content', async () => {
    // Arrange
    const out = destination();
    const tar = tarBytes([{ name: 'top/dir/', type: '5', body: 'x'.repeat(10_000) }]);

    // Act
    const tight = await refusal(unpackTar(chunked(tar, 512), out.sink, { ...LIMITS, maxBytes: 1 }));
    const roomy = await refusal(unpackTar(chunked(tar, 512), out.sink, { ...LIMITS, maxBytes: 5_000 }));

    // Assert
    should(tight.reason).equal('too-large');
    should(roomy.reason).equal('too-large');
    should(out.directories).deepEqual([]);
  });

  it('should still unpack an archive that fits its cap exactly, headers and padding included', async () => {
    // Arrange — header 512 + body 1,024 + two 512-byte end blocks (the second is never read) = the bytes consumed.
    const out = destination();
    const tar = tarBytes([{ name: 'top/a', body: 'a'.repeat(600) }]);

    // Act
    const outcome = await unpackTar(chunked(tar, 512), out.sink, { ...LIMITS, maxBytes: 512 + 1024 + 512 });

    // Assert
    should(outcome.files).deepEqual([{ path: 'a', bytes: 600 }]);
  });

  it('should refuse more entries than the cap', async () => {
    // Arrange
    const tar = tarBytes(Array.from({ length: 5 }, (_, index) => ({ name: `top/f${String(index)}`, body: 'x' })));

    // Act
    const error = await refusal(unpackTar(chunked(tar, 512), destination().sink, { ...LIMITS, maxEntries: 3 }));

    // Assert
    should(error.reason).equal('too-many-entries');
  });

  it('should refuse an archive cut off inside an entry', async () => {
    // Arrange
    const tar = tarBytes([{ name: 'top/a', body: 'x'.repeat(2000) }]);

    // Act
    const error = await refusal(unpackTar(chunked(tar.subarray(0, 900), 300), destination().sink, LIMITS));

    // Assert
    should(error.reason).equal('truncated');
  });

  it('should honour a pax path header and a GNU long name, and check them like any other name', async () => {
    // Arrange — a pax record `path=top/long/name.txt` before a short-named entry, and a GNU `L` header.
    const record = (text: string): string => {
      const length = text.length + String(text.length).length + 2;
      const total = text.length + String(length).length + 2;
      return `${String(total)} ${text}\n`;
    };
    const pax = tarBytes([
      { name: 'PaxHeader', type: 'x', body: record('path=top/from-pax.txt') },
      { name: 'short', body: 'P' },
    ]);
    const gnu = tarBytes([
      { name: '././@LongLink', type: 'L', body: 'top/from-gnu.txt\0' },
      { name: 'short', body: 'G' },
    ]);
    const evil = tarBytes([
      { name: '././@LongLink', type: 'L', body: '../../outside\0' },
      { name: 'short', body: 'G' },
    ]);
    const first = destination();
    const second = destination();

    // Act
    await unpackTar(chunked(pax, 512), first.sink, LIMITS);
    await unpackTar(chunked(gnu, 512), second.sink, LIMITS);
    const error = await refusal(unpackTar(chunked(evil, 512), destination().sink, LIMITS));

    // Assert
    should([...first.written.keys()]).deepEqual(['from-pax.txt']);
    should([...second.written.keys()]).deepEqual(['from-gnu.txt']);
    should(error.reason).equal('parent-path');
  });

  it('should stop when the signal aborts', async () => {
    // Arrange
    const controller = new AbortController();
    controller.abort();

    // Act
    const failure = unpackTar(
      chunked(tarBytes([{ name: 'top/a', body: 'x' }]), 512),
      destination().sink,
      LIMITS,
      controller.signal,
    );

    // Assert
    await failure.then(
      () => should.fail('resolved', 'rejected'),
      error => should(error).be.instanceOf(DOMException),
    );
  });
});

/** A tar stream cut into 512-byte chunks that records whether its `finally` ran (a decompressor being stopped). */
function watched(bytes: Uint8Array, after?: () => void) {
  const state = { finalized: false };
  async function* source(): AsyncGenerator<Uint8Array> {
    try {
      for await (const chunk of chunked(bytes, 512)) {
        yield chunk;
        after?.();
      }
    } finally {
      state.finalized = true;
    }
  }
  return { source: source(), state };
}

describe('unpackTar finalizes its source', () => {
  it('should finalize it after an archive that ends normally', async () => {
    // Arrange
    const { source, state } = watched(tarBytes([{ name: 'top/a', body: 'x' }]));

    // Act
    await unpackTar(source, destination().sink, LIMITS);

    // Assert
    should(state.finalized).be.true();
  });

  it('should finalize it when an entry is refused', async () => {
    // Arrange
    const { source, state } = watched(
      tarBytes([
        { name: 'top/../../escape', body: 'x' },
        { name: 'top/b', body: 'y' },
      ]),
    );

    // Act
    const error = await refusal(unpackTar(source, destination().sink, LIMITS));

    // Assert
    should(error.reason).equal('parent-path');
    should(state.finalized).be.true();
  });

  it('should finalize it when a cap is crossed', async () => {
    // Arrange
    const { source, state } = watched(tarBytes([{ name: 'top/a', body: 'x'.repeat(5_000) }]));

    // Act
    await refusal(unpackTar(source, destination().sink, { ...LIMITS, maxBytes: 2_000 }));

    // Assert
    should(state.finalized).be.true();
  });

  it('should finalize it when the install is cancelled', async () => {
    // Arrange — the signal aborts as the first chunk has been handed over.
    const controller = new AbortController();
    const { source, state } = watched(tarBytes([{ name: 'top/a', body: 'x'.repeat(5_000) }]), () => controller.abort());

    // Act
    const failure = await unpackTar(source, destination().sink, LIMITS, controller.signal).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert
    should(failure).be.instanceOf(DOMException);
    should(state.finalized).be.true();
  });
});

describe('safeRelativePath', () => {
  it.each([
    ['top/a/b.txt', 1, 'a/b.txt'],
    ['./top/a', 1, 'a'],
    ['top/', 1, undefined],
    ['top', 1, undefined],
    ['a/b', 0, 'a/b'],
    ['top/dir/', 1, 'dir'],
  ])('should turn %p stripped by %i into %p', (name, strip, expected) => {
    should(safeRelativePath(name, strip)).equal(expected);
  });
});
