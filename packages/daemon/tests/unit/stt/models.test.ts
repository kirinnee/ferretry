import { type SttInstallStatus, SttModelStatusSchema } from '@ferretry/protocol';
import { describe, it } from 'bun:test';
import should from 'should';
import {
  advanceInstall,
  BROWSER_STT_MODEL_ID,
  buildInstalledManifest,
  createFoundationPaths,
  createSttPaths,
  DAEMON_STT_MODEL_ID,
  DEFAULT_STT_MODELS,
  declaredSizeMatches,
  idleInstall,
  type InstalledModelManifest,
  modelDirectoryFor,
  parseInstalledManifest,
  planInstall,
  projectModelStatus,
  publicModelFile,
  resolveStateHome,
  type SttError,
  SttModelCatalog,
  type SttModelDefinition,
  workerModelFor,
} from '../../../src/lib/index.ts';

const catalog = new SttModelCatalog();
const daemonModel = catalog.definition(DAEMON_STT_MODEL_ID);
const browserModel = catalog.definition(BROWSER_STT_MODEL_ID);
const at = '2026-07-31T00:00:00.000Z';
const startedAtOf = (status: SttInstallStatus): string | undefined =>
  'startedAt' in status ? status.startedAt : undefined;

describe('STT model catalog', () => {
  it('should serve the pinned daemon and browser models by id and by kind', () => {
    // Assert
    should(catalog.definitionFor('daemon').id).equal(DAEMON_STT_MODEL_ID);
    should(catalog.definitionFor('browser').id).equal(BROWSER_STT_MODEL_ID);
    should(catalog.find('nope')).be.undefined();
    should(daemonModel.archive?.rootDirectory).equal('sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8');
    should(browserModel.files.every(file => file.public)).be.true();
    should(daemonModel.files.some(file => file.public)).be.false();
  });

  it('should reject an unknown model id with a stable code', () => {
    // Act
    let code = 'accepted';
    try {
      catalog.definition('parakeet-does-not-exist');
    } catch (error) {
      code = (error as SttError).code;
    }

    // Assert
    should(code).equal('model_not_found');
  });

  it('should refuse a catalog that is not exactly one daemon and one browser model', () => {
    // Arrange
    const [first] = DEFAULT_STT_MODELS;
    const duplicated = [first, first] as unknown as readonly SttModelDefinition[];
    const daemonOnly = [first] as unknown as readonly SttModelDefinition[];
    const twoBrowsers = [
      { ...browserModel, id: 'browser-a' },
      { ...browserModel, id: 'browser-b' },
      daemonModel,
    ] as readonly SttModelDefinition[];

    // Act & Assert
    should(() => new SttModelCatalog(duplicated)).throw('STT model ids must be unique');
    should(() => new SttModelCatalog(daemonOnly)).throw('exactly one browser STT model is required');
    should(() => new SttModelCatalog(twoBrowsers)).throw('exactly one browser STT model is required');
  });

  it('should report a missing kind rather than crashing when one is absent', () => {
    // Arrange — bypass the constructor guard the way a corrupted catalog would
    const empty = Object.create(SttModelCatalog.prototype) as SttModelCatalog;
    Object.defineProperty(empty, 'definitions', { value: [] });

    // Act
    let code = 'accepted';
    try {
      empty.definitionFor('daemon');
    } catch (error) {
      code = (error as SttError).code;
    }

    // Assert
    should(code).equal('model_not_found');
  });
});

describe('installed model manifest', () => {
  const manifest = buildInstalledManifest(daemonModel, at);
  const serialize = (value: unknown) => JSON.stringify(value);

  it('should round-trip a manifest it wrote itself', () => {
    // Act
    const actual = parseInstalledManifest(serialize(manifest), daemonModel);

    // Assert
    should(actual).deepEqual(manifest);
  });

  it('should accept a manifest whose files are listed in another order', () => {
    // Arrange
    const reordered: InstalledModelManifest = { ...manifest, files: [...manifest.files].reverse() };

    // Act
    const actual = parseInstalledManifest(serialize(reordered), daemonModel);

    // Assert
    should(actual?.installedAt).equal(at);
  });

  it('should reject every manifest that does not describe this exact model', () => {
    // Arrange
    const cases: Record<string, unknown> = {
      malformedJson: undefined,
      notAnObject: ['nope'],
      wrongSchema: { ...manifest, schema: 2 },
      wrongModel: { ...manifest, modelId: 'other' },
      wrongKind: { ...manifest, kind: 'browser' },
      missingDate: { ...manifest, installedAt: 42 },
      unparsableDate: { ...manifest, installedAt: 'not-a-date' },
      filesNotArray: { ...manifest, files: {} },
      fileNotObject: { ...manifest, files: ['nope'] },
      fileMissingName: { ...manifest, files: [{ bytes: 1, sha256: 'a' }] },
      fileBadBytes: { ...manifest, files: manifest.files.map(file => ({ ...file, bytes: '1' })) },
      fileBadHash: { ...manifest, files: manifest.files.map(file => ({ ...file, sha256: 1 })) },
      tooFewFiles: { ...manifest, files: manifest.files.slice(1) },
      renamedFile: {
        ...manifest,
        files: manifest.files.map((file, index) => (index === 0 ? { ...file, name: 'x' } : file)),
      },
      resizedFile: {
        ...manifest,
        files: manifest.files.map((file, index) => (index === 0 ? { ...file, bytes: 1 } : file)),
      },
      rehashedFile: {
        ...manifest,
        files: manifest.files.map((file, index) => (index === 0 ? { ...file, sha256: 'f'.repeat(64) } : file)),
      },
    };

    // Act
    const actual = Object.fromEntries(
      Object.entries(cases).map(([name, value]) => [
        name,
        parseInstalledManifest(name === 'malformedJson' ? '{not json' : serialize(value), daemonModel),
      ]),
    );

    // Assert
    should(Object.values(actual).every(value => value === undefined)).be.true();
  });
});

describe('install progress', () => {
  it('should keep the original start time as the install advances', () => {
    // Act
    const downloading = advanceInstall(
      daemonModel,
      idleInstall(daemonModel),
      {
        phase: 'downloading',
        receivedBytes: 10,
      },
      at,
    );
    const progressed = advanceInstall(
      daemonModel,
      downloading,
      { phase: 'downloading', receivedBytes: 20 },
      '2026-07-31T00:00:05.000Z',
    );
    const extracting = advanceInstall(
      daemonModel,
      progressed,
      { phase: 'extracting', receivedBytes: 20 },
      '2026-07-31T00:00:06.000Z',
    );
    const ready = advanceInstall(daemonModel, extracting, { phase: 'ready' }, '2026-07-31T00:00:07.000Z');

    // Assert
    should(startedAtOf(downloading)).equal(at);
    should(progressed.receivedBytes).equal(20);
    should(startedAtOf(progressed)).equal(at);
    should(startedAtOf(extracting)).equal(at);
    should(ready).deepEqual({
      modelId: daemonModel.id,
      phase: 'ready',
      receivedBytes: daemonModel.costs.downloadBytes,
      totalBytes: daemonModel.costs.downloadBytes,
      startedAt: at,
      finishedAt: '2026-07-31T00:00:07.000Z',
    });
  });

  it('should clamp reported progress to the pinned download size', () => {
    // Act
    const actual = advanceInstall(
      daemonModel,
      idleInstall(daemonModel),
      {
        phase: 'verifying',
        receivedBytes: Number.MAX_SAFE_INTEGER,
      },
      at,
    );

    // Assert
    should(actual.receivedBytes).equal(daemonModel.costs.downloadBytes);
  });

  it('should record a failure with its code and drop progress-only fields', () => {
    // Act
    const actual = advanceInstall(
      daemonModel,
      advanceInstall(daemonModel, idleInstall(daemonModel), { phase: 'downloading', receivedBytes: 5 }, at),
      { phase: 'failed', message: 'model download checksum mismatch', code: 'install_failed' },
      '2026-07-31T00:01:00.000Z',
    );

    // Assert
    should(actual.phase).equal('failed');
    should(actual).have.property('finishedAt', '2026-07-31T00:01:00.000Z');
    should(actual).have.property('startedAt', at);
    should(actual).have.property('code', 'install_failed');
  });
});

describe('model status projection', () => {
  const installed = { definition: daemonModel, directory: '/models/daemon', installedAt: at };
  const parse = (status: unknown) => SttModelStatusSchema.safeParse(status);

  it('should describe an installed model as ready, with its verified file list', () => {
    // Act
    const actual = projectModelStatus(
      daemonModel,
      advanceInstall(daemonModel, idleInstall(daemonModel), { phase: 'ready' }, at),
      installed,
      false,
    );

    // Assert
    should(actual.state).equal('ready');
    should(parse(actual).success).be.true();
    should(actual.state === 'ready' && actual.files).have.length(daemonModel.files.length);
    should(actual.install.phase).equal('ready');
  });

  it('should describe an installed model whose install was never observed', () => {
    // Act
    const actual = projectModelStatus(daemonModel, idleInstall(daemonModel), installed, false);

    // Assert
    should(parse(actual).success).be.true();
    should(actual.install).not.have.property('startedAt');
  });

  it('should describe an in-flight install as installing', () => {
    // Act
    const actual = projectModelStatus(
      daemonModel,
      advanceInstall(daemonModel, idleInstall(daemonModel), { phase: 'downloading', receivedBytes: 1_024 }, at),
      undefined,
      true,
    );

    // Assert
    should(actual.state).equal('installing');
    should(parse(actual).success).be.true();
  });

  it('should describe a recorded failure as an error', () => {
    // Act
    const actual = projectModelStatus(
      daemonModel,
      advanceInstall(
        daemonModel,
        idleInstall(daemonModel),
        {
          phase: 'failed',
          message: 'model download was incomplete',
          code: 'install_failed',
        },
        at,
      ),
      undefined,
      false,
    );

    // Assert
    should(actual.state).equal('error');
    should(parse(actual).success).be.true();
  });

  it('should describe an absent model as not installed, never as a stale phase', () => {
    // Arrange — an install that finished but whose files then vanished
    const stale: SttInstallStatus = advanceInstall(daemonModel, idleInstall(daemonModel), { phase: 'ready' }, at);

    // Act
    const actual = {
      idle: projectModelStatus(daemonModel, idleInstall(daemonModel), undefined, false),
      stale: projectModelStatus(daemonModel, stale, undefined, false),
      abandoned: projectModelStatus(
        daemonModel,
        advanceInstall(daemonModel, idleInstall(daemonModel), { phase: 'extracting', receivedBytes: 1 }, at),
        undefined,
        false,
      ),
    };

    // Assert
    should(actual.idle.state).equal('not-installed');
    should(actual.stale.state).equal('not-installed');
    should(actual.stale.install.phase).equal('idle');
    should(actual.abandoned.state).equal('not-installed');
    should(actual.abandoned.install.phase).equal('idle');
    should(parse(actual.stale).success).be.true();
    should(parse(actual.abandoned).success).be.true();
  });
});

describe('install planning and resolution', () => {
  it('should plan a single archive download for the daemon model', () => {
    // Act
    const actual = planInstall(daemonModel);

    // Assert
    should(actual.kind).equal('archive');
    should(actual.archiveRoot).equal('sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8');
    should(actual.downloads).have.length(1);
    should(actual.downloads[0]?.target).equal('model.tar.bz2');
  });

  it('should plan one download per browser file with cumulative progress offsets', () => {
    // Act
    const actual = planInstall(browserModel);

    // Assert
    should(actual.kind).equal('files');
    should(actual.downloads.map(download => download.target)).deepEqual(browserModel.files.map(file => file.name));
    should(actual.downloads[0]?.receivedBefore).equal(0);
    should(actual.downloads[1]?.receivedBefore).equal(browserModel.files[0]?.bytes);
    should(actual.archiveRoot).be.undefined();
  });

  it('should refuse to plan a fileset that has no source URL', () => {
    // Arrange
    const broken: SttModelDefinition = {
      ...browserModel,
      files: browserModel.files.map(file => ({ ...file, url: undefined })),
    };

    // Act
    let code = 'accepted';
    try {
      planInstall(broken);
    } catch (error) {
      code = (error as SttError).code;
    }

    // Assert
    should(code).equal('install_failed');
  });

  it('should resolve the recognizer artifacts inside the model directory', () => {
    // Act
    const actual = workerModelFor(daemonModel, '/models/parakeet');

    // Assert
    should(actual).deepEqual({
      id: daemonModel.id,
      directory: '/models/parakeet',
      encoder: '/models/parakeet/encoder.int8.onnx',
      decoder: '/models/parakeet/decoder.int8.onnx',
      joiner: '/models/parakeet/joiner.int8.onnx',
      tokens: '/models/parakeet/tokens.txt',
    });
  });

  it('should serve only public files, and only from a browser model', () => {
    // Act
    const actual = {
      allowed: publicModelFile(browserModel, 'vocab.txt')?.name,
      unknown: publicModelFile(browserModel, 'secrets.env'),
      daemonFile: publicModelFile(daemonModel, 'tokens.txt'),
    };

    // Assert
    should(actual).deepEqual({ allowed: 'vocab.txt', unknown: undefined, daemonFile: undefined });
  });

  it('should place a model directory under the models root', () => {
    // Arrange
    const paths = createSttPaths(createFoundationPaths(resolveStateHome({ fyHome: '/tmp/fy', homeDirectory: '/' })));

    // Act
    const actual = modelDirectoryFor(paths, daemonModel);

    // Assert
    should(actual).equal(`/tmp/fy/models/${daemonModel.id}`);
  });

  it('should accept an absent content-length but reject one that contradicts the manifest', () => {
    // Act
    const actual = {
      absent: declaredSizeMatches(null, 10),
      matching: declaredSizeMatches(' 10 ', 10),
      mismatched: declaredSizeMatches('11', 10),
      nonNumeric: declaredSizeMatches('ten', 10),
    };

    // Assert
    should(actual).deepEqual({ absent: true, matching: true, mismatched: false, nonNumeric: false });
  });
});
