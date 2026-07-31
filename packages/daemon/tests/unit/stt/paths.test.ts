import { describe, it } from 'bun:test';
import should from 'should';
import {
  createFoundationPaths,
  createSttPaths,
  requiredSttDirectories,
  resolveStateHome,
  type SttError,
  sttInstallScratchPath,
  sttModelDirectory,
} from '../../../src/lib/index.ts';

function refusalOf(act: () => unknown): string {
  try {
    act();
    return 'accepted';
  } catch (error) {
    return (error as SttError).code;
  }
}

const paths = createSttPaths(createFoundationPaths(resolveStateHome({ fyHome: '/tmp/fy-home', homeDirectory: '/' })));

describe('STT paths', () => {
  it('should validate the model id and the suffix of an install scratch path', () => {
    // Act
    const actual = {
      valid: sttInstallScratchPath(paths, 'parakeet-v3', 'install-abc123'),
      unsafeId: refusalOf(() => sttInstallScratchPath(paths, 'a/../../victim', 'install-1')),
      unsafeSuffix: refusalOf(() => sttInstallScratchPath(paths, 'parakeet-v3', '../escape')),
      emptySuffix: refusalOf(() => sttInstallScratchPath(paths, 'parakeet-v3', '')),
    };

    // Assert
    should(actual.valid).equal('/tmp/fy-home/models/.parakeet-v3.install-abc123');
    should(actual.unsafeId).equal('model_not_found');
    should(actual.unsafeSuffix).equal('install_failed');
    should(actual.emptySuffix).equal('install_failed');
  });

  it('should place weights beside the state home and diagnostics under the state tree', () => {
    // Assert
    should(paths).deepEqual({
      models: '/tmp/fy-home/models',
      directory: '/tmp/fy-home/state/stt',
      state: '/tmp/fy-home/state/stt/state.json',
      workerLog: '/tmp/fy-home/state/stt/worker.log',
    });
    should(requiredSttDirectories(paths)).deepEqual(['/tmp/fy-home/models', '/tmp/fy-home/state/stt']);
  });

  it('should resolve a model directory under the models root', () => {
    // Act
    const actual = sttModelDirectory(paths, 'parakeet-v3.int8');

    // Assert
    should(actual).equal('/tmp/fy-home/models/parakeet-v3.int8');
  });

  it('should refuse a model id that would escape the models root', () => {
    // Arrange
    const unsafe = ['../../etc', '/absolute', 'nested/child', '.hidden', 'Upper', '', 'has space'];

    // Act
    const actual = unsafe.map(modelId => {
      try {
        sttModelDirectory(paths, modelId);
        return 'accepted';
      } catch (error) {
        return (error as SttError).code;
      }
    });

    // Assert
    should(actual).deepEqual(new Array(unsafe.length).fill('model_not_found'));
  });
});
