import { describe, expect, test } from 'bun:test';
import { AGENDA_CHANNEL_HEADER } from '@ferretry/protocol';
import type { ReactTestRenderer } from 'react-test-renderer';
import type { z } from 'zod';
import type { AgendaWire } from '../../src/lib/agenda-wire.ts';
import {
  type ComposerReferenceCatalogReader,
  type ComposerReferenceCatalogSources,
  useComposerReferenceCatalogs,
} from '../../src/lib/composer-reference-catalogs.ts';
import { render, run, runAsync } from '../support/react.ts';
import { sessionCard } from '../support/session-cards.ts';

const cards = [sessionCard('F12', { title: 'Ship autocomplete' })];

const agendaListing = (sessionId = 'session-a') => ({
  v: 1 as const,
  sessionId,
  items: [
    {
      id: 'A3',
      source: 'question' as const,
      sourceRef: null,
      subject: 'Choose a renderer',
      why: 'A decision is needed.',
      waitingSince: '2026-08-06T00:00:00.000Z',
      howToResolve: 'Choose one.',
      raisedBy: 'human' as const,
      raisedBySession: null,
      raisedByName: null,
    },
  ],
  resolved: [],
  count: 1,
  parseErrors: 0,
  updatedAt: '2026-08-06T00:00:00.000Z',
});

const skillsListing = {
  harness: 'codex' as const,
  skills: [
    {
      name: 'floop',
      description: 'Review until every lens is satisfied.',
      scope: 'global' as const,
      origin: 'both' as const,
    },
  ],
};

const reader = (
  answer: (path: string, init?: RequestInit) => unknown | Promise<unknown>,
  calls: string[] = [],
): ComposerReferenceCatalogReader =>
  ({
    request: async <Value,>(path: string, schema: z.ZodType<Value>, init?: RequestInit): Promise<Value> => {
      calls.push(path);
      return schema.parse(await answer(path, init));
    },
  }) as ComposerReferenceCatalogReader;

function CatalogProbe({
  client,
  sessionId,
  sources,
  onCatalogs,
  wire,
}: {
  readonly client: Partial<ComposerReferenceCatalogReader>;
  readonly sessionId: string;
  readonly sources?: ComposerReferenceCatalogSources;
  readonly onCatalogs?: (catalogs: ReturnType<typeof useComposerReferenceCatalogs>) => void;
  readonly wire?: AgendaWire;
}) {
  const catalogs = useComposerReferenceCatalogs(client, sessionId, sources, wire);
  onCatalogs?.(catalogs);
  return (
    <output>{`${catalogs.tasks?.length ?? '-'}:${catalogs.attention?.length ?? '-'}:${catalogs.skills?.skills.length ?? '-'}`}</output>
  );
}

const output = (view: ReactTestRenderer): string => view.root.findByType('output').children.join('');

const flushCatalogs = async (): Promise<void> => {
  await runAsync(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
};

describe('useComposerReferenceCatalogs', () => {
  test('publishes a completed bundle and supports a host without the optional reader', async () => {
    const client = reader(path => {
      if (path.endsWith('/attention')) return agendaListing();
      return skillsListing;
    });
    const view = render(<CatalogProbe client={client} sessionId="session-a" />);

    await flushCatalogs();
    expect(output(view)).toBe('-:1:1');

    run(() => view.update(<CatalogProbe client={{}} sessionId="session-a" />));
    expect(output(view)).toBe('-:-:-');
    run(() => view.unmount());
  });

  test('publishes a fast family before slow siblings without issuing a second read', async () => {
    const calls: string[] = [];
    let resolveAgenda: ((value: unknown) => void) | undefined;
    const client = reader(path => {
      if (path.endsWith('/skills')) return skillsListing;
      return new Promise(resolve => {
        resolveAgenda = resolve;
      });
    }, calls);
    const view = render(<CatalogProbe client={client} sessionId="session-a" />);

    await flushCatalogs();
    expect(output(view)).toBe('-:-:1');
    expect(calls.sort()).toEqual(['/v1/sessions/session-a/attention', '/v1/sessions/session-a/skills']);

    if (resolveAgenda === undefined) throw new Error('slow catalog read did not start');
    resolveAgenda(agendaListing());
    await flushCatalogs();
    expect(output(view)).toBe('-:1:1');
    expect(calls).toHaveLength(2);
    run(() => view.unmount());
  });

  test('joins shared task and skill owners while reading only Attention itself', async () => {
    const calls: string[] = [];
    let resolveAgenda: ((value: unknown) => void) | undefined;
    let resolveTasks: (() => void) | undefined;
    let resolveSkills: (() => void) | undefined;
    const tasksSettled = new Promise<void>(resolve => {
      resolveTasks = resolve;
    });
    const skillsSettled = new Promise<void>(resolve => {
      resolveSkills = resolve;
    });
    const client = reader(
      () =>
        new Promise(resolve => {
          resolveAgenda = resolve;
        }),
      calls,
    );
    const sources: ComposerReferenceCatalogSources = {
      tasks: cards,
      skills: skillsListing,
      waitForTasks: () => tasksSettled,
      waitForSkills: () => skillsSettled,
    };
    let latest: ReturnType<typeof useComposerReferenceCatalogs> | undefined;
    const view = render(
      <CatalogProbe
        client={client}
        onCatalogs={catalogs => {
          latest = catalogs;
        }}
        sessionId="session-a"
        sources={sources}
      />,
    );

    expect(calls).toEqual(['/v1/sessions/session-a/attention']);
    const allSettled = latest?.settled();
    let finished = false;
    void allSettled?.then(() => {
      finished = true;
    });
    if (resolveAgenda === undefined || resolveTasks === undefined || resolveSkills === undefined)
      throw new Error('shared catalog reads did not start');
    resolveAgenda(agendaListing());
    await flushCatalogs();
    expect(output(view)).toBe('1:1:1');
    expect(finished).toBe(false);

    resolveTasks();
    resolveSkills();
    await allSettled;
    expect(finished).toBe(true);
    expect(calls).toHaveLength(1);
    run(() => view.unmount());
  });

  test('reads nothing when the host owns the live Agenda board, and offers that board as it moves', async () => {
    const calls: string[] = [];
    const client = reader(() => agendaListing(), calls);
    const shared = (items: ComposerReferenceCatalogSources['attention']): ComposerReferenceCatalogSources => ({
      tasks: cards,
      skills: skillsListing,
      waitForTasks: () => undefined,
      waitForSkills: () => undefined,
      ...(items === undefined ? {} : { attention: items }),
    });
    let latest: ReturnType<typeof useComposerReferenceCatalogs> | undefined;
    const probe = (sources: ComposerReferenceCatalogSources) => (
      <CatalogProbe
        client={client}
        onCatalogs={catalogs => {
          latest = catalogs;
        }}
        sessionId="session-a"
        sources={sources}
      />
    );
    // Unread: the board has no items yet, so the family is unproved rather than empty.
    const view = render(probe(shared({ items: undefined })));
    await flushCatalogs();
    expect(calls).toEqual([]);
    expect(latest?.attention).toBeUndefined();
    expect(latest?.settled()).toBeUndefined();

    // The board is read, then a new item is raised: both reach the menu with no read of this module's own.
    const first = agendaListing().items;
    run(() => view.update(probe(shared({ items: first }))));
    expect(latest?.attention).toBe(first);
    const raised = [...first, { ...first[0], id: 'A7' }] as typeof first;
    run(() => view.update(probe(shared({ items: raised }))));
    expect(latest?.attention?.map(item => item.id)).toEqual(['A3', 'A7']);

    // A board that could not be read says so, under the Attention family.
    run(() => view.update(probe(shared({ items: undefined, failure: 'board refused' }))));
    expect(latest?.failures.attention).toBe('board refused');
    await flushCatalogs();
    expect(calls).toEqual([]);
    run(() => view.unmount());
  });

  test('a host with no live board still has its one Attention read, and a refusal is said under Attention', async () => {
    const calls: string[] = [];
    const client = reader(() => Promise.reject(new Error('attention refused')), calls);
    let latest: ReturnType<typeof useComposerReferenceCatalogs> | undefined;
    const view = render(
      <CatalogProbe
        client={client}
        onCatalogs={catalogs => {
          latest = catalogs;
        }}
        sessionId="session-a"
        sources={{
          tasks: cards,
          skills: skillsListing,
          waitForTasks: () => undefined,
          waitForSkills: () => undefined,
        }}
      />,
    );
    await flushCatalogs();
    expect(calls).toEqual(['/v1/sessions/session-a/attention']);
    expect(latest?.attention).toBeUndefined();
    expect(latest?.failures.attention).toBe('attention refused');
    run(() => view.unmount());
  });

  const readWith = async (answer: (path: string) => unknown) => {
    let latest: ReturnType<typeof useComposerReferenceCatalogs> | undefined;
    const view = render(
      <CatalogProbe
        client={reader(answer)}
        onCatalogs={catalogs => {
          latest = catalogs;
        }}
        sessionId="session-a"
      />,
    );
    await flushCatalogs();
    run(() => view.unmount());
    return latest;
  };

  test('keeps the skills when the attention route fails, and says so under Attention', async () => {
    const catalogs = await readWith(path => {
      if (path.endsWith('/attention')) throw new Error('attention unavailable');
      return skillsListing;
    });

    expect(catalogs?.attention).toBeUndefined();
    expect(catalogs?.skills?.harness).toBe('codex');
    expect(catalogs?.failures).toEqual({ attention: 'attention unavailable' });
  });

  test('keeps Attention when the skills route fails, and says so under skills', async () => {
    const catalogs = await readWith(path => {
      if (path.endsWith('/attention')) return agendaListing();
      throw new Error('skills unavailable');
    });

    expect(catalogs?.attention).toHaveLength(1);
    expect(catalogs?.skills).toBeUndefined();
    expect(catalogs?.failures).toEqual({ skills: 'skills unavailable' });
  });

  test('refuses an Agenda about another session without erasing the skills', async () => {
    const catalogs = await readWith(path => (path.endsWith('/attention') ? agendaListing('session-b') : skillsListing));

    expect(catalogs?.attention).toBeUndefined();
    expect(catalogs?.skills?.harness).toBe('codex');
    expect(catalogs?.failures.attention).toContain('session-b');
  });

  test('fences a late answer after session navigation', async () => {
    const pending: Array<(value: unknown) => void> = [];
    const slow = reader(path =>
      new Promise(resolve => {
        pending.push(value => resolve(value));
      }).then(() => {
        if (path.endsWith('/attention')) return agendaListing('session-a');
        return skillsListing;
      }),
    );
    const view = render(<CatalogProbe client={slow} sessionId="session-a" />);
    run(() => view.update(<CatalogProbe client={{}} sessionId="session-b" />));
    for (const resolve of pending) resolve(undefined);

    await flushCatalogs();
    expect(output(view)).toBe('-:-:-');
    run(() => view.unmount());
  });
});

describe('the composer reference catalogs on the agenda wire', () => {
  for (const wire of ['attention', 'agenda'] as const) {
    for (const sharesOwners of [false, true]) {
      test(`${wire} requests channel 2 and reads resolved headers with shared owners ${sharesOwners}`, async () => {
        // Arrange — a resolved list record has no document body or ask.
        const listing = agendaListing();
        const resolved = {
          projection: 'header',
          lifecycle: 'addressed',
          id: 'A4',
          title: 'Renderer chosen',
          kind: 'choice',
          subject: 'Choose a renderer',
          why: 'A decision was needed.',
          sourceRef: null,
          raisedBy: 'human',
          raisedByName: null,
          conversationCount: 2,
          resolvedAt: listing.updatedAt,
          resolvedBy: 'human',
          resolvedBySession: null,
          resolvedByName: null,
          resolutionNote: null,
          disposition: 'done',
        };
        const calls: string[] = [];
        const headers: Headers[] = [];
        const client = reader((path, init) => {
          if (path.endsWith('/skills')) return skillsListing;
          headers.push(new Headers(init?.headers));
          return { ...listing, resolved: [resolved] };
        }, calls);
        const sources: ComposerReferenceCatalogSources | undefined = sharesOwners
          ? { tasks: cards, skills: skillsListing, waitForTasks: () => undefined, waitForSkills: () => undefined }
          : undefined;
        let latest: ReturnType<typeof useComposerReferenceCatalogs> | undefined;

        // Act
        const view = render(
          <CatalogProbe
            client={client}
            onCatalogs={catalogs => {
              latest = catalogs;
            }}
            sessionId="session-a"
            sources={sources}
            wire={wire}
          />,
        );
        await flushCatalogs();

        // Assert — only open items reach the catalog; headers need no one-item read.
        expect(headers).toHaveLength(1);
        expect(headers[0]?.get(AGENDA_CHANNEL_HEADER)).toBe('2');
        expect(calls).toEqual([
          `/v1/sessions/session-a/${wire}`,
          ...(sharesOwners ? [] : ['/v1/sessions/session-a/skills']),
        ]);
        expect(latest?.attention?.map(item => item.id)).toEqual(['A3']);
        expect(latest?.failures).toEqual({});
        expect(output(view)).toBe(sharesOwners ? '1:1:1' : '-:1:1');
        run(() => view.unmount());
      });
    }
  }

  const answer = (path: string) => {
    if (path.endsWith('/skills')) return skillsListing;
    return agendaListing();
  };

  test('the hook reads its own agenda family from the route the wire names and re-reads when the wire changes', async () => {
    const calls: string[] = [];
    const client = reader(answer, calls);
    const view = render(<CatalogProbe client={client} sessionId="session-a" wire="attention" />);
    await flushCatalogs();
    expect(calls).toContain('/v1/sessions/session-a/attention');

    calls.length = 0;
    run(() => view.update(<CatalogProbe client={client} sessionId="session-a" wire="agenda" />));
    await flushCatalogs();
    expect(calls).toContain('/v1/sessions/session-a/agenda');
    expect(output(view)).toBe('-:1:1');
    run(() => view.unmount());
  });

  test('a host that shares tasks and skills still reads the agenda family from the agenda route', async () => {
    const calls: string[] = [];
    const view = render(
      <CatalogProbe
        client={reader(answer, calls)}
        sessionId="session-a"
        sources={{
          tasks: cards,
          skills: skillsListing,
          waitForTasks: () => undefined,
          waitForSkills: () => undefined,
        }}
        wire="agenda"
      />,
    );
    await flushCatalogs();
    expect(calls).toEqual(['/v1/sessions/session-a/agenda']);
    run(() => view.unmount());
  });
});
