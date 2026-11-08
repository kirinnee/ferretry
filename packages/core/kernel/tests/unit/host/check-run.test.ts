import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCheck } from '../../../host/check-run.ts';
import { definePlugin, type DaemonImplementation } from '../../../manifest/index.ts';

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('R689 a temp dir a selftest recreated is gone after a NORMAL check (removeAll runs on the normal exit path)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'check-run-'));
  scratch.push(root);
  let dir = '';
  const manifest = definePlugin({
    id: 'late',
    title: 'late',
    version: '5.0.0',
    api: 5,
    core: false,
    kinds: [],
    selftest: ['first', 'second'],
  });
  const implementation = {
    half: 'daemon',
    manifest,
    build: () => ({}) as never,
    selftest: {
      first: {
        label: 'first',
        run: async (env: { readonly tempDir: string }) => {
          dir = env.tempDir;
          // recreated after the kernel removed it, while the next selftest is still running
          setTimeout(() => mkdirSync(env.tempDir, { recursive: true }), 40);
          return 'ok';
        },
      },
      second: { label: 'second', run: () => new Promise<string>(resolve => setTimeout(() => resolve('ok'), 200)) },
    },
  } as unknown as DaemonImplementation;
  const written: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  // runCheck copies process.exit when it starts and calls it from its linger timer: keep that from ending the test run.
  const realExit = process.exit;
  process.exit = (() => undefined) as unknown as typeof process.exit;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await runCheck({
      home: join(root, 'home'),
      host: '127.0.0.1',
      port: 1,
      daemonName: 'fyd',
      version: '5.0.0',
      loadImplementations: async () => [implementation],
    });
  } finally {
    process.stdout.write = write;
    process.exit = realExit;
  }
  expect(dir).not.toBe('');
  expect(existsSync(dir)).toBe(false);
});
