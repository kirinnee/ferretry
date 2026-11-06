import { afterAll, describe, it } from 'bun:test';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import should from 'should';
import { NodeVoiceInstallFiles, SystemVoiceArchiveReader } from '../../../src/adapters/voice-install/index.ts';
import { NoDecompressorError, VoiceInstallService } from '../../../src/lib/voice-install/index.ts';
import {
  archiveOf,
  FakeNetwork,
  MemorySettings,
  sha256,
  tarBytes,
  tinyModel,
  tinyRuntime,
} from '../../unit/voice-install/support.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

afterAll(cleanupTempDirectories);

/** A real `bzip2` compressing `bytes` — fixture setup only, never the adapter under test. */
async function bzip2(bytes: Uint8Array): Promise<Uint8Array> {
  const child = Bun.spawn(['bzip2', '-c'], { stdin: new Blob([bytes]), stdout: 'pipe', stderr: 'pipe' });
  const [code, out] = await Promise.all([child.exited, new Response(child.stdout).arrayBuffer()]);
  if (code !== 0) throw new Error('bzip2 failed');
  return new Uint8Array(out);
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of stream) parts.push(chunk.slice());
  return new Uint8Array(Buffer.concat(parts));
}

describe('the speech engine files on a real disk', () => {
  it('should append, truncate, size, list, rename and remove', async () => {
    // Arrange
    const root = await tempDirectory('voice-files');
    const files = new NodeVoiceInstallFiles();
    const part = path.join(root, 'downloads', 'x.part');

    // Act
    const first = await files.openAppend(part, { truncate: false });
    await first.write(new TextEncoder().encode('abc'));
    await first.close();
    const second = await files.openAppend(part, { truncate: false });
    await second.write(new TextEncoder().encode('def'));
    await second.close();
    const appended = await readFile(part, 'utf8');
    const restart = await files.openAppend(part, { truncate: true });
    await restart.write(new TextEncoder().encode('Z'));
    await restart.close();

    // Assert
    should(appended).equal('abcdef');
    should(await files.size(part)).equal(1);
    should(await files.size(path.join(root, 'missing'))).be.undefined();
    should(await files.list(path.join(root, 'downloads'))).deepEqual(['x.part']);
    should(await files.list(path.join(root, 'nothing'))).deepEqual([]);
    await files.rename(path.join(root, 'downloads'), path.join(root, 'moved', 'downloads'));
    should(await files.size(path.join(root, 'moved', 'downloads', 'x.part'))).equal(1);
    await files.remove(path.join(root, 'moved'));
    await files.remove(path.join(root, 'moved'));
    should(await files.size(path.join(root, 'moved', 'downloads', 'x.part'))).be.undefined();
  });

  it('should create owner-only directories and files, executable only when asked', async () => {
    // Arrange
    const root = await tempDirectory('voice-modes');
    const files = new NodeVoiceInstallFiles();

    // Act
    const plain = await files.openStaged(path.join(root, 'a', 'plain.bin'), { executable: false });
    await plain.close();
    const exec = await files.openStaged(path.join(root, 'a', 'run.node'), { executable: true });
    await exec.close();

    // Assert
    should((await stat(path.join(root, 'a'))).mode & 0o777).equal(0o700);
    should((await stat(path.join(root, 'a', 'plain.bin'))).mode & 0o777).equal(0o600);
    should((await stat(path.join(root, 'a', 'run.node'))).mode & 0o777).equal(0o700);
  });

  it('should refuse to write a staged file twice, so two entries cannot share a path', async () => {
    // Arrange
    const root = await tempDirectory('voice-twice');
    const files = new NodeVoiceInstallFiles();
    await (await files.openStaged(path.join(root, 'same'), { executable: false })).close();

    // Act
    const again = files.openStaged(path.join(root, 'same'), { executable: false });

    // Assert
    await again.then(
      () => should.fail('resolved', 'rejected'),
      error => should((error as NodeJS.ErrnoException).code).equal('EEXIST'),
    );
  });

  it('should report free space for a directory that does not exist yet, from its nearest parent', async () => {
    // Arrange
    const root = await tempDirectory('voice-free');

    // Act
    const free = await new NodeVoiceInstallFiles().freeBytes(path.join(root, 'not', 'yet', 'here'));

    // Assert
    should(free).be.a.Number().and.greaterThan(0);
  });
});

describe('the archive reader with the real decompressors', () => {
  it('should gunzip a .tgz and bunzip a .tar.bz2 to the same tar stream', async () => {
    // Arrange
    const root = await tempDirectory('voice-archives');
    const tar = tarBytes([{ name: 'top/' }, { name: 'top/a.txt', body: 'hello' }]);
    const tgz = path.join(root, 'a.tgz');
    const bz = path.join(root, 'a.tar.bz2');
    await Bun.write(tgz, gzipSync(tar));
    await Bun.write(bz, await bzip2(tar));
    const reader = new SystemVoiceArchiveReader();
    const signal = new AbortController().signal;

    // Act
    const fromGzip = await collect(reader.tarStream(tgz, 'tgz', signal));
    const fromBzip = await collect(reader.tarStream(bz, 'tar.bz2', signal));

    // Assert
    should(sha256(fromGzip)).equal(sha256(tar));
    should(sha256(fromBzip)).equal(sha256(tar));
  });

  it('should fail loudly on a file that is not bzip2, rather than yield nothing', async () => {
    // Arrange
    const root = await tempDirectory('voice-notbz');
    const bad = path.join(root, 'bad.tar.bz2');
    await Bun.write(bad, 'this is not bzip2');

    // Act
    const failure = collect(new SystemVoiceArchiveReader().tarStream(bad, 'tar.bz2', new AbortController().signal));

    // Assert
    await failure.then(
      () => should.fail('resolved', 'rejected'),
      error => should((error as Error).message).match(/bzip2 could not unpack/u),
    );
  });

  it('should stop when aborted', async () => {
    // Arrange
    const root = await tempDirectory('voice-abort');
    const bz = path.join(root, 'big.tar.bz2');
    await Bun.write(bz, await bzip2(new Uint8Array(5_000_000)));
    const controller = new AbortController();
    controller.abort();

    // Act
    const failure = collect(new SystemVoiceArchiveReader().tarStream(bz, 'tar.bz2', controller.signal));

    // Assert
    await failure.then(
      () => should.fail('resolved', 'rejected'),
      error => should(error).be.instanceOf(Error),
    );
  });

  it('should name the missing tool when bzip2 cannot be started', () => {
    // The error is the contract the service maps to `voice_no_decompressor`.
    should(new NoDecompressorError('bzip2').message).match(/bzip2 is needed/u);
  });
});

describe('Install end to end on a real disk, with a fake network', () => {
  it('should download, verify, unpack and mark a tar.bz2 model and a tgz runtime installed', async () => {
    // Arrange
    const home = await tempDirectory('voice-e2e');
    const root = path.join(home, 'voice');
    await mkdir(home, { recursive: true });
    const { model, tar: modelTar } = tinyModel('alpha', { recommended: true });
    const { runtime, tar: runtimeTar } = tinyRuntime();
    const modelBz = await bzip2(modelTar);
    const runtimeTgz = gzipSync(runtimeTar);
    const pinnedModel = { ...model, archive: archiveOf(modelBz, model.archive.url, model.archive.extractedBytes) };
    const pinnedRuntime = {
      ...runtime,
      archive: archiveOf(runtimeTgz, runtime.archive.url, runtime.archive.extractedBytes, 'tgz'),
    };
    const network = new FakeNetwork();
    network.bodies.set(pinnedModel.archive.url, modelBz);
    network.bodies.set(pinnedRuntime.archive.url, runtimeTgz);
    const service = new VoiceInstallService({
      root,
      catalog: { models: [pinnedModel], runtimes: [pinnedRuntime], wrapperVersion: '9.9.9' },
      target: 'linux-x64',
      files: new NodeVoiceInstallFiles(),
      fetch: network.fetch,
      archives: new SystemVoiceArchiveReader(),
      settings: new MemorySettings(),
      clock: { now: () => new Date().toISOString() },
    });

    // Act
    await service.install('alpha');
    await service.settled();
    const view = await service.view();

    // Assert
    should(view.install?.status).equal('succeeded');
    should(await readFile(path.join(root, 'models', 'alpha', 'tokens.txt'), 'utf8')).equal('a\nb\n');
    should((await stat(path.join(root, 'runtime', '9.9.9', 'linux-x64', 'sherpa-onnx.node'))).mode & 0o100).not.equal(
      0,
    );
    should(view.models[0]?.install.state).equal('installed');
    should(view.runtime.install.state).equal('installed');
  });
});
