import { afterEach, describe, expect, test } from 'bun:test';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { definePlugin, type HookInvoker, implementDaemon } from '@ferretry/kernel/manifest';
import { type TestHost, testHost } from '@ferretry/kernel/testing';
import { ReferenceCatalog, type ReferenceCatalogCaller } from '@ferretry/plugin-conversation/contract';
import type { FerretSkills } from '../../contract/index.ts';
import skills from '../../daemon/index.ts';
import { skillEntries, skillReferenceProvider } from '../../daemon/lib/reference-catalog.ts';
import manifest from '../../manifest.ts';

/** The menu reads names and descriptions only; it asks nothing of who is asking. */
const CALLER = {} as ReferenceCatalogCaller;

const available = (name: string, description: string): FerretSkills['skills'][number] => ({
  name,
  description,
  scope: 'global',
  origin: 'claude-code',
});

describe('the `/` and `$` composer menu entries (reference.catalog)', () => {
  test('answer the skill names the ferret can invoke, each with its description, in the order the list gives', () => {
    const entries = skillEntries({
      harness: 'claude-code',
      skills: [available('alpha', 'does alpha'), available('beta', 'does beta')],
    });
    expect(entries).toEqual([
      { token: 'alpha', label: 'alpha', detail: 'does alpha' },
      { token: 'beta', label: 'beta', detail: 'does beta' },
    ]);
  });

  test('cut a long description to the catalog’s bound instead of refusing the whole menu', () => {
    const [entry] = skillEntries({ harness: 'codex', skills: [available('long', 'x'.repeat(2_000))] });
    expect(entry?.detail).toHaveLength(512);
  });

  test('answer no entries for a ferret this daemon does not know, and read the list for the ferret asked about', async () => {
    const asked: string[] = [];
    const provider = skillReferenceProvider(async ferret => {
      asked.push(ferret);
      return ferret === 'f1' ? { harness: 'claude-code', skills: [available('alpha', 'does alpha')] } : undefined;
    });
    expect(provider.demand).toBeUndefined();
    expect((await provider.entries({ ferret: 'f1', caller: CALLER })).map(entry => entry.token)).toEqual(['alpha']);
    expect(await provider.entries({ ferret: 'gone', caller: CALLER })).toEqual([]);
    expect(asked).toEqual(['f1', 'gone']);
  });
});

describe('Skills as a reference.catalog provider', () => {
  const hosts: TestHost[] = [];
  afterEach(async () => {
    for (const host of hosts.splice(0)) await host.stop();
  });

  test('takes Conversation only as an optional use, and the hook for `/` and `$`', () => {
    expect(Object.keys(manifest.uses ?? {})).toEqual(['conversation']);
    expect(Object.keys(manifest.needs ?? {})).toEqual(['ferrets']);
    expect(
      (manifest.hooks?.takes ?? []).flatMap(take =>
        take.hook.name === 'reference.catalog' && 'key' in take ? [take.key] : [],
      ),
    ).toEqual(['/', '$']);
  });

  test('with Conversation absent Skills boots, and both prefixes still answer when something asks', async () => {
    // The asker stands in for Conversation's route: it offers the hook and nothing else is loaded.
    let hooks: HookInvoker | undefined;
    const asker = definePlugin({
      id: 'reference-asker',
      title: 'Reference asker',
      version: '1.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { offers: [{ hook: ReferenceCatalog }] },
    });
    const askerHalf = implementDaemon(asker, {
      build: ctx => {
        hooks = ctx.hooks;
        return {};
      },
    });
    const ferrets = new FakeFerrets();
    ferrets.add({ id: ferretId('f1'), folder: '/work/app' });
    const host = await testHost({ plugins: [skills, askerHalf], fakes: { ferrets } });
    hosts.push(host);
    for (const prefix of ['/', '$'] as const) {
      const provider = hooks?.provider(ReferenceCatalog, prefix);
      if (provider === undefined || provider === 'unavailable') throw new Error(`no provider for ${prefix}`);
      // The ferret has no skill folder in the in-memory world: an honest empty menu, not an error.
      expect(await provider.entries({ ferret: 'f1', caller: CALLER })).toEqual([]);
      expect(await provider.entries({ ferret: 'f2', caller: CALLER })).toEqual([]);
    }
    expect(hooks?.provider(ReferenceCatalog, '&')).toBe('unavailable');
  });
});
