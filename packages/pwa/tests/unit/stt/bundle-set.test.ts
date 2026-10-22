/**
 * Proves a model and its shared runtime install as one: installed only when both are, progress across
 * both, a runtime another model installed is neither fetched again nor counted as this model's
 * progress, and Remove keeps the runtime while another installed model needs it.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import { BundleSetInstaller } from '../../../src/lib/stt/bundle-set.ts';
import type {
  ModelInstaller,
  ModelInstallOptions,
  ModelInstallProgress,
  ModelStoreStatus,
} from '../../../src/lib/stt/model-store.ts';

class FakeInstaller implements ModelInstaller {
  readonly totalBytes: number;
  state: ModelStoreStatus;
  installs = 0;
  removes = 0;
  failWith: Error | null = null;

  constructor(totalBytes: number, state: ModelStoreStatus = { state: 'absent' }) {
    this.totalBytes = totalBytes;
    this.state = state;
  }

  status(): Promise<ModelStoreStatus> {
    return Promise.resolve(this.state);
  }

  async install(options: ModelInstallOptions = {}): Promise<void> {
    this.installs += 1;
    if (this.failWith !== null) throw this.failWith;
    if (options.signal?.aborted) throw new Error('aborted');
    options.onProgress?.({ label: 'File', downloadedBytes: this.totalBytes / 2, totalBytes: this.totalBytes });
    options.onProgress?.({ label: 'File', downloadedBytes: this.totalBytes, totalBytes: this.totalBytes });
    this.state = {
      state: 'installed',
      version: `v${this.totalBytes}`,
      bytes: this.totalBytes,
      installedAt: '2026-10-22T00:00:00.000Z',
    };
  }

  remove(): Promise<void> {
    this.removes += 1;
    this.state = { state: 'absent' };
    return Promise.resolve();
  }
}

const installed = (bytes: number, version: string, installedAt: string): ModelStoreStatus => ({
  state: 'installed',
  version,
  bytes,
  installedAt,
});

const setOf = (runtime: FakeInstaller, model: FakeInstaller, stillNeeded = false) =>
  new BundleSetInstaller({
    parts: [
      { installer: runtime, shared: true },
      { installer: model, shared: false },
    ],
    sharedStillNeeded: () => stillNeeded,
  });

describe('BundleSetInstaller', () => {
  it('totals both parts', () => {
    should(setOf(new FakeInstaller(10), new FakeInstaller(90)).totalBytes).equal(100);
  });

  it('is installed only when every part is, with the model’s version and the latest install time', async () => {
    const runtime = new FakeInstaller(10, installed(10, 'runtime', '2026-10-01T00:00:00.000Z'));
    const model = new FakeInstaller(90, installed(90, 'Model v1', '2026-10-05T00:00:00.000Z'));
    should(await setOf(runtime, model).status()).eql({
      state: 'installed',
      version: 'Model v1',
      bytes: 100,
      installedAt: '2026-10-05T00:00:00.000Z',
    });
    const older = new FakeInstaller(10, installed(10, 'runtime', '2026-10-09T00:00:00.000Z'));
    should(await setOf(older, model).status()).eql({
      state: 'installed',
      version: 'Model v1',
      bytes: 100,
      installedAt: '2026-10-09T00:00:00.000Z',
    });
  });

  it('reads a runtime another model installed as no progress on this one', async () => {
    const runtime = new FakeInstaller(10, installed(10, 'runtime', '2026-10-01T00:00:00.000Z'));
    should(await setOf(runtime, new FakeInstaller(90)).status()).eql({ state: 'absent' });
  });

  it('reads a model part-way down as partial, counting every stored byte', async () => {
    const runtime = new FakeInstaller(10, installed(10, 'runtime', '2026-10-01T00:00:00.000Z'));
    const model = new FakeInstaller(90, { state: 'partial', downloadedBytes: 30 });
    should(await setOf(runtime, model).status()).eql({ state: 'partial', downloadedBytes: 40 });
    const half = new FakeInstaller(10, { state: 'partial', downloadedBytes: 4 });
    const done = new FakeInstaller(90, installed(90, 'Model', '2026-10-01T00:00:00.000Z'));
    should(await setOf(half, done).status()).eql({ state: 'partial', downloadedBytes: 94 });
  });

  it('installs both in order with one progress across them', async () => {
    const runtime = new FakeInstaller(10);
    const model = new FakeInstaller(90);
    const seen: ModelInstallProgress[] = [];
    await setOf(runtime, model).install({ onProgress: progress => seen.push(progress) });
    should(seen.map(progress => progress.downloadedBytes)).eql([5, 10, 55, 100]);
    should(seen.every(progress => progress.totalBytes === 100)).be.true();
    should([runtime.installs, model.installs]).eql([1, 1]);
  });

  it('never fetches a part that is already installed, and still reports past it', async () => {
    const runtime = new FakeInstaller(10, installed(10, 'runtime', '2026-10-01T00:00:00.000Z'));
    const model = new FakeInstaller(90);
    const seen: ModelInstallProgress[] = [];
    await setOf(runtime, model).install({ onProgress: progress => seen.push(progress) });
    should(runtime.installs).equal(0);
    should(seen[0]).eql({ label: 'Speech runtime', downloadedBytes: 10, totalBytes: 100 });
    should(seen.at(-1)?.downloadedBytes).equal(100);
    await setOf(runtime, model).install();
  });

  it('passes the cancel signal down and stops at the first failure', async () => {
    const runtime = new FakeInstaller(10);
    runtime.failWith = new Error('offline');
    const model = new FakeInstaller(90);
    const controller = new AbortController();
    await should(setOf(runtime, model).install({ signal: controller.signal })).be.rejectedWith('offline');
    should(model.installs).equal(0);
    runtime.failWith = null;
    controller.abort();
    await should(setOf(runtime, model).install({ signal: controller.signal })).be.rejectedWith('aborted');
  });

  it('removes the model always, and the shared runtime only when nothing else needs it', async () => {
    const runtime = new FakeInstaller(10);
    const model = new FakeInstaller(90);
    await setOf(runtime, model, true).remove();
    should([runtime.removes, model.removes]).eql([0, 1]);
    await setOf(runtime, model, false).remove();
    should([runtime.removes, model.removes]).eql([1, 2]);
  });
});
