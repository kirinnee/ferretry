import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lockFileOf, pidsHolding } from '../../preview/stop.ts';
import { previewBooting, SERVING_DEADLINE_MS, waitServing } from '../../preview/wait-serving.ts';

/**
 * `preview.sh start` waits for the preview daemon to SERVE (its `GET /healthz` answers 200) before it proves anything
 * through it, with a deadline it names: `fy5 daemon start` gives up after its own 30 s, and the owner's home took 38 s
 * to serve on 2026-11-10, so the start printed "not answering" while the daemon was still booting.
 */

/** A clock that only moves when the wait sleeps. */
const clock = () => {
  let now = 0;
  return { nowMs: () => now, sleep: async (ms: number) => void (now += ms) };
};

describe('wait-serving asks the health route until it answers 200, never a blind sleep', () => {
  test('a daemon that answers 503 while it starts is waited for, and the answer says how long', async () => {
    const time = clock();
    const asked: string[] = [];
    let answers = 0;
    const done = await waitServing({
      port: 7458,
      fetch: async url => {
        asked.push(url);
        answers += 1;
        return { status: answers < 80 ? 503 : 200 };
      },
      holders: async () => [1],
      ...time,
    });
    expect(done.ok).toBe(true);
    expect(done.sentence).toContain('answered 200 after 39.5 s');
    expect(new Set(asked)).toEqual(new Set(['http://127.0.0.1:7458/healthz']));
  });

  test('a daemon that never serves fails at the deadline, naming the deadline, the route and the last answer', async () => {
    const time = clock();
    const done = await waitServing({
      port: 7458,
      fetch: async () => ({ status: 503 }),
      holders: async () => [1],
      ...time,
    });
    expect(done.ok).toBe(false);
    expect(time.nowMs()).toBe(SERVING_DEADLINE_MS);
    expect(done.sentence).toContain(`within ${String(SERVING_DEADLINE_MS / 1000)} s`);
    expect(done.sentence).toContain('GET http://127.0.0.1:7458/healthz to answer 200');
    expect(done.sentence).toContain('the last ask saw starting (503)');
    expect(done.sentence).toContain('logs/');
  });

  test('no answer at all (nothing listening yet, or an ask that timed out) is waited through and named', async () => {
    const time = clock();
    const done = await waitServing({
      port: 7458,
      fetch: async () => {
        throw new Error('ECONNREFUSED');
      },
      deadlineMs: 5_000,
      holders: async () => [1],
      ...time,
    });
    expect(done.ok).toBe(false);
    expect(done.sentence).toContain('within 5 s');
    expect(done.sentence).toContain('the last ask saw no answer');
  });
});

let root = '';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fy-preview-serving-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('preview.sh start waits for the daemon to serve before the terminal proof', () => {
  const script = join(import.meta.dir, '../../preview/preview.sh');

  /** A fake `bun` that records its arguments; a fake `fy5` whose `daemon start` exits as told. */
  const start = async (startCode: number, servingCode: number, bootingCode = 0) => {
    const bin = join(root, 'fakebin');
    const target = join(root, 'v5');
    const log = join(root, 'bun.log');
    await mkdir(bin, { recursive: true });
    await mkdir(join(target, 'bin'), { recursive: true });
    await writeFile(
      join(bin, 'bun'),
      [
        '#!/bin/sh',
        'echo "$@" >> "$FAKE_LOG"',
        'case "$2" in',
        '  guard) printf "%s\\n%s\\n" "$FAKE_V4" "$FAKE_TARGET" ;;',
        '  wait-serving) exit "$FAKE_SERVING_CODE" ;;',
        '  booting) exit "$FAKE_BOOTING_CODE" ;;',
        '  *) exit 0 ;;',
        'esac',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    await writeFile(
      join(target, 'bin', 'fy5'),
      '#!/bin/sh\n[ "$1 $2" = "daemon start" ] && { echo "not answering" >&2; exit "$FAKE_START_CODE"; }\nexit 0\n',
      { mode: 0o755 },
    );
    const result = Bun.spawnSync([script, 'start', '--v4', join(root, 'v4'), '--target', target], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: root,
        FAKE_LOG: log,
        FAKE_V4: join(root, 'v4'),
        FAKE_TARGET: target,
        FAKE_START_CODE: String(startCode),
        FAKE_SERVING_CODE: String(servingCode),
        FAKE_BOOTING_CODE: String(bootingCode),
      },
    });
    const calls = (await readFile(log, 'utf8'))
      .split('\n')
      .filter(line => line !== '')
      .map(line => line.split(' ')[1]);
    return { result, calls };
  };

  test('a daemon start that stopped waiting at its own 30 s goes on to wait for serving, then proves the terminal', async () => {
    const { result, calls } = await start(1, 0);
    expect(calls.indexOf('start-checks')).toBeLessThan(calls.indexOf('wait-serving'));
    expect(calls.indexOf('wait-serving')).toBeLessThan(calls.indexOf('terminal-check'));
    expect(result.stderr.toString()).toContain('waiting for it to serve');
    expect(result.exitCode).toBe(0);
  });

  test('a daemon that does not serve in time stops the start before any proof, with a sentence and exit 1', async () => {
    const { result, calls } = await start(0, 1);
    expect(calls).toContain('wait-serving');
    expect(calls).not.toContain('terminal-check');
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('the preview daemon did not serve in time');
  });

  test('F5 a daemon that did not serve in time is stopped again, and the sentence says so', async () => {
    const { result, calls } = await start(0, 1);
    expect(calls.indexOf('wait-serving')).toBeLessThan(calls.indexOf('stop'));
    expect(result.stderr.toString()).toContain('so it was stopped');
    expect(result.stderr.toString()).toContain('nothing is left running');
  });

  test('F4 a failed daemon start with no preview daemon booting fails at once with the start’s own code', async () => {
    const { result, calls } = await start(3, 0, 1);
    expect(calls).toContain('booting');
    expect(calls).not.toContain('wait-serving');
    expect(calls).not.toContain('terminal-check');
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain('no preview daemon is booting');
  });

  test('F4 a failed daemon start while the preview daemon is booting goes on to wait for it', async () => {
    const { result, calls } = await start(1, 0, 0);
    expect(calls).toContain('wait-serving');
    expect(result.stderr.toString()).toContain('the preview daemon is booting');
    expect(result.exitCode).toBe(0);
  });

  test('a start that succeeded does not ask whether the daemon is booting', async () => {
    const { calls } = await start(0, 0, 1);
    expect(calls).not.toContain('booting');
  });
});

describe('F4 wait-serving trusts an answer only while the preview’s own daemon lock is held', () => {
  /** The stand-in lock holder: a child process that holds `lockFile` open, as the daemon does. */
  const holdLock = async (lockFile: string) => {
    await mkdir(join(lockFile, '..'), { recursive: true });
    const child = Bun.spawn(['sh', '-c', 'exec 3>"$1"; exec sleep 120', 'sh', lockFile], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    for (let i = 0; i < 100 && !(await pidsHolding(lockFile)).includes(child.pid); i++) await Bun.sleep(20);
    return child;
  };
  const servers: { stop: (force: boolean) => void }[] = [];
  const children: { kill: () => void }[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.stop(true);
    for (const c of children.splice(0)) c.kill();
  });
  /** A loopback server that answers `/healthz` as told, on a port the OS chose. */
  const serve = (status: () => number) => {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('', { status: status() }) });
    servers.push(server);
    return server;
  };
  const realFetch = async (url: string, init: { readonly signal: AbortSignal }) => await fetch(url, init);

  test('F4 a foreign listener answering 200 with no lock holder is refused', async () => {
    const home = join(root, 'v5');
    const server = serve(() => 200);
    const done = await waitServing({
      port: server.port ?? 0,
      fetch: realFetch,
      holders: () => pidsHolding(lockFileOf(home)),
      ...clock(),
    });
    expect(done.ok).toBe(false);
    expect(done.sentence).toContain('no process holds the preview daemon');
    expect(done.sentence).toContain('not trusted');
    expect(await previewBooting({ target: home })).toBe(false);
  });

  test('F4 a lock holder that died while something else took the port is refused', async () => {
    const home = join(root, 'v5');
    const holder = await holdLock(lockFileOf(home));
    children.push(holder);
    const server = serve(() => 200);
    let asks = 0;
    const done = await waitServing({
      port: server.port ?? 0,
      // The daemon dies after the first ask; the next ask is answered by the foreign server.
      fetch: async (url, init) => {
        asks += 1;
        if (asks === 1) {
          holder.kill();
          await holder.exited;
          return { status: 503 };
        }
        return await realFetch(url, init);
      },
      holders: () => pidsHolding(lockFileOf(home)),
      ...clock(),
    });
    expect(asks).toBe(2);
    expect(done.ok).toBe(false);
    expect(done.sentence).toContain('no process holds the preview daemon');
  });

  test('F4 the real booting case passes: the lock is held, the daemon answers 503 then 200', async () => {
    const home = join(root, 'v5');
    children.push(await holdLock(lockFileOf(home)));
    expect(await previewBooting({ target: home })).toBe(true);
    let asks = 0;
    const server = serve(() => (++asks < 3 ? 503 : 200));
    const done = await waitServing({
      port: server.port ?? 0,
      fetch: realFetch,
      holders: () => pidsHolding(lockFileOf(home)),
      ...clock(),
    });
    expect(done.ok).toBe(true);
    expect(done.sentence).toContain('answered 200');
  });
});
