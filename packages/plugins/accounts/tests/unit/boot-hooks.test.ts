import { expect, test } from 'bun:test';
import { z } from 'zod';
import { type MaskSource, RedactionSources } from '@ferretry/core-vault/contract';
import { defineHook, type Log } from '@ferretry/kernel/contract';
import { HookEngine } from '@ferretry/kernel/host';
import { definePlugin } from '@ferretry/kernel/manifest';
import accounts from '../../manifest.ts';

const silent: Log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => silent };
const never = () => ({ promise: new Promise<'timeout'>(() => {}), cancel: () => {} });

/** Vault's offer as its manifest declares it: the hook object its contract exports. */
const vaultOffering = (hook: typeof RedactionSources) =>
  definePlugin({
    id: 'vault',
    title: 'Vault',
    version: '5.0.0',
    api: 5,
    core: true,
    kinds: [],
    hooks: { offers: [{ hook }] },
  });

test('boot: the kernel admits Accounts beside Vault — it takes Vault’s own redaction.sources definition', () => {
  expect(accounts.hooks?.takes?.find(take => take.hook.name === RedactionSources.name)?.hook).toBe(RedactionSources);
  const { refusals, engine } = HookEngine.plan([vaultOffering(RedactionSources), accounts], silent, never);
  expect(refusals.filter(refusal => refusal.plugins.includes('accounts'))).toEqual([]);
  expect(engine.providerPlugin(RedactionSources, 'source')).toBe('accounts');
});

test('boot: a restated redaction.sources definition is what the kernel refuses (why Accounts imports Vault’s)', () => {
  const restated = defineHook('redaction.sources', {
    mode: 'provide',
    key: z.literal('source'),
    value: z.custom<MaskSource>(),
    takers: ['accounts'],
  });
  const { refusals } = HookEngine.plan([vaultOffering(restated), accounts], silent, never);
  expect(refusals.map(refusal => refusal.sentence)).toContain(
    "accounts takes redaction.sources with a definition different from its offerer's.",
  );
});
