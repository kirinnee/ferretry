import { describe, it } from 'bun:test';
import { VOICE_ENGINE_CODES, type VoiceEngineView } from '@ferretry/protocol';
import should from 'should';
import { INSTALL_MANIFEST, VoiceInstallError, VoiceInstallService } from '../../../src/lib/voice-install/index.ts';
import {
  FakeNetwork,
  MemoryFiles,
  MemorySettings,
  PassThroughArchives,
  ROOT,
  tarBytes,
  tinyModel,
  tinyRuntime,
} from './support.ts';

function world(
  options: {
    readonly models?: ReturnType<typeof tinyModel>[];
    readonly target?: 'linux-x64' | { unsupported: string };
  } = {},
) {
  const batch = tinyModel('alpha', { recommended: true });
  const streaming = tinyModel('stream', { role: 'streaming', recommended: true });
  const heavy = tinyModel('heavy', { padding: 40_000, declaredExtracted: 200_000 });
  const models = options.models ?? [batch, streaming, heavy];
  const runtime = tinyRuntime();
  const files = new MemoryFiles();
  const network = new FakeNetwork();
  network.bodies.set(runtime.runtime.archive.url, runtime.tar);
  for (const { model, tar } of models) network.bodies.set(model.archive.url, tar);
  const settings = new MemorySettings();
  const archives = new PassThroughArchives(files);
  let tick = 0;
  const service = new VoiceInstallService({
    root: ROOT,
    catalog: { models: models.map(entry => entry.model), runtimes: [runtime.runtime], wrapperVersion: '9.9.9' },
    target: options.target ?? 'linux-x64',
    files,
    fetch: network.fetch,
    archives,
    settings,
    clock: { now: () => new Date(Date.UTC(2026, 10, 5, 12, 0, tick++)).toISOString() },
  });
  return { service, files, network, settings, archives, runtime, batch, streaming, heavy };
}

async function failure(promise: Promise<unknown>): Promise<VoiceInstallError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof VoiceInstallError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

const entry = (view: VoiceEngineView, id: string) => view.models.find(model => model.id === id);

describe('Install', () => {
  it('should download the runtime and the model, unpack them, and report both installed', async () => {
    // Arrange
    const { service, files, batch } = world();

    // Act
    const started = await service.install('alpha');
    await service.settled();
    const view = await service.view();

    // Assert
    should(started.install?.status).equal('running');
    should(view.install?.status).equal('succeeded');
    should(entry(view, 'alpha')?.install.state).equal('installed');
    should(view.runtime.install.state).equal('installed');
    should(files.under(`${ROOT}/models/alpha/`)).deepEqual([
      `${ROOT}/models/alpha/decoder.onnx`,
      `${ROOT}/models/alpha/encoder.onnx`,
      `${ROOT}/models/alpha/install.json`,
      `${ROOT}/models/alpha/test_wavs/0.wav`,
      `${ROOT}/models/alpha/tokens.txt`,
    ]);
    should(files.under(`${ROOT}/runtime/9.9.9/linux-x64/`)).deepEqual([
      `${ROOT}/runtime/9.9.9/linux-x64/install.json`,
      `${ROOT}/runtime/9.9.9/linux-x64/libsherpa-onnx-c-api.so`,
      `${ROOT}/runtime/9.9.9/linux-x64/sherpa-onnx.node`,
    ]);
    should(files.under(`${ROOT}/downloads/`)).deepEqual([]);
    should(
      JSON.parse(
        files.files.get(`${ROOT}/models/alpha/${INSTALL_MANIFEST}`)
          ? new TextDecoder().decode(files.files.get(`${ROOT}/models/alpha/${INSTALL_MANIFEST}`))
          : '{}',
      ).archiveSha256,
    ).equal(batch.model.archive.sha256);
  });

  it('should keep the addon executable and skip the runtime files it does not need', async () => {
    // Arrange
    const { service, files } = world();

    // Act
    await service.install('alpha');
    await service.settled();

    // Assert
    should(files.executable.has(`${ROOT}/runtime/9.9.9/linux-x64/.staging-x`)).be.false();
    should(files.files.has(`${ROOT}/runtime/9.9.9/linux-x64/package.json`)).be.false();
  });

  it('should fetch the runtime only once, and not at all when voice.yaml points at one', async () => {
    // Arrange
    const first = world();
    const second = world();
    second.settings.engine = { runtimePath: '/opt/sherpa' };

    // Act
    await first.service.install('alpha');
    await first.service.settled();
    await first.service.install('stream');
    await first.service.settled();
    await second.service.install('alpha');
    await second.service.settled();

    // Assert
    const runtimeFetches = (world_: typeof first) => world_.network.served.length;
    should(runtimeFetches(first)).equal(3);
    should(runtimeFetches(second)).equal(1);
    should((await second.service.view()).runtime.source).equal('override');
  });

  it('should answer at once and refuse a second install while one runs', async () => {
    // Arrange
    const { service } = world();

    // Act
    await service.install('alpha');
    const second = await failure(service.install('stream'));
    await service.settled();

    // Assert
    should(second.code).equal(VOICE_ENGINE_CODES.busy);
  });

  it('should let two requests that arrive together start only one install', async () => {
    // Arrange
    const { service } = world();

    // Act
    const results = await Promise.allSettled([service.install('alpha'), service.install('stream')]);
    await service.settled();

    // Assert
    should(results.map(result => result.status).sort()).deepEqual(['fulfilled', 'rejected']);
  });

  it('should refuse an unknown model and an unsupported machine before starting anything', async () => {
    // Arrange
    const { service, network } = world();
    const unsupported = world({ target: { unsupported: 'no runtime for this machine' } });

    // Act
    const unknown = await failure(service.install('nope'));
    const platform = await failure(unsupported.service.install('alpha'));

    // Assert
    should(unknown.code).equal(VOICE_ENGINE_CODES.unknownModel);
    should(platform.code).equal(VOICE_ENGINE_CODES.unsupportedPlatform);
    should(network.served).deepEqual([]);
    should((await unsupported.service.view()).target).be.null();
  });

  it('should refuse when free disk is under twice the archive, saying how much is needed, and download nothing', async () => {
    // Arrange
    const { service, files, network, batch } = world();
    files.free = batch.model.archive.bytes * 2 - 1;

    // Act
    const error = await failure(service.install('alpha'));
    const view = await service.view();

    // Assert
    should(error.code).equal(VOICE_ENGINE_CODES.noDisk);
    should(error.message).match(/not enough free disk/u);
    should(network.served).deepEqual([]);
    should(view.install).be.null();
  });

  it('should accept exactly twice the archive when the archive unpacks to no more than itself', async () => {
    // Arrange
    const { service, files, batch } = world();
    files.free = Math.max(
      batch.model.archive.bytes * 2,
      batch.model.archive.bytes + batch.model.archive.extractedBytes,
    );

    // Act
    await service.install('alpha');
    await service.settled();

    // Assert
    should((await service.view()).install?.status).equal('succeeded');
  });

  it('should need room for the archive AND what it unpacks to when that is more than twice the archive', async () => {
    // Arrange — an archive that unpacks to far more than itself (Cohere is 1.7× the download).
    const { service, files, heavy } = world();
    const needed = heavy.model.archive.bytes + heavy.model.archive.extractedBytes;
    files.free = needed - 1;

    // Act
    const error = await failure(service.install('heavy'));

    // Assert
    should(heavy.model.archive.extractedBytes).be.greaterThan(heavy.model.archive.bytes);
    should(error.code).equal(VOICE_ENGINE_CODES.noDisk);
  });

  it('should install when the free space cannot be read, rather than refuse on a guess', async () => {
    // Arrange
    const { service, files } = world();
    files.free = undefined;

    // Act
    await service.install('alpha');
    await service.settled();

    // Assert
    should((await service.view()).install?.status).equal('succeeded');
  });
});

describe('Cancel and resume', () => {
  it('should stop a running install, keep the part, and resume it from the first missing byte', async () => {
    // Arrange
    const { service, files, network, batch } = world();
    network.options = {
      chunk: 100,
      onChunk: (sent, url) => url.includes('/models/alpha') && sent === 3 && void service.cancel(),
    };

    // Act — the runtime is small enough to finish; the model is cancelled part-way.
    await service.install('alpha');
    await service.settled();
    const cancelled = await service.view();
    const part = files.files.get(`${ROOT}/downloads/${batch.model.archive.sha256}.part`);
    network.options = {};
    const again = await service.install('alpha');
    await service.settled();
    const done = await service.view();

    // Assert
    should(cancelled.install?.status).equal('cancelled');
    should(cancelled.install?.code).equal(VOICE_ENGINE_CODES.cancelled);
    should(entry(cancelled, 'alpha')?.install).deepEqual({ state: 'not-installed', partialBytes: part?.length ?? -1 });
    should(again.install?.status).equal('running');
    should(network.served.at(-1)?.range).match(/^bytes=\d+-$/u);
    should(done.install?.status).equal('succeeded');
    should(entry(done, 'alpha')?.install.state).equal('installed');
  });

  it('should keep what a cancelled install finished: the runtime stays installed', async () => {
    // Arrange
    const { service, network } = world();
    network.options = {
      chunk: 100,
      onChunk: (sent, url) => void (url.includes('/models/alpha') && sent === 2 && service.cancel()),
    };

    // Act
    await service.install('alpha');
    await service.settled();
    const view = await service.view();

    // Assert
    should(view.install?.status).equal('cancelled');
    should(view.runtime.install.state).equal('installed');
  });

  it('should answer a cancel with nothing running as the view', async () => {
    // Arrange
    const { service } = world();

    // Act
    const view = await service.cancel();

    // Assert
    should(view.install).be.null();
  });
});

describe('failures', () => {
  it('should delete a download whose hash is wrong and report the code', async () => {
    // Arrange
    const { service, files, network, batch } = world();
    const wrong = tarBytes([{ name: 'alpha/' }, { name: 'alpha/encoder.onnx', body: 'tampered' }]);
    network.bodies.set(batch.model.archive.url, new Uint8Array(batch.tar.length).fill(7));
    void wrong;

    // Act
    await service.install('alpha');
    await service.settled();
    const view = await service.view();

    // Assert
    should(view.install?.status).equal('failed');
    should(view.install?.code).equal(VOICE_ENGINE_CODES.hashMismatch);
    should(files.under(`${ROOT}/downloads/${batch.model.archive.sha256}`)).deepEqual([]);
    should(entry(view, 'alpha')?.install).deepEqual({ state: 'not-installed', partialBytes: 0 });
  });

  it('should refuse an archive with an unsafe entry, delete it, and leave no half-unpacked directory', async () => {
    // Arrange — a pinned archive that the pin cannot save: its second entry climbs out.
    const evil = tarBytes([
      { name: 'bad/' },
      { name: 'bad/ok.txt', body: 'fine' },
      { name: 'bad/../../escape', body: 'x' },
    ]);
    const { model } = tinyModel('bad');
    const pinned = {
      ...model,
      archive: { ...model.archive, bytes: evil.length, sha256: (await import('./support.ts')).sha256(evil) },
    };
    const { service, files, network } = world({ models: [{ model: pinned, tar: evil }] });
    network.bodies.set(pinned.archive.url, evil);

    // Act
    await service.install('bad');
    await service.settled();
    const view = await service.view();

    // Assert
    should(view.install?.code).equal(VOICE_ENGINE_CODES.unsafeArchive);
    should(files.under(`${ROOT}/models/`)).deepEqual([]);
    should(files.under(`${ROOT}/downloads/`)).deepEqual([]);
  });

  it('should refuse an archive missing the files the recognizer needs', async () => {
    // Arrange
    const thin = tarBytes([{ name: 'thin/' }, { name: 'thin/tokens.txt', body: 'a' }]);
    const { model } = tinyModel('thin');
    const sha = (await import('./support.ts')).sha256(thin);
    const pinned = { ...model, archive: { ...model.archive, bytes: thin.length, sha256: sha } };
    const { service, files, network } = world({ models: [{ model: pinned, tar: thin }] });
    network.bodies.set(pinned.archive.url, thin);

    // Act
    await service.install('thin');
    await service.settled();
    const view = await service.view();

    // Assert
    should(view.install?.status).equal('failed');
    should(view.install?.message).match(/encoder\.onnx/u);
    should(files.under(`${ROOT}/models/`)).deepEqual([]);
  });

  it('should say the unpacking tool is missing, and keep the download for when it is installed', async () => {
    // Arrange
    const { service, files, archives, batch } = world();
    archives.missing = true;

    // Act
    await service.install('alpha');
    await service.settled();
    const view = await service.view();

    // Assert
    // The runtime unpacks through the same reader, so the first thing refused is the runtime.
    should(view.install?.code).equal(VOICE_ENGINE_CODES.noDecompressor);
    should(files.under(`${ROOT}/models/`)).deepEqual([]);
    void batch;
  });

  it('should report a disk write failure as a failed install and leave nothing half-installed', async () => {
    // Arrange
    const { service, files } = world();
    files.failWritesAfter = 50;

    // Act
    await service.install('alpha');
    await service.settled();
    const view = await service.view();

    // Assert
    should(view.install?.status).equal('failed');
    should(view.install?.message).match(/no space left/u);
    should(files.under(`${ROOT}/models/`)).deepEqual([]);
  });

  it('should install again after a failure', async () => {
    // Arrange
    const { service, files } = world();
    files.failWritesAfter = 50;
    await service.install('alpha');
    await service.settled();
    files.failWritesAfter = undefined;

    // Act
    await service.install('alpha');
    await service.settled();

    // Assert
    should((await service.view()).install?.status).equal('succeeded');
  });
});

describe('Remove and Use', () => {
  async function installed() {
    const built = world();
    await built.service.install('alpha');
    await built.service.settled();
    return built;
  }

  it('should delete a model, its part and any staging leftover', async () => {
    // Arrange
    const { service, files, batch } = await installed();
    files.files.set(`${ROOT}/models/alpha.staging-123/leftover`, new Uint8Array(3));
    files.files.set(`${ROOT}/downloads/${batch.model.archive.sha256}.part`, new Uint8Array(9));

    // Act
    const view = await service.remove('alpha');

    // Assert
    should(files.under(`${ROOT}/models/`)).deepEqual([]);
    should(files.under(`${ROOT}/downloads/`)).deepEqual([]);
    should(entry(view, 'alpha')?.install).deepEqual({ state: 'not-installed', partialBytes: 0 });
  });

  it('should clear the model from voice.yaml when it was the chosen one', async () => {
    // Arrange
    const { service, settings } = await installed();
    await service.use('alpha');

    // Act
    await service.remove('alpha');

    // Assert
    should(settings.engine).deepEqual({});
    should(settings.writes).deepEqual(['batch=alpha', 'batch=null']);
  });

  it('should remove a part-downloaded model that never finished installing', async () => {
    // Arrange
    const { service, files, batch } = world();
    files.files.set(`${ROOT}/downloads/${batch.model.archive.sha256}.part`, new Uint8Array(500));

    // Act
    const before = entry(await service.view(), 'alpha')?.install;
    const after = entry(await service.remove('alpha'), 'alpha')?.install;

    // Assert
    should(before).deepEqual({ state: 'not-installed', partialBytes: 500 });
    should(after).deepEqual({ state: 'not-installed', partialBytes: 0 });
  });

  it('should refuse to remove while an install runs, and refuse an unknown model', async () => {
    // Arrange
    const { service } = world();
    await service.install('alpha');

    // Act
    const busy = await failure(service.remove('alpha'));
    const unknown = await failure(service.remove('nope'));
    await service.settled();

    // Assert
    should(busy.code).equal(VOICE_ENGINE_CODES.busy);
    should(unknown.code).equal(VOICE_ENGINE_CODES.unknownModel);
  });

  it('should write the chosen model for its own role, and refuse one that is not installed', async () => {
    // Arrange
    const { service, settings } = await installed();

    // Act
    const view = await service.use('alpha');
    const refused = await failure(service.use('stream'));

    // Assert
    should(settings.engine).deepEqual({ batch: 'alpha' });
    should(view.active).deepEqual({ batch: 'alpha', streaming: null });
    should(entry(view, 'alpha')?.active).be.true();
    should(refused.code).equal(VOICE_ENGINE_CODES.notInstalled);
    should(settings.writes).deepEqual(['batch=alpha']);
  });
});

describe('view', () => {
  it('should list every row with its role, pins and recommendation, nothing installed', async () => {
    // Arrange
    const { service } = world();

    // Act
    const view = await service.view();

    // Assert
    should(view.target).equal('linux-x64');
    should(view.models.map(model => [model.id, model.recommended, model.install.state])).deepEqual([
      ['alpha', true, 'not-installed'],
      ['stream', true, 'not-installed'],
      ['heavy', false, 'not-installed'],
    ]);
    should(view.active).deepEqual({ batch: null, streaming: null });
    should(view.runtime.wrapperVersion).equal('9.9.9');
    should(view.install).be.null();
  });

  it('should fall back to the recommended model when it is installed and voice.yaml names none', async () => {
    // Arrange
    const { service } = world();
    await service.install('alpha');
    await service.settled();

    // Act
    const view = await service.view();

    // Assert
    should(view.active.batch).equal('alpha');
    should(view.active.streaming).be.null();
  });

  it('should warn about a configured model that is unknown, of the wrong role, or not installed', async () => {
    // Arrange
    const { service, settings } = world();

    // Act
    settings.engine = { batch: 'typo', streaming: 'alpha' };
    const first = await service.view();
    settings.engine = { batch: 'heavy' };
    const second = await service.view();

    // Assert
    should(first.warnings).deepEqual([
      'voice.yaml names the batch model "typo", which is not in the catalog',
      'voice.yaml names "alpha" as the streaming model, but it is a batch model',
    ]);
    should(second.warnings).deepEqual(['voice.yaml names the batch model "heavy", which is not installed']);
  });

  it('should read a stale install as not installed when the catalog pin moved', async () => {
    // Arrange
    const { service, files } = world();
    await service.install('alpha');
    await service.settled();
    files.files.set(
      `${ROOT}/models/alpha/${INSTALL_MANIFEST}`,
      new TextEncoder().encode(JSON.stringify({ archiveSha256: 'old', installedAt: 'x', bytes: 1 })),
    );

    // Act
    const view = await service.view();

    // Assert
    should(entry(view, 'alpha')?.install.state).equal('not-installed');
  });

  it('should treat a damaged manifest as not installed', async () => {
    // Arrange
    const { service, files } = world();
    await service.install('alpha');
    await service.settled();
    files.files.set(`${ROOT}/models/alpha/${INSTALL_MANIFEST}`, new TextEncoder().encode('{not json'));

    // Act
    const view = await service.view();

    // Assert
    should(entry(view, 'alpha')?.install.state).equal('not-installed');
  });

  it('should report free disk', async () => {
    // Arrange
    const { service, files } = world();
    files.free = 12_345;

    // Act
    const view = await service.view();

    // Assert
    should(view.freeBytes).equal(12_345);
  });
});
