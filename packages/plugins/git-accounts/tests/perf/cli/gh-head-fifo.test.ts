import { afterEach, expect, test } from 'bun:test';
import { closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ghVerbs } from '../../../cli/gh.ts';

/** The speed half of L52 (the correctness half is `tests/unit/gh-shim.test.ts`): a FIFO named `.git/HEAD` costs nothing. */
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('a .git/HEAD FIFO returns the argv unchanged within 100 ms', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fy-e6-fifo-'));
  roots.push(root);
  mkdirSync(join(root, '.git'));
  const head = join(root, '.git', 'HEAD');
  expect(Bun.spawnSync(['mkfifo', head]).exitCode).toBe(0);
  const bodies: unknown[] = [];
  const context = {
    client: {
      call: async (_route: string, request?: { body?: unknown }) => {
        bodies.push(request?.body);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
    io: { out: () => undefined, err: () => undefined, isTty: false },
    env: { PWD: root },
    exists: async (path: string) => existsSync(path),
    readText: async (path: string) => await Bun.file(path).text(),
  };
  const words = ['pr', 'create', '--title', 't'];
  const verbs = ghVerbs(context as never);
  const started = performance.now();
  const code = await Promise.race([
    verbs.gh({ args: words, words: ['--', ...words], options: {} }),
    new Promise<'hung'>(resolve => setTimeout(() => resolve('hung'), 2_000)),
  ]);
  const took = performance.now() - started;
  // Opening the write end lets a reader that DID block finish, so a failing run leaves nothing behind.
  closeSync(openSync(head, constants.O_RDWR));
  expect(code).toBe(0);
  expect(bodies).toEqual([{ argv: words, cwd: root }]);
  expect(took).toBeLessThan(100);
});
