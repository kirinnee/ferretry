import { describe, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import should from 'should';
import { bundledWorkerUrl, describeWorkerProbes } from '../../../src/adapters/runtime/bundled-worker.ts';

describe('bundledWorkerUrl', () => {
  it('should name the worker program in the source tree when run from source', async () => {
    // Act
    const url = bundledWorkerUrl('pdf-decrypt');

    // Assert
    should(url).endWith('/packages/daemon/bin/pdf-decrypt.worker.ts');
    should(await Bun.file(fileURLToPath(url)).exists()).be.true();
  });

  it('should name the embedded program beside the root of a compiled binary', () => {
    // Act / Assert — every module of a compiled binary shares the entry's embedded URL.
    should(bundledWorkerUrl('pdf-decrypt', 'file:///$bunfs/root/fyd.js')).equal(
      'file:///$bunfs/root/pdf-decrypt.worker.js',
    );
  });
});

describe('describeWorkerProbes', () => {
  it('should list every ready worker, or name the first that did not start and why', () => {
    // Act / Assert
    should(describeWorkerProbes([{ name: 'pdf-decrypt', ready: true }])).equal('pdf-decrypt ready');
    should(describeWorkerProbes([{ name: 'pdf-decrypt', ready: false, reason: 'ModuleNotFound' }])).equal(
      '! pdf-decrypt did not start — ModuleNotFound',
    );
    should(describeWorkerProbes([{ name: 'pdf-decrypt', ready: false }])).equal(
      '! pdf-decrypt did not start — no reason was given',
    );
  });
});
