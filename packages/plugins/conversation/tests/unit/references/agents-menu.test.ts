import { describe, expect, test } from 'bun:test';
import type { FerretSummary } from '@ferretry/core-ferrets/contract';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { cap } from '@ferretry/core-gate/contract';
import { instantFromEpochMs } from '@ferretry/std';
import {
  REFERENCE_CATALOG_MAX_ENTRIES,
  ReferenceCatalogEntrySchema,
  type ReferenceCatalogInput,
} from '../../../contract/index.ts';
import { AgentsReferenceMenu } from '../../../daemon/references/agents-menu.ts';

const at = (minute: number) => instantFromEpochMs(Date.parse('2026-11-07T10:00:00.000Z') + minute * 60_000);

const ask = (query?: string): ReferenceCatalogInput => ({
  ferret: 'f1',
  ...(query === undefined ? {} : { query }),
  caller: {},
});

const menuOf = (ferrets: readonly (Partial<Omit<FerretSummary, 'id'>> & { readonly id: string })[]) => {
  const fake = new FakeFerrets();
  for (const ferret of ferrets) fake.add({ ...ferret, id: ferretId(ferret.id) });
  return new AgentsReferenceMenu(fake);
};

describe('conversation provides the : reference menu (reference.catalog)', () => {
  test('it declares fleet use, what the fleet list route itself asks', () => {
    expect(menuOf([]).demand).toEqual(cap('fleet', 'use'));
  });

  test('the ferrets are offered by callsign, newest first: the token is the name, the label the task title, the detail the state', async () => {
    const entries = await menuOf([
      { id: 'a1', name: 'olive', title: 'Fix the login', createdAt: at(1) },
      { id: 'b2', name: 'pine', createdAt: at(5), state: 'working' },
    ]).entries(ask());
    expect(entries).toEqual([
      { token: 'pine', label: '', detail: 'working' },
      { token: 'olive', label: 'Fix the login', detail: 'idle' },
    ]);
    for (const entry of entries) expect(ReferenceCatalogEntrySchema.safeParse(entry).success).toBe(true);
  });

  test('equal creation times keep the order Ferrets listed them in', async () => {
    const entries = await menuOf([
      { id: 'a1', name: 'olive', createdAt: at(1) },
      { id: 'b2', name: 'pine', createdAt: at(1) },
    ]).entries(ask());
    expect(entries.map(entry => entry.token)).toEqual(['olive', 'pine']);
  });

  test('a stopped ferret is closed (known, not on offer) and one that said it was done reads finished', async () => {
    const entries = await menuOf([
      { id: 'a1', name: 'olive', state: 'stopped', createdAt: at(1) },
      { id: 'b2', name: 'pine', state: 'stopped', finishedAt: at(9), createdAt: at(2) },
      { id: 'c3', name: 'fir', state: 'idle', createdAt: at(3) },
    ]).entries(ask());
    expect(entries).toEqual([
      { token: 'fir', label: '', detail: 'idle' },
      { token: 'pine', label: '', detail: 'finished', closed: true },
      { token: 'olive', label: '', detail: 'stopped', closed: true },
    ]);
  });

  test('a query narrows by the callsign or the title, case ignored', async () => {
    const menu = menuOf([
      { id: 'a1', name: 'olive', title: 'Fix the LOGIN page' },
      { id: 'b2', name: 'Pine', title: 'Docs' },
    ]);
    expect((await menu.entries(ask('pin'))).map(entry => entry.token)).toEqual(['Pine']);
    expect((await menu.entries(ask('  login '))).map(entry => entry.token)).toEqual(['olive']);
    expect(await menu.entries(ask('zzz'))).toEqual([]);
  });

  test('only the callsign, the title and a lifecycle word leave: never a folder, a login or a conversation id', async () => {
    const entries = await menuOf([
      {
        id: 'a1',
        name: 'olive',
        folder: '/home/owner/secret-project',
        login: 'personal',
        harnessConversation: 'conv-123',
      },
    ]).entries(ask());
    const wire = JSON.stringify(entries);
    for (const hidden of ['secret-project', 'personal', 'conv-123']) expect(wire).not.toContain(hidden);
  });

  test('the answer is bounded, and the longest title Ferrets allows still fits an entry', async () => {
    const many = Array.from({ length: REFERENCE_CATALOG_MAX_ENTRIES + 5 }, (_, i) => ({
      id: `f${String(i)}`,
      name: `n${String(i)}`,
      title: 'x'.repeat(120),
    }));
    const entries = await menuOf(many).entries(ask());
    expect(entries).toHaveLength(REFERENCE_CATALOG_MAX_ENTRIES);
    for (const entry of entries) expect(ReferenceCatalogEntrySchema.safeParse(entry).success).toBe(true);
  });
});
