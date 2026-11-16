import { expect, test } from 'bun:test';
import { AgendaContext } from '@ferretry/core-asks/contract';
import type { FerretRecord } from '../../../../contract/index.ts';
import { ferretsAgendaContext } from '../../../../daemon/modules/agenda-context.ts';
import { FerretRegistry } from '../../../../daemon/lib/registry/registry.ts';
import manifest from '../../../../manifest.ts';
import { record } from './route-fixture.ts';

/** M3: Ferrets provides the lineage half of `agenda.context` (key `ferrets`); Asks reads it at each call. */

const context = (records: readonly FerretRecord[], gate: () => Promise<void> = async () => undefined) =>
  ferretsAgendaContext(new FerretRegistry([...records]), gate);

test('M3 Ferrets takes agenda.context under its own key only (lineage is on the security path)', () => {
  const keys = manifest.hooks.takes.filter(take => take.hook.name === 'agenda.context').map(take => take.key);
  expect(keys).toEqual(['ferrets']);
  expect(AgendaContext.takers).toContain('ferrets');
});

test('M3 the lineage half answers from the registry: a lead, its helper, an unknown ferret', async () => {
  const ctx = context([record('lead'), record('helper', 'lead')]);
  expect(await ctx.has('lead')).toBe(true);
  expect(await ctx.has('ghost')).toBe(false);
  expect(await ctx.leadOf('helper')).toBe('lead');
  expect(await ctx.leadOf('lead')).toBeUndefined();
  expect(await ctx.leadOf('ghost')).toBeUndefined();
  expect(await ctx.addressOf('helper')).toBe('helper');
  expect(await ctx.addressOf('ghost')).toBe('ghost');
  expect([...(await ctx.all())].sort()).toEqual(['helper', 'lead']);
});

test('M3 get answers the home rule’s view of a ferret: origin, mode, project, recency and whether it still runs', async () => {
  const lead: FerretRecord = {
    ...record('lead'),
    mode: 'interactive',
    projectId: 'proj-1' as never,
    provenance: { origin: 'human', wardenLineage: false } as never,
  };
  const stopped: FerretRecord = { ...record('done', 'lead'), state: 'stopped' };
  const ctx = context([lead, stopped]);
  expect(await ctx.get('lead')).toEqual({
    id: 'lead',
    mode: 'interactive',
    origin: 'human',
    projectId: 'proj-1',
    updatedAt: lead.stateAt,
    live: true,
  });
  expect(await ctx.get('done')).toMatchObject({ id: 'done', parent: 'lead', mode: 'auto', live: false });
  expect(await ctx.get('ghost')).toBeUndefined();
});

test('M3 every answer waits for the registry to load first (a read before then would see no ferret)', async () => {
  let loaded = false;
  const ctx = context([record('lead')], async () => {
    loaded = true;
  });
  await ctx.has('lead');
  expect(loaded).toBe(true);
});
