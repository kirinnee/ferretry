import { expect, test } from 'bun:test';
import type { HarnessScreenReader, RunnerHandle } from '@ferretry/core-ferrets/contract';
import { ferretId } from '@ferretry/core-ferrets/contract/testing';
import { TmuxRunner } from '../../../../daemon/adapters/tmux/tmux-runner.ts';
import { testActRunner, TestMintedIds } from '@ferretry/kernel/testing';

test('attach restores only the persisted registered reader after a runner restart', async () => {
  const calls: Array<readonly string[]> = [];
  const reader: HarnessScreenReader = {
    key: 'opencode',
    read: () => ({
      working: false,
      atPrompt: true,
      composer: { text: 'native draft', placeholder: false, pasted: false },
    }),
  };
  const runner = new TmuxRunner({
    tmux: {
      execute: async args => {
        calls.push(args);
        return {
          code: 0,
          stderr: '',
          stdout:
            args[0] === 'display-message'
              ? args.at(-1)?.startsWith('#{pane_id}|')
                ? '%9|4242|0|fy-ferret-1|1000|opencode|0\n'
                : '0||2|0|24|100'
              : '› Legacy-looking placeholder',
        };
      },
    },
    spawn: {
      run: async () => {
        throw new Error('no spawn');
      },
      runBytes: async () => {
        throw new Error('no spawn');
      },
      start: () => {
        throw new Error('no spawn');
      },
    },
    delivery: {
      act: testActRunner({
        actor: () => 'ferret',
        minted: new TestMintedIds(),
        holds: () => ({ decide: () => 'allow' }),
        record: () => undefined,
      }),
      sleep: async () => undefined,
    },
    socketPath: '/fixture/tmux.sock',
    now: () => 'now' as never,
    instantOf: () => 'then' as never,
  });
  const handle = '%9' as RunnerHandle;
  expect((await runner.attach(handle, 'opencode', reader)).ok).toBe(true);
  // A lifecycle pid check must preserve the native binding made at hydration/start.
  expect((await runner.attach(handle, 'opencode')).ok).toBe(true);
  expect((await runner.observe(handle))?.draft).toBe('native draft');
  expect(await runner.attach(handle, 'claude-code', undefined, ferretId('other-ferret'))).toEqual({
    ok: false,
    error: 'mismatch',
  });
  expect((await runner.observe(handle))?.draft).toBe('native draft');
  expect(calls.some(args => ['send-keys', 'paste-buffer', 'load-buffer'].includes(args[0] ?? ''))).toBe(false);
  expect((await runner.attach(handle, 'unknown-third')).ok).toBe(true);
  expect((await runner.observe(handle))?.promptReady).toBe(false);
  await expect(runner.deliver(handle, { text: 'must not type' })).rejects.toMatchObject({
    deliveryFailure: { kind: 'not_ready' },
  });
  expect(calls.some(args => ['send-keys', 'paste-buffer', 'load-buffer'].includes(args[0] ?? ''))).toBe(false);
});
