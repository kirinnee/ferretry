/** The compile step's plugin worker list, from a fixture registry. */
import { describe, expect, test } from 'bun:test';
import { pluginRegistryFor, pluginWorkers, type WorkerHalf } from '../plugin-workers.ts';

const at = (path: string): URL => new URL(`file://${path}`);
const everything = (): boolean => true;
const half = (id: string, declared: readonly string[], programs: Record<string, URL>): WorkerHalf => ({
  manifest: { id, workers: declared },
  workers: programs,
});

describe('plugin worker programs the compile embeds', () => {
  test('are read from the registry halves, in a stable order, with the embedded name the kernel resolves', () => {
    const found = pluginWorkers(
      [
        half('logins', ['housekeeping'], {
          housekeeping: at('/r/plugins/logins/daemon/worker/housekeeping.worker.ts'),
        }),
        { manifest: { id: 'usage' } },
        half('conversation', ['pdf-decrypt'], {
          'pdf-decrypt': at('/r/plugins/conversation/daemon/w/pdf-decrypt.worker.ts'),
        }),
      ],
      'fyd.js',
      everything,
    );
    expect(found.map(worker => [worker.plugin, worker.id, worker.file, worker.source])).toEqual([
      ['logins', 'housekeeping', 'housekeeping.worker.js', '/r/plugins/logins/daemon/worker/housekeeping.worker.ts'],
      [
        'conversation',
        'pdf-decrypt',
        'pdf-decrypt.worker.js',
        '/r/plugins/conversation/daemon/w/pdf-decrypt.worker.ts',
      ],
    ]);
  });

  test('a registry with no workers embeds none', () => {
    expect(pluginWorkers([{ manifest: { id: 'a' } }, half('b', [], {})], 'fyd.js', everything)).toEqual([]);
  });

  test('a declared worker the half names no program for fails the compile', () => {
    expect(() => pluginWorkers([half('logins', ['housekeeping'], {})], 'fyd.js', everything)).toThrow(
      'logins declares worker "housekeeping" but its daemon half names no program for it',
    );
  });

  test('a program nobody declared fails the compile', () => {
    expect(() => pluginWorkers([half('logins', [], { x: at('/r/x.worker.ts') })], 'fyd.js', everything)).toThrow(
      `logins's daemon half names worker "x" that its manifest does not declare`,
    );
  });

  test('a program that is missing on disk, or not a file URL, fails the compile', () => {
    const missing = () =>
      pluginWorkers([half('a', ['w'], { w: at('/r/gone.worker.ts') })], 'fyd.js', path => path !== '/r/gone.worker.ts');
    expect(missing).toThrow('a worker "w" names /r/gone.worker.ts, which does not exist');
    const remote = () =>
      pluginWorkers([half('a', ['w'], { w: new URL('https://example.test/w.js') })], 'fyd.js', everything);
    expect(remote).toThrow('not a file the compile can embed');
  });

  test('two programs with one file name, or one named like the entry, fail the compile and every problem is listed', () => {
    const clash = () =>
      pluginWorkers(
        [
          half('a', ['w'], { w: at('/r/a/job.worker.ts') }),
          half('b', ['w'], { w: at('/r/b/job.worker.ts') }),
          half('c', ['e'], { e: at('/r/c/fyd.ts') }),
        ],
        'fyd.js',
        everything,
      );
    expect(clash).toThrow('b worker "w" would embed as job.worker.js, which a worker "w" already holds');
    expect(clash).toThrow('c worker "e" would embed as fyd.js, which the entry already holds');
  });
});

describe('the entry that hosts the plugins', () => {
  const files = new Set([
    '/r/packages/core/kernel/package.json',
    '/r/packages/core/kernel/src/generated/plugins.ts',
    '/r/packages/cli/package.json',
  ]);
  const exists = (path: string): boolean => files.has(path);

  test('is the one whose package holds the generated registry', () => {
    expect(pluginRegistryFor('/r/packages/core/kernel/host/fyd.ts', exists)).toBe(
      '/r/packages/core/kernel/src/generated/plugins.ts',
    );
  });

  test('another executable embeds no plugin workers', () => {
    expect(pluginRegistryFor('/r/packages/cli/bin/fy.ts', exists)).toBeUndefined();
    expect(pluginRegistryFor('/elsewhere/x.ts', exists)).toBeUndefined();
  });
});
