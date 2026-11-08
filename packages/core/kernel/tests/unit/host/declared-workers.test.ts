/** In a compiled binary a worker program is found by its file stem alone, so a plugin may start only declared stems. */
import { describe, expect, test } from 'bun:test';
import type { WorkerHandle, WorkersPort } from '../../../contract/ports.ts';
import { workersFor } from '../../../host/permissions.ts';

const handle: WorkerHandle = {
  post: () => undefined,
  onMessage: () => () => undefined,
  onExit: () => undefined,
  terminate: async () => undefined,
} as unknown as WorkerHandle;

function world(compiled: boolean | undefined, urls: Record<string, URL> | undefined) {
  const started: string[] = [];
  const base: WorkersPort = {
    start: moduleUrl => {
      started.push(moduleUrl.href);
      return handle;
    },
  };
  const workers = workersFor(base, () => undefined, undefined, undefined, {
    urls: () => urls,
    ...(compiled === undefined ? {} : { compiled }),
  });
  return { workers, started };
}

const DECLARED = { 'pdf-decrypt': new URL('file:///repo/p/conversation/daemon/worker/pdf-decrypt.worker.ts') };

describe('compiled: a plugin starts only the worker programs it declares', () => {
  test('a URL whose stem is a declared worker starts, however it is spelled', () => {
    const { workers, started } = world(true, DECLARED);
    workers.start(new URL('file:///$bunfs/worker/pdf-decrypt.worker.ts'));
    workers.start(new URL('file:///a/b/pdf-decrypt.worker.ts'));
    expect(started).toHaveLength(2);
  });

  test('a URL whose stem is not declared by this plugin is refused before any thread starts', () => {
    const { workers, started } = world(true, DECLARED);
    expect(() => workers.start(new URL('file:///repo/p/other/daemon/worker/their-worker.worker.ts'))).toThrow(
      'this plugin declares no worker program by that file name',
    );
    // A typo does not reach a declared program either.
    expect(() => workers.start(new URL('file:///repo/p/conversation/daemon/worker/pdf-decrpyt.worker.ts'))).toThrow(
      TypeError,
    );
    expect(started).toEqual([]);
  });

  test("a plugin that declares no workers starts none, even one with another plugin's stem", () => {
    for (const urls of [undefined, {}]) {
      const { workers, started } = world(true, urls);
      expect(() => workers.start(new URL('file:///repo/p/conversation/daemon/worker/pdf-decrypt.worker.ts'))).toThrow(
        TypeError,
      );
      expect(started).toEqual([]);
    }
  });

  test('a file name that cannot be read is refused, not thrown as a URI error', () => {
    const { workers, started } = world(true, DECLARED);
    expect(() => workers.start(new URL('file:///repo/bad%zz.worker.ts'))).toThrow(TypeError);
    // And a declared URL with a broken name matches nothing.
    const broken = world(true, { w: new URL('file:///repo/bad%zz.worker.ts') });
    expect(() => broken.workers.start(new URL('file:///repo/bad%zz.worker.ts'))).toThrow(TypeError);
    expect(started).toEqual([]);
  });

  test("a URL that is not a file URL is not this rule's to judge", () => {
    const { workers, started } = world(true, DECLARED);
    workers.start(new URL('https://example.test/x.worker.js'));
    expect(started).toEqual(['https://example.test/x.worker.js']);
  });
});

describe('from source nothing is checked, and this process runs from source', () => {
  test('an undeclared URL starts when the binary is not compiled', () => {
    const { workers, started } = world(false, DECLARED);
    workers.start(new URL('file:///repo/p/other/their-worker.worker.ts'));
    expect(started).toHaveLength(1);
  });

  test('the default answer is this process, which is source', () => {
    const { workers, started } = world(undefined, DECLARED);
    workers.start(new URL('file:///repo/p/other/their-worker.worker.ts'));
    expect(started).toHaveLength(1);
  });

  test('a plugin built without a declared list is unchecked (older callers pass none)', () => {
    const started: string[] = [];
    const workers = workersFor(
      {
        start: url => {
          started.push(url.href);
          return handle;
        },
      },
      () => undefined,
    );
    workers.start(new URL('file:///x.worker.ts'));
    expect(started).toHaveLength(1);
  });
});
