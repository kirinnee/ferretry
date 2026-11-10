/**
 * Held-edit follow-up row 61 (M12): the owner's reviewed change to a login (here its label) is made to BOTH versions of
 * a login file that has another caller's edit held, through the host's real config port. A plain write would take the
 * held version as the base and judge the whole thing against the version in effect, so an owner's yes to the label
 * would put the other caller's held budget raise into effect.
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

describe('held-edit row 61: the owner’s reviewed login change beside a held budget raise', () => {
  test('M12 a label change goes to both versions: the label is in effect, the held raise is still held and not in effect', async () => {
    let verdict: 'apply' | 'hold' = 'hold';
    const asked: ConfigWriteJudgement[] = [];
    let config: ConfigPort | undefined;
    const logins = implementDaemon(daemon.manifest, {
      build: ctx => {
        config = ctx.kernel.config;
        return daemon.build!(ctx);
      },
    });
    const host = await testHost({
      plugins: [logins, runtimes],
      fakes: { vault: emptyVault() },
      gate: {
        ...standInAdmission(() => owner()),
        judgeConfigWrite: (input: ConfigWriteJudgement) => (asked.push(input), verdict),
      },
      config: { logins: { work: { harness: 'claude-code', store: 'host', budget: { daily: { hard: 5 } } } } },
    });
    try {
      if (config === undefined) throw new Error('the logins half was not built');
      // Another caller raises the budget: the judge holds it, so 5 stays in effect and the raise waits.
      const raised = await config.write(LOGINS_CONFIG, 'work', {
        patch: { harness: 'claude-code', store: 'host', budget: { daily: { hard: 50 } } },
      });
      expect(raised.kind).toBe('held');
      expect(config.fileState(LOGINS_CONFIG, 'work').state).toBe('held');

      // The owner now changes the label, and would say yes to anything the judge is asked about.
      verdict = 'apply';
      const staged = await host.request('POST', '/v1/logins/changes', {
        body: { kind: 'login.label', id: 'work', label: 'Work' },
      });
      expect(staged.status).toBe(200);
      const applied = await host.request('POST', `/v1/logins/changes/${staged.json<{ id: string }>().id}/apply`);
      expect(applied.status).toBe(200);

      // In effect: the label, and the budget as it was. The other caller's raise did not ride in with the owner's yes.
      expect(loginFiles(config).get('work')).toMatchObject({
        label: 'Work',
        budget: { daily: { hard: 5 } },
      });
      expect(config.fileState(LOGINS_CONFIG, 'work').state).toBe('held');
    } finally {
      await host.stop();
    }
  });
});
