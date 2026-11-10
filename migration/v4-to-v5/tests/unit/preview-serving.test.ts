import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SERVING_DEADLINE_MS, waitServing } from '../../preview/wait-serving.ts';

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
      ...time,
    });
    expect(done.ok).toBe(true);
    expect(done.sentence).toContain('answered 200 after 39.5 s');
    expect(new Set(asked)).toEqual(new Set(['http://127.0.0.1:7458/healthz']));
  });

  test('a daemon that never serves fails at the deadline, naming the deadline, the route and the last answer', async () => {
    const time = clock();
    const done = await waitServing({ port: 7458, fetch: async () => ({ status: 503 }), ...time });
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
  const start = async (startCode: number, servingCode: number) => {
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
});
