/**
 * Held-edit follow-up row 61 (M12): the owner's reviewed change to a login (here its label) is made to a login file that
 * has another caller's edit held through the kernel's `writeAsOwner` (both versions, judged as the owner's own patch
 * alone), never through a plain `write`.
 *
 * The kernel's plain `write` of a PATCH beside a held edit is itself made to both versions today, so the OUTCOME alone
 * cannot tell the two calls apart: the first case pins the outcome (the label is in effect, the other caller's raise is
 * still held and not in effect), the second pins WHICH port call the change made, which is what M12 changes.
 */
import { describe, expect, test } from 'bun:test';
import type { ConfigPort, ConfigWriteJudgement } from '@ferretry/kernel/contract';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { owner, standInAdmission, testHost } from '@ferretry/kernel/testing';
import { LOGINS_CONFIG, LoginsUsedBy } from '../../../contract/index.ts';
import daemon from '../../../daemon/index.ts';
import { loginFiles } from '../../../daemon/lib/config.ts';
import { emptyVault } from '../../support/fake-vault.ts';

const runtimes = implementDaemon(
  definePlugin({
    id: 'runtimes',
    title: 'Runtimes',
    version: '5.0.0',
    api: 5,
    core: false,
    kinds: ['runtime'],
    hooks: { takes: [{ hook: LoginsUsedBy, key: 'runtimes' }] },
  }),
  { build: () => ({ hooks: { 'logins.used-by:runtimes': { of: () => [] } } }) as never },
);

/** A host with `work` budgeted at 5 and another caller's raise to 50 held; the owner's judge starts out holding. */
async function worldWithHeldRaise() {
  const verdict = { now: 'hold' as 'apply' | 'hold' };
  const writes: string[] = [];
  let config: ConfigPort | undefined;
  const logins = implementDaemon(daemon.manifest, {
    build: ctx => {
      config = ctx.kernel.config;
      // The logins half sees the real port with every write-shaped call noted by name.
      const note =
        <Args extends unknown[], Result>(name: string, call: (...args: Args) => Result) =>
        (...args: Args): Result => {
          writes.push(name);
          return call(...args);
        };
      const seen: ConfigPort = {
        ...ctx.kernel.config,
        write: note('write', ctx.kernel.config.write),
        writeAsOwner: note('writeAsOwner', ctx.kernel.config.writeAsOwner),
      };
      return daemon.build!({ ...ctx, kernel: { ...ctx.kernel, config: seen } });
    },
  });
  const host = await testHost({
    plugins: [logins, runtimes],
    fakes: { vault: emptyVault() },
    gate: {
      ...standInAdmission(() => owner()),
      judgeConfigWrite: (_input: ConfigWriteJudgement) => verdict.now,
    },
    config: { logins: { work: { harness: 'claude-code', store: 'host', budget: { daily: { hard: 5 } } } } },
  });
  if (config === undefined) throw new Error('the logins half was not built');
  // Another caller raises the budget: the judge holds it, so 5 stays in effect and the raise waits.
  const raised = await config.write(LOGINS_CONFIG, 'work', {
    patch: { harness: 'claude-code', store: 'host', budget: { daily: { hard: 50 } } },
  });
  expect(raised.kind).toBe('held');
  expect(config.fileState(LOGINS_CONFIG, 'work').state).toBe('held');
  return { host, config, verdict, writes };
}

async function ownerLabels(host: Awaited<ReturnType<typeof worldWithHeldRaise>>['host']) {
  const staged = await host.request('POST', '/v1/logins/changes', {
    body: { kind: 'login.label', id: 'work', label: 'Work' },
  });
  expect(staged.status).toBe(200);
  const applied = await host.request('POST', `/v1/logins/changes/${staged.json<{ id: string }>().id}/apply`);
  expect(applied.status).toBe(200);
}

describe('held-edit row 61: the owner’s reviewed login change beside a held budget raise', () => {
  test('M12 a label change leaves the label in effect and the other caller’s raise held and not in effect', async () => {
    const { host, config, verdict } = await worldWithHeldRaise();
    try {
      // The owner now changes the label, and the judge would say yes to anything it is asked about.
      verdict.now = 'apply';
      await ownerLabels(host);

      expect(loginFiles(config).get('work')).toMatchObject({ label: 'Work', budget: { daily: { hard: 5 } } });
      expect(config.fileState(LOGINS_CONFIG, 'work').state).toBe('held');
    } finally {
      await host.stop();
    }
  });

  test('M12 the label change is made through writeAsOwner and no plain write', async () => {
    const { host, verdict, writes } = await worldWithHeldRaise();
    try {
      verdict.now = 'apply';
      await ownerLabels(host);

      expect(writes).toEqual(['writeAsOwner']);
    } finally {
      await host.stop();
    }
  });
});
