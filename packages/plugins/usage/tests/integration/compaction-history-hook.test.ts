/**
 * Usage answers `ferrets.compaction-history:usage`: the history Ferrets' live readout estimates a running compaction from
 * is the one Usage keeps (F-0130). The asker stands where Ferrets stands (the plugin that offers the hook; the key and the
 * hook are the real ones); Ferrets' own use of the answer is tested with Ferrets.
 */
import { describe, expect, test } from 'bun:test';
import {
  COMPACTION_HISTORY_KEY,
  CompactionHistoryHook,
  type CompactionHistorySource,
} from '@ferretry/core-ferrets/contract';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { testHost } from '@ferretry/kernel/testing';
import { fakeConversation } from '@ferretry/plugin-conversation/contract/testing';
import { fakeLogins, sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import usage from '../../daemon/index.ts';

let ask: (() => CompactionHistorySource | 'unavailable') | undefined;

/** A plugin standing where Ferrets stands: it offers `ferrets.compaction-history` and asks for the provider keyed `usage`. */
const ferrets = implementDaemon(
  definePlugin({
    id: 'ferrets',
    title: 'Ferrets',
    version: '5.0.0',
    api: 5,
    core: false,
    kinds: ['instruction'],
    hooks: { offers: [{ hook: CompactionHistoryHook }] },
  }),
  {
    build: ctx => {
      ask = () => ctx.hooks.provider(CompactionHistoryHook, COMPACTION_HISTORY_KEY);
      return {} as never;
    },
  },
);

describe('the compaction history Usage provides', () => {
  test('keeps a finished compaction and answers the durations of the harness asked about', async () => {
    const host = await testHost({
      plugins: [ferrets, usage],
      fakes: {
        ferrets: new FakeFerrets(),
        conversation: fakeConversation(),
        logins: fakeLogins([sampleLogin('work')]),
        vault: new FakeVault(),
      },
    });

    const history = (ask as () => CompactionHistorySource | 'unavailable')();
    expect(history).not.toBe('unavailable');
    const provided = history as CompactionHistorySource;
    expect(await provided.durations('claude', undefined)).toEqual([]);
    await provided.record({ harness: 'claude', durationMs: 42_000, at: '2026-11-14T10:00:00.000Z' });

    expect(await provided.durations('claude', undefined)).toEqual([42_000]);
    expect(await provided.durations('codex', undefined)).toEqual([]);
    await host.stop();
  });
});
