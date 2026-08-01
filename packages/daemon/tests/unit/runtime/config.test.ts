import { describe, it } from 'bun:test';
import should from 'should';
import { defaultDaemonConfig, parseDaemonConfig } from '../../../src/lib/runtime/config.ts';

describe('daemon configuration', () => {
  it('should derive a local public URL while rejecting unsafe host and port values', () => {
    // Act + Assert
    should(defaultDaemonConfig()).containDeep({ host: '127.0.0.1', publicUrl: 'http://127.0.0.1:7337' });
    should(parseDaemonConfig({ host: 'localhost', port: 9000 })).containDeep({ publicUrl: 'http://localhost:9000' });
    should(parseDaemonConfig({ projectRoots: ['~/Work'] }).projectRoots).deepEqual(['~/Work']);
    should(() => parseDaemonConfig({ host: '', port: 0 })).throw();
    should(() => parseDaemonConfig({ host: 'localhost', port: 7337, unknown: true })).throw();
  });
});
