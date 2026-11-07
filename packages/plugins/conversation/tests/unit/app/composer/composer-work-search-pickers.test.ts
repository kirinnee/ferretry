import { describe, expect, it } from 'bun:test';
import type { ReferenceCatalogEntry, WorkHit, WorkSearchQuery } from '../../../../contract/index.ts';
import type { ComposerProviderContext, ComposerTrigger } from '../../../../app/composer/composer-autocomplete.ts';
import { createReferencesProvider } from '../../../../app/composer/composer-autocomplete-providers.ts';
import { daemonConnection, daemonFerretScope, type WorkSearchPort } from '../../../../app/composer/seam.ts';

const RELAY_PROJECT = '6f1c2f0e-3a4b-4c55-9d1e-0a7b8c9d1e2f';

const daemon = daemonConnection('daemon-a');
const scope = daemonFerretScope(daemon, 'this/ferret');

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

const card = (id: string, patch: Partial<Extract<WorkHit, { kind: 'card' }>> = {}): WorkHit =>
  ({
    kind: 'card',
    id,
    project: RELAY_PROJECT,
    ferret: 'this/ferret',
    title: 'Relay handshake',
    state: 'open',
    standing: 'Doing',
    updatedAt: '2026-10-30T10:00:00.000Z',
    match: { field: 'brief', line: 'a passing mention' },
    score: 1,
    ...patch,
  }) as WorkHit;

const askHit = (id: string, patch: Partial<Extract<WorkHit, { kind: 'ask' }>> = {}): WorkHit =>
  ({
    kind: 'ask',
    id,
    ferret: 'this/ferret',
    title: 'Region choice',
    state: 'open',
    standing: 'snoozed',
    updatedAt: '2026-10-30T10:00:00.000Z',
    match: { field: 'body', line: 'a passing mention' },
    score: 1,
    ...patch,
  }) as WorkHit;

const fakePort = (hits: readonly WorkHit[]) => {
  const asked: WorkSearchQuery[] = [];
  const port: WorkSearchPort = {
    search: async request => {
      asked.push(request);
      const found = hits.filter(hit => hit.kind === request.kind);
      return { hits: found, total: found.length, indexed: { cards: hits.length, asks: hits.length } };
    },
  };
  return { port, asked };
};

const localAgenda: readonly ReferenceCatalogEntry[] = [
  { token: 'A3', label: 'Local relay question', detail: 'question' },
];

const NAMES = new Map([[RELAY_PROJECT, 'Relay']]);

const ladder = (port?: WorkSearchPort) =>
  createReferencesProvider({
    daemon,
    scope,
    hostedPrefixes: ['!', '&'],
    getCatalog: prefix => (prefix === '!' ? localAgenda : []),
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
    expect(asked).toEqual([{ q: 'relay', kind: 'card', open: true, limit: 20 }]);
  });

  it("names a card's project and never shows its id: Unfiled for the unfiled board, nothing for an unknown one", async () => {
    const stranger = '11111111-2222-4333-8444-555555555555';
    const { port } = fakePort([
      card('F1', { project: 'unfiled' }),
      card('F2', { project: stranger }),
      card('F3', { project: RELAY_PROJECT }),
    ]);
    const result = await ladder(port).candidates(context('@', 'relay', 4));
    const details = Object.fromEntries(result.candidates.map(c => [c.replacement, c.detail]));
    expect(details).toEqual({
      '&F1': 'Relay handshake · Unfiled',
      '&F2': 'Relay handshake',
      '&F3': 'Relay handshake · Relay',
    });
  });

  it('adds an ask found by words under the @@@ rows, keeping catalog rows first and not repeating one', async () => {
    const { port } = fakePort([askHit('A3'), askHit('A9')]);
    const found = replacements(await ladder(port).candidates(context('@', 'relay', 3)));
    expect(found).toContain('!A9');
    expect(found.filter(replacement => replacement === '!A3')).toHaveLength(1);
    expect(found[0]).toBe('!A3');
  });

  it('shows a snoozed or replied ask with its standing as the chip, asking for open work only', async () => {
    const { port, asked } = fakePort([askHit('A9', { standing: 'snoozed' }), askHit('A8', { standing: 'replied' })]);
    const result = await ladder(port).candidates(context('@', 'region', 3));
    const chips = result.candidates.map(candidate => [candidate.replacement, candidate.badge]);
    expect(chips).toEqual(
      expect.arrayContaining([
        ['!A9', 'snoozed'],
        ['!A8', 'replied'],
      ]),
    );
    expect(asked).toEqual([{ q: 'region', kind: 'ask', open: true, limit: 20 }]);
  });

  it("offers only this ferret's asks, since an id of another ferret would not prove", async () => {
    const { port } = fakePort([askHit('A5', { ferret: 'another/ferret' })]);
    expect(replacements(await ladder(port).candidates(context('@', 'region', 3)))).not.toContain('!A5');
  });

  it('keeps the instant list for an empty query or an id prefix, and never asks', async () => {
    const { port, asked } = fakePort([askHit('A9')]);
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

  it('falls back to the catalog list when the search fails, and on a machine that cannot search', async () => {
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
