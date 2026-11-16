import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkChildEnvironment, runCheck } from '../../../host/check-run.ts';
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

// Fake values only: the test proves the NAMES never reach a check's child, so no real credential is involved.
const SEEDED = { GH_TOKEN: 'u1-n2-fake', ANTHROPIC_API_KEY: 'u1-n2-fake', FY_SESSION_TOKEN: 'u1-n2-fake' };

test('U1 checkChildEnvironment keeps PATH and drops every other name of the daemon environment', () => {
  expect(checkChildEnvironment({ PATH: '/opt/bin:/usr/bin', HOME: '/home/x', ...SEEDED })).toEqual({
    PATH: '/opt/bin:/usr/bin',
  });
  expect(checkChildEnvironment({ ...SEEDED })).toEqual({ PATH: '/usr/bin:/bin' });
});

test("U1 a check's selftest child is started with PATH only: no token, API key or session credential reaches it", async () => {
  const root = mkdtempSync(join(tmpdir(), 'check-run-'));
  scratch.push(root);
  let names: string[] = [];
  const manifest = definePlugin({
    id: 'envprobe',
    title: 'envprobe',
    version: '5.0.0',
    api: 5,
    core: false,
    kinds: [],
    selftest: ['env'],
    permissions: { spawn: ['env'] },
  });
  const implementation = {
    half: 'daemon',
    manifest,
    build: () => ({}) as never,
    selftest: {
      env: {
        label: 'env',
        host: true,
        run: async (env: {
          readonly spawn?: { run: (program: string, args: readonly string[]) => Promise<{ stdout: string }> };
        }) => {
          const result = await env.spawn?.run('env', []);
          names = (result?.stdout ?? '')
            .split('\n')
            .filter(line => line.includes('='))
            .map(line => line.slice(0, line.indexOf('=')))
            .sort();
          return 'ok';
        },
      },
    },
  } as unknown as DaemonImplementation;
  const saved = Object.fromEntries(Object.keys(SEEDED).map(name => [name, process.env[name]]));
  Object.assign(process.env, SEEDED);
  const write = process.stdout.write.bind(process.stdout);
  const realExit = process.exit;
  process.exit = (() => undefined) as unknown as typeof process.exit;
  process.stdout.write = (() => true) as typeof process.stdout.write;
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
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  expect(names).toEqual(['PATH']);
});
