import { afterEach, beforeEach, describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  BunCommandRunner,
  type SttCommandResult,
  type SttCommandRunner,
  SttModelStore,
  type SttModelStoreOptions,
} from '../../../src/adapters/index.ts';
import {
  createFoundationPaths,
  createSttPaths,
  resolveStateHome,
  type SttError,
  SttModelCatalog,
  type SttModelDefinition,
  type SttPaths,
} from '../../../src/lib/index.ts';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const encode = (text: string) => new TextEncoder().encode(text);

const VOCAB = encode('hello\nworld\n');
const WEIGHTS = encode('fake onnx weights');

/** A tiny two-file browser model, so an install is a few bytes, never 600 MB. */
function browserFixture(): SttModelDefinition {
  return {
    id: 'browser-fixture',
    kind: 'browser',
    label: 'Browser fixture',
    languages: ['en'],
    costs: {
      downloadBytes: VOCAB.byteLength + WEIGHTS.byteLength,
      diskBytes: VOCAB.byteLength + WEIGHTS.byteLength,
      ramBytesApprox: 1_024,
      summary: 'a few bytes',
    },
    files: [
      {
        name: 'vocab.txt',
        bytes: VOCAB.byteLength,
        sha256: sha256(VOCAB),
        url: 'https://models.invalid/vocab.txt',
        mime: 'text/plain; charset=utf-8',
        public: true,
      },
      {
        name: 'nested/weights.onnx',
        bytes: WEIGHTS.byteLength,
        sha256: sha256(WEIGHTS),
        url: 'https://models.invalid/weights.onnx',
        mime: 'application/octet-stream',
        public: false,
      },
    ],
  };
}

const TOKENS = encode('tokens\n');
const ENCODER = encode('encoder');
const DECODER = encode('decoder');
const JOINER = encode('joiner');

/** A tiny archive-based daemon model; the archive is built with real tar. */
function daemonFixture(archiveBytes: number, archiveSha: string): SttModelDefinition {
  return {
    id: 'daemon-fixture',
    kind: 'daemon',
    label: 'Daemon fixture',
    languages: ['en'],
    costs: { downloadBytes: archiveBytes, diskBytes: archiveBytes, ramBytesApprox: 1_024, summary: 'a few bytes' },
    archive: {
      url: 'https://models.invalid/model.tar.bz2',
      bytes: archiveBytes,
      sha256: archiveSha,
      rootDirectory: 'model-root',
    },
    files: [
      {
        name: 'encoder.int8.onnx',
        bytes: ENCODER.byteLength,
        sha256: sha256(ENCODER),
        mime: 'application/octet-stream',
        public: false,
      },
      {
        name: 'decoder.int8.onnx',
        bytes: DECODER.byteLength,
        sha256: sha256(DECODER),
        mime: 'application/octet-stream',
        public: false,
      },
      {
        name: 'joiner.int8.onnx',
        bytes: JOINER.byteLength,
        sha256: sha256(JOINER),
        mime: 'application/octet-stream',
        public: false,
      },
      {
        name: 'tokens.txt',
        bytes: TOKENS.byteLength,
        sha256: sha256(TOKENS),
        mime: 'text/plain; charset=utf-8',
        public: false,
      },
    ],
  };
}

function bodyOf(bytes: Uint8Array, headers: Record<string, string> = {}): Response {
  return new Response(bytes, { headers: { 'content-length': String(bytes.byteLength), ...headers } });
}

class RecordingRunner implements SttCommandRunner {
  readonly argv: string[][] = [];

  constructor(private readonly delegate: SttCommandRunner = new BunCommandRunner()) {}

  async run(argv: readonly string[], timeoutMs: number): Promise<SttCommandResult> {
    this.argv.push([...argv]);
    return await this.delegate.run(argv, timeoutMs);
  }
}

let home: string;
let paths: SttPaths;
let clockTicks: number;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'fy-stt-store-'));
  paths = createSttPaths(createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home })));
  clockTicks = 0;
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

let uniqueCounter = 0;

function store(
  definitions: readonly SttModelDefinition[],
  overrides: Partial<SttModelStoreOptions> = {},
): SttModelStore {
  return new SttModelStore({
    paths,
    catalog: new SttModelCatalog(definitions),
    fetch: async () => new Response(null, { status: 404 }),
    runner: new BunCommandRunner(),
    now: () => new Date(Date.UTC(2026, 6, 31, 0, 0, clockTicks++)).toISOString(),
    uniqueId: () => {
      uniqueCounter += 1;
      return `id-${uniqueCounter}`;
    },
    ...overrides,
  });
}

/** Build a real bzip2 tar of a model-root directory and return its bytes. */
async function buildArchive(): Promise<Uint8Array> {
  const scratch = await mkdtemp(join(tmpdir(), 'fy-stt-archive-'));
  try {
    const root = join(scratch, 'model-root');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'encoder.int8.onnx'), ENCODER);
    await writeFile(join(root, 'decoder.int8.onnx'), DECODER);
    await writeFile(join(root, 'joiner.int8.onnx'), JOINER);
    await writeFile(join(root, 'tokens.txt'), TOKENS);
    const archive = join(scratch, 'model.tar.bz2');
    const built = await new BunCommandRunner().run(['tar', '-cjf', archive, '-C', scratch, 'model-root'], 30_000);
    should(built.code).equal(0);
    return new Uint8Array(await readFile(archive));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const browser = browserFixture();

async function failureOf(act: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await act();
  } catch (error) {
    const failure = error as SttError;
    return { code: failure.code, message: failure.message };
  }
  throw new Error('expected the install to fail');
}

describe('model store installation', () => {
  it('should install a fileset model, verify it, and report it ready', async () => {
    // Arrange
    const daemon = daemonFixture(1, 'f'.repeat(64));
    const served = new Map([
      ['https://models.invalid/vocab.txt', VOCAB],
      ['https://models.invalid/weights.onnx', WEIGHTS],
    ]);
    const subject = store([browser, daemon], {
      fetch: async url => bodyOf(served.get(url) ?? new Uint8Array(0)),
    });

    // Act
    const actual = await subject.install(browser.id);

    // Assert
    should(actual.state).equal('ready');
    should(actual.install.phase).equal('ready');
    should(await readFile(join(paths.models, browser.id, 'vocab.txt'), 'utf8')).equal('hello\nworld\n');
    should(await readFile(join(paths.models, browser.id, 'nested/weights.onnx'), 'utf8')).equal('fake onnx weights');
    should((await subject.inspect(browser.id))?.directory).equal(join(paths.models, browser.id));
  });

  it('should install an archive model by extracting its pinned root directory', async () => {
    // Arrange
    const bytes = await buildArchive();
    const daemon = daemonFixture(bytes.byteLength, sha256(bytes));
    const runner = new RecordingRunner();
    const subject = store([browser, daemon], { fetch: async () => bodyOf(bytes), runner });

    // Act
    const actual = await subject.install(daemon.id);

    // Assert
    should(actual.state).equal('ready');
    should(runner.argv[0]?.slice(0, 2)).deepEqual(['tar', '-xjf']);
    should(await readFile(join(paths.models, daemon.id, 'tokens.txt'), 'utf8')).equal('tokens\n');
    should(await subject.resolveDaemonModel()).deepEqual({
      id: daemon.id,
      directory: join(paths.models, daemon.id),
      encoder: join(paths.models, daemon.id, 'encoder.int8.onnx'),
      decoder: join(paths.models, daemon.id, 'decoder.int8.onnx'),
      joiner: join(paths.models, daemon.id, 'joiner.int8.onnx'),
      tokens: join(paths.models, daemon.id, 'tokens.txt'),
    });
  });

  it('should replace an existing installation and keep the old tree until the swap lands', async () => {
    // Arrange
    const daemon = daemonFixture(1, 'f'.repeat(64));
    const served = new Map([
      ['https://models.invalid/vocab.txt', VOCAB],
      ['https://models.invalid/weights.onnx', WEIGHTS],
    ]);
    const subject = store([browser, daemon], { fetch: async url => bodyOf(served.get(url) ?? new Uint8Array(0)) });
    await subject.install(browser.id);
    await writeFile(join(paths.models, browser.id, 'vocab.txt'), encode('corrupted!!\n'));

    // Act — the corrupted file makes the model not-installed, so a reinstall runs
    const before = await subject.modelStatus(browser.id);
    const reinstalled = store([browser, daemon], {
      fetch: async url => bodyOf(served.get(url) ?? new Uint8Array(0)),
    });
    const actual = await reinstalled.install(browser.id);

    // Assert
    should(before.state).equal('not-installed');
    should(actual.state).equal('ready');
    should(await readFile(join(paths.models, browser.id, 'vocab.txt'), 'utf8')).equal('hello\nworld\n');
  });

  it('should start an install once no matter how many callers ask', async () => {
    // Arrange
    const daemon = daemonFixture(1, 'f'.repeat(64));
    let fetches = 0;
    const subject = store([browser, daemon], {
      fetch: async url => {
        fetches += 1;
        await Bun.sleep(5);
        return bodyOf(url.endsWith('vocab.txt') ? VOCAB : WEIGHTS);
      },
    });

    // Act
    const [first, second, third] = await Promise.all([
      subject.startInstall(browser.id),
      subject.startInstall(browser.id),
      subject.startInstall(browser.id),
    ]);
    const finished = await subject.install(browser.id);

    // Assert
    should([first?.started, second?.started, third?.started].filter(Boolean)).have.length(1);
    should(fetches).equal(browser.files.length);
    should(finished.state).equal('ready');
    should((await subject.startInstall(browser.id)).started).be.false();
  });

  it('should report installing while the download is in flight', async () => {
    // Arrange
    const daemon = daemonFixture(1, 'f'.repeat(64));
    let release = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const subject = store([browser, daemon], {
      fetch: async url => {
        await gate;
        return bodyOf(url.endsWith('vocab.txt') ? VOCAB : WEIGHTS);
      },
    });

    // Act
    const started = await subject.startInstall(browser.id);
    const during = await subject.modelStatus(browser.id);
    release();
    const finished = await subject.install(browser.id);

    // Assert
    should(started.started).be.true();
    should(started.status.state).equal('installing');
    should(during.state).equal('installing');
    should(finished.state).equal('ready');
  });
});

describe('model store failure handling', () => {
  const daemon = daemonFixture(1, 'f'.repeat(64));

  it('should record every download failure as an install error with its reason', async () => {
    // Arrange
    const cases: Record<string, Partial<SttModelStoreOptions>> = {
      httpError: { fetch: async () => new Response('nope', { status: 500 }) },
      transportError: {
        fetch: async () => {
          throw new Error('econnrefused');
        },
      },
      sizeMismatch: { fetch: async () => new Response(VOCAB, { headers: { 'content-length': '9999' } }) },
      shortBody: { fetch: async () => new Response(encode('short')) },
      oversizedBody: {
        fetch: async () => new Response(encode('far too much data'), { headers: {} }),
      },
      checksumMismatch: {
        fetch: async () => new Response(encode('hello\nworl!\n'), { headers: {} }),
      },
      bodilessResponse: { fetch: async () => new Response(null, { status: 204 }) },
    };

    // Act
    const actual: Record<string, string> = {};
    for (const [name, overrides] of Object.entries(cases)) {
      const subject = store([browser, daemon], overrides);
      actual[name] = (await failureOf(() => subject.install(browser.id))).message;
      const status = await subject.modelStatus(browser.id);
      should(status.state).equal('error');
    }

    // Assert
    should(actual.httpError).equal('model download failed with HTTP 500');
    should(actual.transportError).equal('model download failed: econnrefused');
    should(actual.sizeMismatch).equal('model download size does not match the pinned manifest');
    should(actual.shortBody).equal('model download was incomplete');
    should(actual.oversizedBody).equal('model download exceeded its pinned size');
    should(actual.checksumMismatch).equal('model download checksum mismatch');
    should(actual.bodilessResponse).equal('model download failed with HTTP 204');
  });

  it('should abandon a download that stops making progress', async () => {
    // Arrange
    const subject = store([browser, daemon], {
      stallTimeoutMs: 25,
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              controller.enqueue(encode('he'));
              await Bun.sleep(2_000);
            },
          }),
        ),
    });

    // Act
    const actual = await failureOf(() => subject.install(browser.id));

    // Assert
    should(actual).deepEqual({ code: 'install_failed', message: 'model download stalled' });
  });

  it('should give up on a stream whose cancellation never settles', async () => {
    // Arrange — pull() and cancel() both hang, the worst case for the reader
    const subject = store([browser, daemon], {
      stallTimeoutMs: 25,
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              controller.enqueue(encode('he'));
              await Bun.sleep(10_000);
            },
            cancel: async () => {
              await Bun.sleep(10_000);
            },
          }),
        ),
    });

    // Act — the install must settle on its own, well inside the stream's stall
    const actual = await Promise.race([
      failureOf(() => subject.install(browser.id)),
      Bun.sleep(2_000).then(() => 'still pending'),
    ]);

    // Assert
    should(actual).deepEqual({ code: 'install_failed', message: 'model download stalled' });
    should((await subject.modelStatus(browser.id)).state).equal('error');
    should((await subject.startInstall(browser.id)).started).be.true();
  });

  it('should fail the install when extraction fails or the archive has another layout', async () => {
    // Arrange
    const bytes = await buildArchive();
    const archived = daemonFixture(bytes.byteLength, sha256(bytes));
    const failing: SttCommandRunner = { run: async () => ({ code: 2, stdout: '', stderr: 'tar: bad magic' }) };
    const silent: SttCommandRunner = { run: async () => ({ code: 0, stdout: '', stderr: '' }) };

    // Act
    const extraction = await failureOf(() =>
      store([browser, archived], { fetch: async () => bodyOf(bytes), runner: failing }).install(archived.id),
    );
    const layout = await failureOf(() =>
      store([browser, archived], { fetch: async () => bodyOf(bytes), runner: silent }).install(archived.id),
    );

    // Assert
    should(extraction.message).equal('model extraction failed: tar: bad magic');
    should(layout.message).equal('model archive has an unexpected layout');
  });

  it('should fail verification when an extracted file is missing or altered', async () => {
    // Arrange
    const bytes = await buildArchive();
    const archived = daemonFixture(bytes.byteLength, sha256(bytes));
    const truncating: SttCommandRunner = {
      run: async (argv, timeoutMs) => {
        const result = await new BunCommandRunner().run(argv, timeoutMs);
        await writeFile(join(String(argv[4]), 'model-root', 'tokens.txt'), encode('x'.repeat(TOKENS.byteLength)));
        return result;
      },
    };
    const removing: SttCommandRunner = {
      run: async (argv, timeoutMs) => {
        const result = await new BunCommandRunner().run(argv, timeoutMs);
        await rm(join(String(argv[4]), 'model-root', 'tokens.txt'));
        return result;
      },
    };

    // Act
    const altered = await failureOf(() =>
      store([browser, archived], { fetch: async () => bodyOf(bytes), runner: truncating }).install(archived.id),
    );
    const missing = await failureOf(() =>
      store([browser, archived], { fetch: async () => bodyOf(bytes), runner: removing }).install(archived.id),
    );

    // Assert
    should(altered.message).equal('installed model checksum mismatch: tokens.txt');
    should(missing.message).equal('installed model file is missing or has the wrong size: tokens.txt');
  });

  it('should refuse to plan a fileset install whose files have no URL', async () => {
    // Arrange
    const urlless: SttModelDefinition = { ...browser, files: browser.files.map(file => ({ ...file, url: undefined })) };

    // Act
    const actual = await failureOf(() => store([urlless, daemon]).install(urlless.id));

    // Assert
    should(actual).deepEqual({ code: 'install_failed', message: 'no source URL for vocab.txt' });
  });

  it('should surface an unexpected filesystem failure as an install error', async () => {
    // Arrange
    const subject = store([browser, daemon], {
      fetch: async url => bodyOf(url.endsWith('vocab.txt') ? VOCAB : WEIGHTS),
    });
    await mkdir(paths.models, { recursive: true, mode: 0o700 });
    await chmod(paths.models, 0o500);

    // Act
    const actual = await failureOf(() => subject.install(browser.id));

    // Assert
    await chmod(paths.models, 0o700);
    should(actual.code).equal('install_failed');
  });
});

describe('model store inspection', () => {
  const daemon = daemonFixture(1, 'f'.repeat(64));

  async function installed(): Promise<SttModelStore> {
    const subject = store([browser, daemon], {
      fetch: async url => bodyOf(url.endsWith('vocab.txt') ? VOCAB : WEIGHTS),
    });
    await subject.install(browser.id);
    return subject;
  }

  it('should treat an absent, unreadable, or foreign manifest as not installed', async () => {
    // Arrange
    const subject = store([browser, daemon]);
    const directory = join(paths.models, browser.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });

    // Act
    const absent = await subject.inspect(browser.id);
    await writeFile(join(directory, '.stt-model.json'), '{ not json');
    const malformed = await subject.inspect(browser.id);
    await writeFile(join(directory, '.stt-model.json'), JSON.stringify({ schema: 1, modelId: 'other' }));
    const foreign = await subject.inspect(browser.id);

    // Assert
    should([absent, malformed, foreign]).deepEqual([undefined, undefined, undefined]);
    should((await subject.modelStatus(browser.id)).state).equal('not-installed');
  });

  it('should re-hash a file only when its identity changes', async () => {
    // Arrange
    const subject = await installed();

    // Act
    const first = await subject.inspect(browser.id);
    const second = await subject.inspect(browser.id);
    await writeFile(join(paths.models, browser.id, 'vocab.txt'), encode('hello\nworl!\n'));
    const afterEdit = await subject.inspect(browser.id);

    // Assert
    should(first?.installedAt).equal(second?.installedAt);
    should(afterEdit).be.undefined();
  });

  it('should refuse a model file that has become a symlink', async () => {
    // Arrange
    const subject = await installed();
    const target = join(paths.models, browser.id, 'vocab.txt');
    const outside = join(home, 'elsewhere.txt');
    await writeFile(outside, VOCAB);
    await rm(target);
    await symlink(outside, target);

    // Act
    const actual = await subject.inspect(browser.id);

    // Assert
    should(actual).be.undefined();
  });

  it('should serve only public files of an installed browser model', async () => {
    // Arrange
    const subject = await installed();

    // Act
    const actual = {
      allowed: await subject.resolvePublicFile(browser.id, 'vocab.txt'),
      private: await subject.resolvePublicFile(browser.id, 'nested/weights.onnx'),
      unknownFile: await subject.resolvePublicFile(browser.id, 'passwd'),
      unknownModel: await subject.resolvePublicFile('not-a-model', 'vocab.txt'),
      daemonModel: await subject.resolvePublicFile(daemon.id, 'tokens.txt'),
    };

    // Assert
    should(actual.allowed?.path).equal(join(paths.models, browser.id, 'vocab.txt'));
    should(actual.allowed?.definition.mime).equal('text/plain; charset=utf-8');
    should(actual.private).be.undefined();
    should(actual.unknownFile).be.undefined();
    should(actual.unknownModel).be.undefined();
    should(actual.daemonModel).be.undefined();
  });

  it('should not serve a public file once the installation stops verifying', async () => {
    // Arrange
    const subject = await installed();
    const directory = join(paths.models, browser.id);

    // Act
    await writeFile(join(directory, 'vocab.txt'), encode('longer than before\n'));
    const resized = await subject.resolvePublicFile(browser.id, 'vocab.txt');
    await rm(join(directory, '.stt-model.json'));
    const unmanifested = await subject.resolvePublicFile(browser.id, 'vocab.txt');

    // Assert
    should(resized).be.undefined();
    should(unmanifested).be.undefined();
  });

  it('should report both catalog entries and the daemon model only when installed', async () => {
    // Arrange
    const subject = await installed();

    // Act
    const actual = await subject.inventory();

    // Assert
    should(actual.browser.state).equal('ready');
    should(actual.daemon.state).equal('not-installed');
    should(await subject.resolveDaemonModel()).be.undefined();
    should(subject.definition(browser.id).id).equal(browser.id);
    should(subject.installStatus(daemon.id).phase).equal('idle');
  });
});

describe('bun command runner', () => {
  it('should report the exit code, stdout, and stderr of a real command', async () => {
    // Act
    const actual = await new BunCommandRunner().run(['sh', '-c', 'echo out; echo err >&2; exit 3'], 30_000);

    // Assert
    should(actual.code).equal(3);
    should(actual.stdout.trim()).equal('out');
    should(actual.stderr.trim()).equal('err');
  });
});
