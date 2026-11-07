import { describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import type { AsksApi } from '@ferretry/core-asks/contract';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { type Log } from '@ferretry/kernel/contract';
import { HookEngine } from '@ferretry/kernel/host';
import { definePlugin } from '@ferretry/kernel/manifest';
import { testHost } from '@ferretry/kernel/testing';
import {
  REFERENCE_CATALOG_MAX_ENTRIES,
  ReferenceCatalog,
  type ReferenceCatalogInput,
  ReferenceCatalogEntrySchema,
  referenceCatalogLimit,
} from '@ferretry/plugin-conversation/contract';
import manifest from '../../../manifest.ts';
import agenda from '../../../daemon/index.ts';
import { AgendaReferenceMenu } from '../../../daemon/lib/reference-menu.ts';
import { raiseAsk } from './support.ts';

const silent: Log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => silent };
const never = () => ({ promise: new Promise<'timeout'>(() => {}), cancel: () => {} });
const caller = {} as ReferenceCatalogInput['caller'];
const ask = (ferret: string, query?: string): ReferenceCatalogInput => ({
  ferret,
  ...(query === undefined ? {} : { query }),
  caller,
});

/** Conversation's offer as its manifest declares it: the hook object its contract exports. */
const conversationOffering = definePlugin({
  id: 'conversation',
  title: 'Conversation',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  hooks: { offers: [{ hook: ReferenceCatalog }] },
});

describe('the `!` reference menu (reference.catalog)', () => {
  test("offers one ferret's open asks: id, subject, source, in its board's order", async () => {
    const asks = new FakeAsks();
    await raiseAsk(asks, 'f1', 'one', { subject: 'Choose a colour' });
    await raiseAsk(asks, 'f1', 'two', { subject: 'Ship the badge?' });
    await raiseAsk(asks, 'f2', 'three', { subject: 'Not yours' });
    const entries = await new AgendaReferenceMenu(asks).entries(ask('f1'));
    expect(entries).toEqual([
      { token: 'A1', label: 'Choose a colour', detail: 'question' },
      { token: 'A2', label: 'Ship the badge?', detail: 'question' },
    ]);
    for (const entry of entries) expect(ReferenceCatalogEntrySchema.safeParse(entry).success).toBe(true);
  });

  test('a ferret with no board, or an empty one, offers nothing', async () => {
    const asks = new FakeAsks();
    await raiseAsk(asks, 'f1', 'one');
    expect(await new AgendaReferenceMenu(asks).entries(ask('nobody'))).toEqual([]);
  });

  test('a resolved ask is not offered, and no row is marked closed', async () => {
    const asks = new FakeAsks();
    const done = await raiseAsk(asks, 'f1', 'one', { subject: 'Done already' });
    await raiseAsk(asks, 'f1', 'two', { subject: 'Still open' });
    await asks.close(done, 'resolved' as never);
    const entries = await new AgendaReferenceMenu(asks).entries(ask('f1'));
    expect(entries.map(entry => entry.label)).toEqual(['Still open']);
    expect(entries.some(entry => entry.closed !== undefined)).toBe(false);
  });

  test('the query narrows by id, subject or source, ignoring case', async () => {
    const asks = new FakeAsks();
    await raiseAsk(asks, 'f1', 'one', { subject: 'Choose a colour' });
    await raiseAsk(asks, 'f1', 'two', { subject: 'Ship the badge?' });
    const menu = new AgendaReferenceMenu(asks);
    const labels = async (query: string) => (await menu.entries(ask('f1', query))).map(entry => entry.label);
    expect(await labels('COLOUR')).toEqual(['Choose a colour']);
    expect(await labels('a2')).toEqual(['Ship the badge?']);
    expect(await labels('question')).toEqual(['Choose a colour', 'Ship the badge?']);
    expect(await labels('nothing like it')).toEqual([]);
    expect(await labels('  ')).toHaveLength(2);
  });

  test('is bounded by the prefix limit, and a long subject is cut to the entry bound', async () => {
    const items = Array.from({ length: REFERENCE_CATALOG_MAX_ENTRIES + 20 }, (_, index) => ({
      id: `A${index + 1}`,
      subject: index === 0 ? 'x'.repeat(400) : `ask ${index + 1}`,
      source: 'agent-raised',
    }));
    const asks = { snapshots: async () => [{ items }] } as unknown as Pick<AsksApi, 'snapshots'>;
    const entries = await new AgendaReferenceMenu(asks).entries(ask('f1'));
    expect(entries).toHaveLength(referenceCatalogLimit('!'));
    expect(entries[0]?.label.length).toBeLessThanOrEqual(256);
    for (const entry of entries) expect(ReferenceCatalogEntrySchema.safeParse(entry).success).toBe(true);
  });

  test("asks the ferret's own board only, never the others", async () => {
    const seen: unknown[] = [];
    const asks = {
      snapshots: async (filter: unknown) => {
        seen.push(filter);
        return [];
      },
    } as unknown as Pick<AsksApi, 'snapshots'>;
    await new AgendaReferenceMenu(asks).entries(ask('f1'));
    expect(seen).toEqual([{ ferret: 'f1' }]);
  });

  test('declares the demand Agenda’s own direct read of the same asks declares: none', () => {
    const menu = new AgendaReferenceMenu(new FakeAsks());
    expect((menu as { demand?: unknown }).demand).toBeUndefined();
    // GET /v1/agenda/open is every ferret's open asks, the roll-up of what this menu lists for one ferret; the
    // per-ferret read (Asks') declares no capability either — the board is gated by who acts (docs/grants.md).
    const direct = manifest.actions.routes.filter(route => route.key === 'GET /v1/agenda/open');
    expect(direct).toHaveLength(1);
    expect(direct[0]?.capability).toBeUndefined();
    expect(direct[0]?.minimum).toBe('operator');
  });

  test('leaks no token, secret or digest: only id, subject and source reach an entry', async () => {
    const items = [
      { id: 'A1', subject: 'Pick', source: 'task', sourceRef: 'ask:x:y', why: 'w', token: 'TOKEN', digest: 'D' },
    ];
    const asks = { snapshots: async () => [{ items }] } as unknown as Pick<AsksApi, 'snapshots'>;
    const [entry] = await new AgendaReferenceMenu(asks).entries(ask('f1'));
    expect(Object.keys(entry ?? {}).sort()).toEqual(['detail', 'label', 'token']);
  });
});

describe('Agenda takes the `!` menu with Conversation as an optional use', () => {
  test('the manifest takes reference.catalog keyed `!` and uses Conversation, needing no plugin for it', () => {
    expect(
      manifest.hooks?.takes?.some(
        (take: { hook: { name: string }; key?: string }) =>
          take.hook.name === ReferenceCatalog.name && take.key === '!',
      ),
    ).toBe(true);
    expect(Object.keys(manifest.uses ?? {})).toContain('conversation');
    expect(Object.keys(manifest.needs ?? {})).not.toContain('conversation');
  });

  test('with Conversation on, the kernel plans Agenda as the `!` provider', () => {
    const { refusals, engine } = HookEngine.plan([conversationOffering, manifest], silent, never);
    expect(refusals.filter(refusal => refusal.plugins.includes('agenda'))).toEqual([]);
    expect(engine.providerPlugin(ReferenceCatalog, '!')).toBe('agenda');
  });

  test('with Conversation absent, Agenda boots, keeps its ports and nothing asks it', async () => {
    const asks = new FakeAsks();
    await raiseAsk(asks, 'f1', 'one');
    const host = await testHost({ plugins: [agenda], fakes: { asks, ferrets: new FakeFerrets() } });
    try {
      expect(host.provided(manifest.provides!.agenda!)).toBeDefined();
      const { refusals, engine } = HookEngine.plan([manifest], silent, never);
      expect(refusals.filter(refusal => refusal.plugins.includes('agenda'))).toEqual([]);
      expect(engine.providerPlugin(ReferenceCatalog, '!')).toBeUndefined();
    } finally {
      await host.stop();
    }
  });
});
