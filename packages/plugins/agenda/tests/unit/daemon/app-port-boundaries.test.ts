import { expect, test } from 'bun:test';
import {
  AgendaItemSchema,
  AgendaListRecordSchema,
  AgendaListSnapshotSchema,
  AgendaSnapshotSchema,
  AskBoardSnapshotSchema,
  AskItemSchema,
  AskListSnapshotSchema,
  ResolvedAgendaItemSchema,
} from '@ferretry/core-asks/contract';
import * as shell from '../../../app/shell.ts';
import { fetchAgendaSnapshot } from '../../../app/lib/agenda-client.ts';
import { callFromFetch } from '../../support/app/call-from-fetch.ts';

test('Agenda reads go through the injected client by route key and have no browser network default', async () => {
  expect('browserFetch' in shell).toBe(false);
  const daemon = shell.daemonConnection({
    daemonId: 'test-daemon',
  });
  const scope = shell.daemonSessionScope(daemon, 'test-ferret');
  await expect(Reflect.apply(fetchAgendaSnapshot, undefined, [daemon, scope])).rejects.toThrow();
  const snapshot = {
    v: 1 as const,
    sessionId: scope.sessionId,
    items: [],
    resolved: [],
    count: 0,
    parseErrors: 0,
    updatedAt: '2026-11-07T12:00:00.000Z',
  };
  const requests: string[] = [];
  expect(
    await fetchAgendaSnapshot(
      daemon,
      scope,
      callFromFetch(async url => {
        requests.push(url);
        return Response.json(snapshot);
      }, 'https://daemon.example.test'),
    ),
  ).toEqual(snapshot);
  expect(requests).toEqual(['https://daemon.example.test/v1/ferrets/test-ferret/agenda']);
});

test('Agenda app items and snapshots use the identical public Asks schema objects', () => {
  expect(AgendaItemSchema).toBe(AskItemSchema);
  expect(AgendaSnapshotSchema).toBe(AskBoardSnapshotSchema);
  expect(AgendaListSnapshotSchema).toBe(AskListSnapshotSchema);
  expect(ResolvedAgendaItemSchema).toBe(AskBoardSnapshotSchema.shape.resolved.element);
  expect(AgendaListRecordSchema).toBe(AskListSnapshotSchema.shape.resolved.element);
});

test('production Knip discovers all dynamically loaded Agenda views without test fixtures', async () => {
  const config = await Bun.file(new URL('../../../../../../knip.production.json', import.meta.url)).json();
  const entries: string[] = config.workspaces['packages/plugins/*'].entry;
  const files = new Set<string>();
  for (const entry of entries) {
    for await (const file of new Bun.Glob(entry).scan(new URL('../../../', import.meta.url).pathname)) files.add(file);
  }
  for (const name of ['agenda-screen', 'agenda-ask-screen', 'agenda-panel', 'agenda-settings']) {
    expect(files.has(`app/views/${name}.tsx`)).toBe(true);
  }
  expect([...files].some(file => file.startsWith('tests/'))).toBe(false);
});
