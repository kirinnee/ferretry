import { afterEach, describe, expect, test } from 'bun:test';
import type { RunSpec } from '@ferretry/core-ferrets/contract';
import { registeredCodex } from './registered.ts';

/** ONE body, registered by the unit tier and the integration tier (the same shape as `registered-harness.cases.ts`). */
export function protocolSendCases(): void {
  const ENV = {} as RunSpec['env'];
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });
  const line = (type: string, payload: unknown) =>
    `${JSON.stringify({ timestamp: '2026-10-20T09:00:00.000Z', type, payload })}\n`;
  const header = (id: string, home: string) =>
    line('session_meta', {
      id,
      cwd: '/work/project',
      runtime_workspace_roots: [`${home}/codex-correlation/unreachable`],
    });

  /** A launched ferret whose conversation is proved (`native-proved`), so `inject` has a thread to name. */
  async function proved() {
    const box = registeredCodex();
    cleanups.push(box.cleanup);
    const harness = box.build();
    const spec = box.spec();
    await harness.start(spec, box.runner, ENV);
    box.files.set(`${spec.home}/sessions/2026/10/20/rollout-native.jsonl`, header('native-proved', spec.home));
    return { box, harness, spec };
  }
  const queued = 'Queued message 0197-aa for thread native-proved\n';

  describe('codex-protocol-send: inject hands a message to Codex’s own queue, typing nothing', () => {
    test('the child is exactly `env CODEX_HOME=<home> <codex> queue --thread <id> --message <text>` (no --resume), under a ~10 s deadline', async () => {
      const { box, harness, spec } = await proved();
      box.answerQueue({ exitCode: 0, stdout: queued });
      expect(await harness.inject?.(spec.ferret, 'hello there')).toBe('handed');
      expect(box.queueRuns).toEqual([
        {
          program: 'env',
          args: [
            `CODEX_HOME=${spec.home}`,
            '/opt/bin/codex',
            'queue',
            '--thread',
            'native-proved',
            '--message',
            'hello there',
          ],
          timeout: 10_000,
        },
      ]);
      expect(box.queueRuns[0]?.args).not.toContain('--resume');
    });

    test('an agent send is queued with its banner VERBATIM — the exact text a typed send would have carried — and an owner send with none', async () => {
      const { box, harness, spec } = await proved();
      box.answerQueue({ exitCode: 0, stdout: queued });
      const banner =
        '[message · action from ferret torrey (session mvtorre1-a41c8b02) — not from the owner] To reply: fy send torrey "<reply>"\n';
      const agent = `${banner}Review is done — three findings.`;
      expect(await harness.inject?.(spec.ferret, agent)).toBe('handed');
      expect(await harness.inject?.(spec.ferret, 'Please land it.')).toBe('handed');
      const messages = box.queueRuns.map(run => run.args[run.args.indexOf('--message') + 1]);
      expect(messages).toEqual([agent, 'Please land it.']);
      expect(messages[0]?.startsWith('[message · action from ferret torrey')).toBe(true);
      expect(messages[1]).not.toContain('not from the owner');
    });

    test('handed only on exit 0 AND Codex’s own "Queued message <id> for thread <thread>" line', async () => {
      const { box, harness, spec } = await proved();
      for (const answer of [
        { exitCode: 1, stdout: queued },
        { exitCode: 0, stdout: '' },
        { exitCode: 0, stdout: 'Queued message 0197-aa for thread some-other-thread\n' },
        { exitCode: null, signal: 'SIGTERM', stdout: queued },
      ]) {
        box.answerQueue(answer);
        expect(await harness.inject?.(spec.ferret, 'hi')).toBe('unavailable');
      }
      box.answerQueue({ exitCode: 0, stdout: queued });
      expect(await harness.inject?.(spec.ferret, 'hi')).toBe('handed');
    });

    test('a child that cannot start is unavailable, never a throw', async () => {
      const { box, harness, spec } = await proved();
      box.answerQueue({ exitCode: 0, stdout: queued, throws: true });
      expect(await harness.inject?.(spec.ferret, 'hi')).toBe('unavailable');
    });

    test('no proved conversation yet: unavailable, and no child is run', async () => {
      const box = registeredCodex();
      cleanups.push(box.cleanup);
      const harness = box.build();
      const spec = box.spec();
      await harness.start(spec, box.runner, ENV);
      box.answerQueue({ exitCode: 0, stdout: queued });
      expect(await harness.inject?.(spec.ferret, 'hi')).toBe('unavailable');
      expect(box.queueRuns).toEqual([]);
    });

    test('codex not located: unavailable, no child', async () => {
      const { box, harness, spec } = await proved();
      box.missingCodex();
      box.answerQueue({ exitCode: 0, stdout: queued });
      expect(await harness.inject?.(spec.ferret, 'hi')).toBe('unavailable');
      expect(box.queueRuns).toEqual([]);
    });

    test('text over 64 KiB is typed as before: unavailable, no child', async () => {
      const { box, harness, spec } = await proved();
      box.answerQueue({ exitCode: 0, stdout: queued });
      expect(await harness.inject?.(spec.ferret, 'x'.repeat(64 * 1024 + 1))).toBe('unavailable');
      expect(box.queueRuns).toEqual([]);
      expect(await harness.inject?.(spec.ferret, 'x'.repeat(64 * 1024))).toBe('handed');
    });

    test('the message text never appears in a log call, on success or failure', async () => {
      const { box, harness, spec } = await proved();
      box.answerQueue({ exitCode: 0, stdout: queued });
      await harness.inject?.(spec.ferret, 'FIXTURE_SECRET_TEXT');
      box.answerQueue({ exitCode: 1, stdout: '' });
      await harness.inject?.(spec.ferret, 'FIXTURE_SECRET_TEXT');
      box.answerQueue({ exitCode: 0, stdout: queued, throws: true });
      await harness.inject?.(spec.ferret, 'FIXTURE_SECRET_TEXT');
      expect(box.warnings.length).toBeGreaterThan(0);
      expect(JSON.stringify(box.warnings)).not.toContain('FIXTURE_SECRET_TEXT');
      expect(JSON.stringify(box.warningFields)).not.toContain('FIXTURE_SECRET_TEXT');
    });
  });
}
