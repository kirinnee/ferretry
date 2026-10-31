import { describe, expect, it } from 'bun:test';
import type { WorkHit } from '@ferretry/protocol';
import type { ComposerProviderContext, ComposerTrigger } from '../../src/components/composer-autocomplete.ts';
import {
  type ComposerAgendaItem,
  createReferencesProvider,
} from '../../src/components/composer-autocomplete-providers.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import type { WorkSearchPort, WorkSearchRequest } from '../../src/lib/work-search.ts';

const RELAY_PROJECT = '6f1c2f0e-3a4b-4c55-9d1e-0a7b8c9d1e2f';

const daemon = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceId: 'token-a' });
const scope = daemonSessionScope(daemon, 'this/session');

const context = (trigger: ComposerTrigger, query: string, tier?: number): ComposerProviderContext => ({
  query,
  signal: new AbortController().signal,
  match: {
    trigger,
    triggerText: trigger === '@' ? '@'.repeat(tier ?? 1) : trigger,
    ...(trigger === '@' ? { referenceTier: tier ?? 1 } : {}),
    query,
    start: 0,
    end: query.length + 1,
    caret: query.length + 1,
  },
});

const card = (id: string, patch: Partial<Extract<WorkHit, { kind: 'task' }>> = {}): WorkHit => ({
  kind: 'task',
  id,
  projectId: RELAY_PROJECT,
  sessionId: 'this/session',
  title: 'Relay handshake',
  state: 'open',
  standing: 'Doing',
  updatedAt: '2026-10-30T10:00:00.000Z',
  match: { field: 'brief', line: 'a passing mention' },
  score: 1,
  ...patch,
});

const agendaHit = (id: string, patch: Partial<Extract<WorkHit, { kind: 'agenda' }>> = {}): WorkHit => ({
  kind: 'agenda',
  id,
  sessionId: 'this/session',
  title: 'Region choice',
  state: 'open',
  standing: 'snoozed',
  updatedAt: '2026-10-30T10:00:00.000Z',
  match: { field: 'body', line: 'a passing mention' },
  score: 1,
  ...patch,
});

const fakePort = (hits: readonly WorkHit[]) => {
  const asked: WorkSearchRequest[] = [];
  const port: WorkSearchPort = {
    search: async request => {
      asked.push(request);
      const found = hits.filter(hit => hit.kind === request.kind);
      return { hits: found, total: found.length, indexed: { tasks: hits.length, agenda: hits.length } };
    },
  };
  return { port, asked };
};

const localAgenda: readonly ComposerAgendaItem[] = [{ id: 'A3', subject: 'Local relay question', source: 'question' }];

const NAMES = new Map([[RELAY_PROJECT, 'Relay']]);

const ladder = (port?: WorkSearchPort) =>
  createReferencesProvider({
    daemon,
    scope,
    getAgendaItems: () => localAgenda,
    getProjectNames: () => NAMES,
    ...(port === undefined ? {} : { getWorkSearch: () => port }),
  });

const replacements = (result: { readonly candidates: readonly { readonly replacement: string }[] }): string[] =>
  result.candidates.map(candidate => candidate.replacement);

describe("the composer pickers over the daemon's work search", () => {
  it('adds a card found by words under the @@@@ rows, as the same row with its lane as the chip', async () => {
    const { port, asked } = fakePort([card('F77')]);
    const result = await ladder(port).candidates(context('@', 'relay', 4));
    expect(result.candidates).toMatchObject([
      { replacement: '&F77', badge: 'Doing', detail: 'Relay handshake · Relay' },
    ]);
    expect(asked).toEqual([{ q: 'relay', kind: 'task', open: true, limit: 20 }]);
  });

  it("names a card's project and never shows its id: Unfiled for the unfiled board, nothing for an unknown one", async () => {
    const stranger = '11111111-2222-4333-8444-555555555555';
    const { port } = fakePort([
      card('F1', { projectId: 'unfiled' }),
      card('F2', { projectId: stranger }),
      card('F3', { projectId: RELAY_PROJECT }),
    ]);
    const result = await ladder(port).candidates(context('@', 'relay', 4));
    const details = Object.fromEntries(result.candidates.map(c => [c.replacement, c.detail]));
    expect(details).toEqual({
      '&F1': 'Relay handshake · Unfiled',
      '&F2': 'Relay handshake',
      '&F3': 'Relay handshake · Relay',
    });
  });

  it('adds an agenda item found by words under the @@@ rows, keeping local rows first and not repeating one', async () => {
    const { port } = fakePort([agendaHit('A3'), agendaHit('A9')]);
    const found = replacements(await ladder(port).candidates(context('@', 'relay', 3)));
    expect(found).toContain('!A9');
    expect(found.filter(replacement => replacement === '!A3')).toHaveLength(1);
    expect(found[0]).toBe('!A3');
  });

  it("offers only this session's agenda items, since an id in another session would not prove", async () => {
    const { port } = fakePort([agendaHit('A5', { sessionId: 'another/session' })]);
    expect(replacements(await ladder(port).candidates(context('@', 'region', 3)))).not.toContain('!A5');
  });

  it('keeps the instant local list for an empty query or an id prefix, and never asks', async () => {
    const { port, asked } = fakePort([agendaHit('A9')]);
    const provider = ladder(port);
    await provider.candidates(context('@', '', 3));
    await provider.candidates(context('@', 'A3', 3));
    await provider.candidates(context('@', 'a', 3));
    expect(asked).toEqual([]);
  });

  it('leaves the files and agents tiers alone', async () => {
    const { port, asked } = fakePort([card('F77')]);
    await ladder(port).candidates(context('@', 'relay', 2));
    expect(asked).toEqual([]);
  });

  it('falls back to the local list when the search fails, and on a machine that cannot search', async () => {
    const failing: WorkSearchPort = {
      search: async () => {
        throw new Error('offline');
      },
    };
    const expected = (await ladder().candidates(context('@', 'relay', 3))).candidates;
    expect((await ladder(failing).candidates(context('@', 'relay', 3))).candidates).toEqual(expected);
  });
});

describe('abandoning a picker search', () => {
  it('rejects at once when the menu was already closed before the wait began', async () => {
    const { port, asked } = fakePort([card('F77')]);
    const controller = new AbortController();
    controller.abort(new Error('closed'));
    const stale = { ...context('@', 'relay', 4), signal: controller.signal };
    await expect(ladder(port).candidates(stale)).rejects.toThrow('closed');
    expect(asked).toEqual([]);
  });

  it('rejects at once when the menu closes just before the pause would begin', async () => {
    const { port, asked } = fakePort([card('F77')]);
    const controller = new AbortController();
    const pending = ladder(port).candidates({ ...context('@', 'relay', 4), signal: controller.signal });
    controller.abort(new Error('closed'));
    await expect(pending).rejects.toThrow('closed');
    expect(asked).toEqual([]);
  });

  it('stops waiting, and never asks, when the menu closes during the pause', async () => {
    const { port, asked } = fakePort([card('F77')]);
    const controller = new AbortController();
    const pending = ladder(port).candidates({ ...context('@', 'relay', 4), signal: controller.signal });
    await new Promise(resolve => setTimeout(resolve, 10));
    controller.abort(new Error('closed'));
    await expect(pending).rejects.toThrow('closed');
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(asked).toEqual([]);
  });
});
