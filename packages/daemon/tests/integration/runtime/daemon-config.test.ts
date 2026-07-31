import { describe, it } from 'bun:test';
import should from 'should';
import { FileDaemonConfig } from '../../../src/adapters/runtime/daemon-config.ts';
import type { FileSystemPort, FoundationPaths } from '../../../src/lib/index.ts';

const paths = { daemonConfig: '/state/config/daemon.json' } as FoundationPaths;

describe('FileDaemonConfig', () => {
  it('should persist private defaults once and reload an explicit configuration', async () => {
    // Arrange
    let text: string | undefined;
    const files = {
      readText: async () => text,
      writeTextAtomic: async (_path: string, next: string) => {
        text = next;
      },
    } as Pick<FileSystemPort, 'readText' | 'writeTextAtomic'> as FileSystemPort;
    const store = new FileDaemonConfig(paths, files);

    // Act
    const created = await store.load();
    text = JSON.stringify({ host: 'localhost', port: 8123 });
    const loaded = await store.load();

    // Assert
    should(created.publicUrl).equal('http://127.0.0.1:7337');
    should(text).containEql('8123');
    should(loaded.publicUrl).equal('http://localhost:8123');
  });
});
