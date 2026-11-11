/** What a child is given, how its input is fed, and how a worker's exit listener is withdrawn. */
import { describe, expect, test } from 'bun:test';
import type { ChildEnvironment, ChildEnvironmentOpener } from '../../../contract/bound.ts';
import {
  bunSpawn,
  bunWorkers,
  childEnvironment,
  noWebSockets,
  resolveEnv,
  TOOL_ENVIRONMENT_NAMES,
  toolEnvironment,
} from '../../../host/adapters/process.ts';

const PATH = process.env['PATH'] ?? '/usr/bin:/bin';

describe('the tool environment', () => {
  test('only the named, non-empty string values of the source are copied', () => {
    const picked = toolEnvironment({
      HTTPS_PROXY: 'http://proxy.example:3128',
      NO_PROXY: '',
      GH_TOKEN: 'never copied',
      GITHUB_TOKEN: 'never copied',
      XDG_CONFIG_HOME: '/home/owner/.config',
      SSH_AUTH_SOCK: undefined,
    });
    expect(picked).toEqual({ HTTPS_PROXY: 'http://proxy.example:3128', XDG_CONFIG_HOME: '/home/owner/.config' });
    expect(TOOL_ENVIRONMENT_NAMES).not.toContain('GH_TOKEN');
  });

  test("git and gh get it, any other program does not, and the caller's own env wins", () => {
    const base = { PATH: '/bin', HTTPS_PROXY: 'base' };
    const tools = { HTTPS_PROXY: 'tool', GH_CONFIG_DIR: '/cfg' };
    expect(childEnvironment('/usr/bin/git', base, tools, { A: '1' })).toEqual({
      PATH: '/bin',
      HTTPS_PROXY: 'tool',
      GH_CONFIG_DIR: '/cfg',
      A: '1',
    });
    expect(childEnvironment('gh', base, tools, { GH_CONFIG_DIR: 'mine' })['GH_CONFIG_DIR']).toBe('mine');
    expect(childEnvironment('sh', base, tools, {})).toEqual(base);
  });
});

describe('resolving a child environment', () => {
  const handle = Object.freeze({ handle: 1 }) as unknown as ChildEnvironment;

  test('nothing is nothing, and plain string values pass as they are', () => {
    expect(resolveEnv(undefined, undefined)).toEqual({});
    const plain = { A: '1' };
    expect(resolveEnv(plain, undefined)).toBe(plain);
  });

  test('a handle the bound opener recognises is opened into its values', () => {
    const opener: ChildEnvironmentOpener = { open: () => ({ TOKEN: 'opened' }), searchPathOf: () => undefined };
    expect(resolveEnv(handle, opener)).toEqual({ TOKEN: 'opened' });
  });

  test('an opener that throws is treated as not recognising the handle, so the start is refused', () => {
    const opener: ChildEnvironmentOpener = {
      open: () => {
        throw new Error('not mine');
      },
      searchPathOf: () => undefined,
    };
    expect(() => resolveEnv(handle, opener)).toThrow('This child needs secrets the Vault did not open');
  });

  test('values that are not plain strings are refused as if they were a handle', () => {
    expect(() => resolveEnv({ A: 1 } as unknown as Record<string, string>, undefined)).toThrow('did not open');
    expect(() => resolveEnv(Object.create(null) as Record<string, string>, undefined)).toThrow('did not open');
  });
});

describe('a started child', () => {
  test("options.stdin is written and closed, and the child sees the opened environment, not the caller's handle", async () => {
    const spawn = bunSpawn({ PATH }, () => ({
      open: () => ({ SECRET_SHAPE: 'opened-value' }),
      searchPathOf: () => undefined,
    }));
    const child = spawn.start('sh', ['-c', 'cat; printf "%s" "$SECRET_SHAPE"'], {
      stdin: 'from stdin|',
      env: Object.freeze({}) as unknown as ChildEnvironment,
    });
    expect(await new Response(child.stdout).text()).toBe('from stdin|opened-value');
    expect(await child.exited).toBe(0);
  });

  test('write feeds a running child until it has what it wants', async () => {
    const child = bunSpawn({ PATH }).start('head', ['-c', '5']);
    child.write('hel');
    child.write('lo!!!');
    expect(await new Response(child.stdout).text()).toBe('hello');
    expect(await child.exited).toBe(0);
  });

  test('kill ends a running child with the signal it was given, and defaults to SIGTERM', async () => {
    const spawn = bunSpawn({ PATH });
    const defaulted = spawn.start('sleep', ['30']);
    defaulted.kill();
    expect(await defaulted.exited).toBe(143);
    const named = spawn.start('sleep', ['30']);
    named.kill('SIGKILL');
    expect(await named.exited).toBe(137);
  });
});

describe('the websocket port a host without one gets', () => {
  test('refuses every dial, so a test cannot reach the network by accident', () => {
    expect(() => noWebSockets().connect('wss://example.test/')).toThrow('This host opens no WebSocket connections.');
  });
});

describe("a worker's exit listener", () => {
  test('is withdrawn by the function it returned, so a worker that then ends tells nobody', async () => {
    const worker = bunWorkers().start(new URL('./fixtures/crash-worker.ts', import.meta.url));
    const heard: unknown[] = [];
    const withdraw = worker.onExit(exit => heard.push(exit));
    const kept: unknown[] = [];
    const exited = new Promise<void>(resolve => {
      worker.onExit(exit => {
        kept.push(exit);
        resolve();
      });
    });
    withdraw();
    worker.post('go');
    await exited;
    expect(heard).toEqual([]);
    expect(kept).toHaveLength(1);
    await worker.terminate();
  });
});

describe("a worker's environment", () => {
  const NAME = 'FY_TEST_WORKER_ENV_PROBE';
  const ENV_WORKER = new URL('./fixtures/env-worker.ts', import.meta.url);

  async function seenBy(options: Parameters<ReturnType<typeof bunWorkers>['start']>[1], name = NAME): Promise<unknown> {
    const worker = bunWorkers().start(ENV_WORKER, options);
    try {
      const answered = new Promise<unknown>(resolve => worker.onMessage(resolve));
      worker.post([name]);
      return await answered;
    } finally {
      await worker.terminate();
    }
  }

  test("started without an env, it sees the daemon's CURRENT environment: a name the daemon deleted stays deleted", async () => {
    // Bun hands `new Worker(url)` (NO options object) the process's ORIGINAL native environment, so a name the daemon had
    // deleted (the yaml log switches) would come back in it; given ANY options object it hands over the current one.
    // `bunWorkers` always passes an options object, and this pins that. The name must exist in the original environment for
    // the probe to mean anything, so it is `PATH`, restored at once (nothing here needs it while it is gone).
    const original = process.env['PATH'];
    expect(original).toBeDefined();
    try {
      expect(await seenBy(undefined, 'PATH')).toEqual({ PATH: original });
      delete process.env['PATH'];
      expect(await seenBy(undefined, 'PATH')).toEqual({ PATH: null });
    } finally {
      process.env['PATH'] = original as string;
    }
  });

  test('given an env, it sees exactly that and nothing of the daemon', async () => {
    process.env[NAME] = 'set-in-the-daemon';
    try {
      expect(await seenBy({ env: {} })).toEqual({ [NAME]: null });
      expect(await seenBy({ env: { [NAME]: 'handed' } })).toEqual({ [NAME]: 'handed' });
    } finally {
      delete process.env[NAME];
    }
  });
});
