import { describe, expect, it } from 'bun:test';
import type { Pin, TerminalListView } from '@ferretry/protocol';
import type {
  ComposerProviderContext,
  ComposerTrigger,
  ComposerTriggerMatch,
} from '../../src/components/composer-autocomplete.ts';
import {
  type ComposerAttentionItem,
  type ComposerTaskSummary,
  createComposerAutocompleteProviders,
  createFilesProvider,
  createReferencesProvider,
  createSkillsProvider,
  createSurfacesProvider,
  loadSkillsCatalog,
  splitFileQuery,
  splitFileReferenceQuery,
} from '../../src/components/composer-autocomplete-providers.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import type { DaemonFetch } from '../../src/lib/runtime-models.ts';
import { sessionView } from '../support/sessions.ts';

const daemonA = daemonConnection({
  daemonId: 'daemon-a',
  baseUrl: 'https://a.example.test',
  deviceToken: 'token-a',
});
const daemonB = daemonConnection({
  daemonId: 'daemon-b',
  baseUrl: 'https://b.example.test',
  deviceToken: 'token-b',
});
const scopeA = daemonSessionScope(daemonA, 'same/session');
const scopeB = daemonSessionScope(daemonB, 'same/session');

const match = (trigger: ComposerTrigger, query: string, referenceTier?: number): ComposerTriggerMatch => {
  const triggerText = trigger === '@' ? '@'.repeat(referenceTier ?? 1) : trigger;
  return {
    trigger,
    triggerText,
    ...(trigger === '@' ? { referenceTier: referenceTier ?? 1 } : {}),
    query,
    start: 0,
    end: query.length + triggerText.length,
    caret: query.length + triggerText.length,
  };
};

const context = (
  trigger: ComposerTrigger,
  query: string,
  signal = new AbortController().signal,
): ComposerProviderContext => ({ query, match: match(trigger, query), signal });

const referenceContext = (
  tier: number,
  query: string,
  signal = new AbortController().signal,
): ComposerProviderContext => ({ query, match: match('@', query, tier), signal });

const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(next => {
    resolve = next;
  });
  return { promise, resolve };
};

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

describe('composer skills provider', () => {
  it('binds transport, auth, cache, provider ids, and candidate ids to the full daemon/session scope', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher: DaemonFetch = async (input, init = {}) => {
      calls.push({ url: String(input), init });
      return json({
        harness: 'codex',
        harnessHomeResolved: false,
        skills: [
          { name: 'Zebra', description: 'Last alphabetically' },
          { name: 'summary', description: 'Give a fast recap' },
        ],
      });
    };
    const providerA = createSkillsProvider({ daemon: daemonA, scope: scopeA, harness: 'codex', fetcher });
    const providerB = createSkillsProvider({ daemon: daemonB, scope: scopeB, harness: 'codex', fetcher });

    expect(providerA.id).not.toBe(providerB.id);
    expect(decodeURIComponent(providerA.id)).toContain('["daemon-a","same/session"]');
    expect(providerA.initialCandidates?.(context('/', ''))).toMatchObject({
      candidates: [{ kind: 'command', replacement: '/compact' }],
      notice: 'Loading installed skills…',
    });

    const [resultA, resultB] = await Promise.all([
      providerA.candidates(context('/', 'sum')),
      providerB.candidates(context('/', 'sum')),
    ]);
    expect(calls.map(call => call.url)).toEqual([
      'https://a.example.test/v1/sessions/same%2Fsession/skills',
      'https://b.example.test/v1/sessions/same%2Fsession/skills',
    ]);
    expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe('Bearer token-a');
    expect(new Headers(calls[1]?.init.headers).get('authorization')).toBe('Bearer token-b');
    expect(calls.every(call => call.init.credentials === 'include')).toBe(true);
    expect(resultA.contextLabel).toBe('Codex · inserts $name');
    expect(
      resultA.candidates.filter(candidate => candidate.kind === 'skill').map(candidate => candidate.label),
    ).toEqual(['summary', 'Zebra']);
    expect(resultA.candidates.find(candidate => candidate.kind === 'skill')).toMatchObject({
      replacement: '$summary',
      append: 'space',
    });
    expect(resultA.candidates.map(candidate => candidate.id)).not.toEqual(
      resultB.candidates.map(candidate => candidate.id),
    );
    expect(resultA.candidates.every(candidate => decodeURIComponent(candidate.id).includes('daemon-a'))).toBe(true);
    expect(resultB.candidates.every(candidate => decodeURIComponent(candidate.id).includes('daemon-b'))).toBe(true);

    await providerA.candidates(context('/', 'z'));
    expect(calls).toHaveLength(2);
  });

  it('normalizes a catalog while preserving the safe legacy harness fallback', async () => {
    const catalog = await loadSkillsCatalog(daemonA, scopeA, new AbortController().signal, async () =>
      json({
        harness: 'unexpected',
        skills: [
          { name: 'Zebra', description: 'z' },
          { name: 'apple', description: 'a', scope: 'project', origin: 'both' },
        ],
      }),
    );
    expect(catalog).toEqual({
      harness: 'claude',
      skills: [
        { name: 'apple', description: 'a', scope: 'project', origin: 'both' },
        { name: 'Zebra', description: 'z' },
      ],
    });
  });

  it('keeps built-ins on daemon/auth failures and never caches an aborted late answer', async () => {
    const denied = createSkillsProvider({
      daemon: daemonA,
      scope: scopeA,
      harness: 'claude',
      fetcher: async () => json({}, 401),
    });
    const fallback = await denied.candidates(context('/', ''));
    expect(fallback.candidates.map(candidate => candidate.replacement)).toEqual(['/compact']);
    expect(fallback.notice).toContain('daemon rejected this device credential');
    expect(fallback.notice).toContain('Built-in commands still work');

    const responses: Array<ReturnType<typeof deferred<Response>>> = [];
    let requests = 0;
    const provider = createSkillsProvider({
      daemon: daemonA,
      scope: scopeA,
      fetcher: () => {
        requests += 1;
        const response = deferred<Response>();
        responses.push(response);
        return response.promise;
      },
    });
    const abort = new AbortController();
    const first = provider.candidates(context('/', '', abort.signal));
    abort.abort('stopped');
    responses[0]?.resolve(json({ harness: 'claude', skills: [] }));
    await expect(first).rejects.toBe('stopped');

    const second = provider.candidates(context('/', ''));
    responses[1]?.resolve(json({ harness: 'claude', skills: [] }));
    await second;
    expect(requests).toBe(2);
  });

  it.each([
    [403, 'this paired device may not enumerate session skills'],
    [404, 'skill suggestions are unavailable on this daemon'],
  ] as const)('explains an empty daemon response with its status-specific fallback (%i)', async (status, message) => {
    const provider = createSkillsProvider({
      daemon: daemonA,
      scope: scopeA,
      fetcher: async () => json({}, status),
    });

    const result = await provider.candidates(context('/', ''));

    expect(result.notice).toContain(message);
    expect(result.notice).toContain('Built-in commands still work');
  });

  it('preserves a daemon error code while falling back from an empty error message', async () => {
    try {
      await loadSkillsCatalog(daemonA, scopeA, new AbortController().signal, async () =>
        json({ error: ' ', code: 'skills_denied' }, 403),
      );
      throw new Error('expected the skills catalog request to fail');
    } catch (error) {
      expect(error).toMatchObject({ code: 'skills_denied' });
    }
  });
});

describe('composer files provider', () => {
  it('keeps selectors out of the daemon lookup and canonicalizes supported ranges', () => {
    expect(splitFileQuery('src/components/Com')).toEqual({ directory: 'src/components', leaf: 'Com' });
    expect(splitFileReferenceQuery('src/App.tsx#L12-L20')).toEqual({
      directory: 'src',
      leaf: 'App.tsx',
      selector: { suffix: ':12-20', complete: true, valid: true },
    });
    expect(splitFileReferenceQuery('src/App.tsx:12:4')).toMatchObject({
      directory: 'src',
      leaf: 'App.tsx',
      selector: { suffix: ':12:4', complete: true, valid: true },
    });
    expect(splitFileReferenceQuery('src/App.tsx:20-12').selector.valid).toBe(false);
    expect(splitFileReferenceQuery('src/App.tsx:12-').selector.complete).toBe(false);
  });

  it('uses the scoped file API, caches only its scope, resets, and exposes refusals honestly', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher: DaemonFetch = async (input, init = {}) => {
      calls.push({ url: String(input), init });
      return json({
        path: 'src',
        entries: [
          { name: 'components', type: 'dir' },
          { name: 'app.ts', type: 'file' },
          { name: '.env', type: 'file', denied: true },
          { name: 'outside', type: 'symlink', escapes: true },
        ],
      });
    };
    const provider = createFilesProvider({ daemon: daemonA, scope: scopeA, fetcher });
    const ranged = await provider.candidates(context('@', 'src/app.ts:12-20'));

    expect(calls[0]?.url).toBe('https://a.example.test/v1/sessions/same%2Fsession/fs?path=src');
    expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe('Bearer token-a');
    expect(calls[0]?.init.credentials).toBe('include');
    expect(ranged.filterQuery).toBe('app.ts');
    expect(ranged.candidates[0]).toMatchObject({
      kind: 'directory',
      replacement: '@src/components/',
      append: 'none',
      disabled: true,
      disabledReason: 'line selection applies to files, not folders',
    });
    expect(ranged.candidates[1]).toMatchObject({
      label: 'app.ts:12-20',
      replacement: '@src/app.ts:12-20',
      append: 'space',
      disabled: false,
    });
    expect(ranged.candidates[2]).toMatchObject({ disabled: true });
    expect(ranged.candidates[2]?.disabledReason).toContain('secrets');
    expect(ranged.candidates[3]?.disabledReason).toContain('leaves');
    expect(ranged.candidates.every(candidate => decodeURIComponent(candidate.id).includes('daemon-a'))).toBe(true);

    await provider.candidates(context('@', 'src/ap'));
    expect(calls).toHaveLength(1);
    provider.reset?.();
    await provider.candidates(context('@', 'src/ap'));
    expect(calls).toHaveLength(2);
  });

  it('does not collide when two daemons reuse the same session id and path', async () => {
    const urls: string[] = [];
    const fetcher: DaemonFetch = async input => {
      urls.push(String(input));
      return json({ entries: [{ name: 'same.ts', type: 'file' }] });
    };
    const providerA = createFilesProvider({ daemon: daemonA, scope: scopeA, fetcher });
    const providerB = createFilesProvider({ daemon: daemonB, scope: scopeB, fetcher });
    const [resultA, resultB] = await Promise.all([
      providerA.candidates(context('@', 'same')),
      providerB.candidates(context('@', 'same')),
    ]);

    expect(urls).toEqual([
      'https://a.example.test/v1/sessions/same%2Fsession/fs',
      'https://b.example.test/v1/sessions/same%2Fsession/fs',
    ]);
    expect(resultA.candidates[0]?.id).not.toBe(resultB.candidates[0]?.id);
    expect(resultA.candidates[0]?.replacement).toBe('@same.ts');
    expect(resultB.candidates[0]?.replacement).toBe('@same.ts');
  });
});

describe('composer reference families', () => {
  const agent = sessionView('agent-session', {
    config: {
      teammate: 'Ottis',
      name: 'Build the reference picker',
      label: 'composer-work',
      agent: 'codex-auto-loge',
      modelHint: 'gpt-5.6-sol',
    },
    state: { status: 'tool_running', observedModel: 'gpt-5.6-sol' },
  });
  const tasks: readonly ComposerTaskSummary[] = [{ id: 'F12', title: 'Composer autocomplete', status: 'in_progress' }];
  const attention: readonly ComposerAttentionItem[] = [
    { id: 'A3', subject: 'Choose the rollout window', source: 'question' },
  ];
  const pins: readonly Pin[] = [
    {
      id: '11111111-1111-4111-8111-111111111111',
      at: 1,
      kind: 'note',
      text: 'Ship after QA',
      by: 'agent',
      createdBy: 'agent-session',
      createdByName: 'ottis',
    },
  ];

  const providerFor = (which: 'a' | 'b') => {
    const scope = which === 'a' ? scopeA : scopeB;
    const daemon = which === 'a' ? daemonA : daemonB;
    return createReferencesProvider({
      daemon,
      scope,
      fetcher: async () => {
        throw new Error('store-backed tiers must not fetch');
      },
      getSessions: received => {
        expect(received).toEqual(scope);
        return [agent];
      },
      getTasks: received => {
        expect(received).toEqual(scope);
        return tasks;
      },
      getAttentionItems: received => {
        expect(received).toEqual(scope);
        return attention;
      },
      getPins: received => {
        expect(received).toEqual(scope);
        return pins;
      },
    });
  };

  it('projects daemon-scoped agents, tasks, attention, and pins into canonical authored text', () => {
    const provider = providerFor('a');
    const agents = provider.initialCandidates?.(referenceContext(2, 'ott'));
    const taskRows = provider.initialCandidates?.(referenceContext(3, 'F12'));
    const attentionRows = provider.initialCandidates?.(referenceContext(4, 'A3'));
    const pinRows = provider.initialCandidates?.(referenceContext(5, 'ship'));

    expect(agents?.candidates[0]).toMatchObject({
      kind: 'agent',
      label: 'ottis',
      badge: 'tool running',
      replacement: ':ottis',
    });
    expect(agents?.candidates[0]?.detail).toContain('composer-work · Build the reference picker');
    expect(taskRows?.candidates[0]).toMatchObject({
      kind: 'task',
      label: '&F12',
      badge: 'In progress',
      replacement: '&F12',
    });
    expect(attentionRows?.candidates[0]).toMatchObject({
      kind: 'attention',
      label: '!A3',
      detail: 'Choose the rollout window',
      replacement: '!A3',
    });
    expect(pinRows?.candidates[0]).toMatchObject({
      kind: 'pin',
      label: 'pin: Ship after QA',
      detail: 'Note pin · Pinned by ottis',
      replacement: 'pin: Ship after QA',
    });
    for (const result of [agents, taskRows, attentionRows, pinRows]) {
      expect(result?.candidates.every(candidate => decodeURIComponent(candidate.id).includes('daemon-a'))).toBe(true);
      expect(result?.candidates.every(candidate => decodeURIComponent(candidate.id).includes('same/session'))).toBe(
        true,
      );
    }
  });

  it('keeps identical records collision-safe across daemons and publishes live snapshot changes', () => {
    const providerA = providerFor('a');
    const providerB = providerFor('b');
    expect(providerA.id).not.toBe(providerB.id);
    expect(providerA.initialCandidates?.(referenceContext(2, 'ott'))?.candidates[0]?.id).not.toBe(
      providerB.initialCandidates?.(referenceContext(2, 'ott'))?.candidates[0]?.id,
    );
    expect(providerA.initialCandidates?.(referenceContext(5, 'ship'))?.candidates[0]?.id).not.toBe(
      providerB.initialCandidates?.(referenceContext(5, 'ship'))?.candidates[0]?.id,
    );

    let liveTasks: readonly ComposerTaskSummary[] = tasks;
    const live = createReferencesProvider({
      daemon: daemonA,
      scope: scopeA,
      getTasks: () => liveTasks,
    });
    const before = live.snapshotKey;
    liveTasks = [{ id: 'F13', title: 'Updated snapshot', status: 'blocked' }];
    expect(live.snapshotKey).not.toBe(before);
    expect(live.initialCandidates?.(referenceContext(3, 'F13'))?.candidates[0]).toMatchObject({
      label: '&F13',
      badge: 'Blocked',
    });
  });

  it('warms only the requested store and teaches unsupported tiers', async () => {
    const warmed: string[] = [];
    const provider = createReferencesProvider({
      daemon: daemonA,
      scope: scopeA,
      waitForTasks: async (daemon, scope, signal) => {
        expect({ daemon, scope, signal }).toMatchObject({ daemon: daemonA, scope: scopeA });
        warmed.push('tasks');
      },
      waitForAttentionItems: async () => {
        warmed.push('attention');
      },
      waitForPins: async () => {
        warmed.push('pins');
      },
    });

    await provider.candidates(referenceContext(3, ''));
    await provider.candidates(referenceContext(4, ''));
    await provider.candidates(referenceContext(5, ''));
    expect(warmed).toEqual(['tasks', 'attention', 'pins']);
    const unsupported = await provider.candidates(referenceContext(6, ''));
    expect(unsupported.candidates).toEqual([]);
    expect(unsupported.notice).toContain('one to five @ signs');
    expect(provider.legend).toHaveLength(5);
  });

  it('builds one action, one reference and one surface provider, refusing crossed scopes at the boundary', () => {
    expect(
      createComposerAutocompleteProviders({ daemon: daemonA, scope: scopeA }).map(provider => provider.trigger),
    ).toEqual(['/', '@', '%']);
    expect(() => createSkillsProvider({ daemon: daemonA, scope: scopeB })).toThrow('composer scope must belong');
    expect(() => createFilesProvider({ daemon: daemonA, scope: scopeB })).toThrow('composer scope must belong');
    expect(() => createReferencesProvider({ daemon: daemonA, scope: scopeB })).toThrow('composer scope must belong');
    expect(() => createSurfacesProvider({ daemon: daemonA, scope: scopeB })).toThrow('composer scope must belong');
  });
});

describe('composer session surfaces', () => {
  const TERMINAL = 'a1b2c3d4e5f6';

  const listing = (ids: readonly string[], sessionId = 'same/session'): TerminalListView =>
    ({
      sessionId,
      terminals: ids.map((id, index) => ({
        id,
        sessionId,
        title: `Terminal ${index + 1}`,
        state: 'running',
        cols: 80,
        rows: 24,
        viewers: index,
        createdAt: '2026-08-01T10:00:00.000Z',
        lastActivityAt: '2026-08-01T10:05:00.000Z',
        ...(index === 0 ? {} : { idleDeadline: '2026-08-01T11:05:00.000Z' }),
      })),
      limits: {
        perSession: 6,
        global: 24,
        runningGlobal: ids.length,
        idleTimeoutSeconds: 900,
        scrollbackLines: 5_000,
      },
    }) satisfies TerminalListView;

  it('offers each live terminal as its canonical token, with viewers and honest provenance', async () => {
    const provider = createSurfacesProvider({
      daemon: daemonA,
      scope: scopeA,
      listTerminals: async () => listing([TERMINAL]),
    });

    const result = await provider.candidates(context('%', ''));

    expect(provider.trigger).toBe('%');
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.replacement).toBe(`%terminal:${TERMINAL}`);
    expect(result.candidates[0]?.kind).toBe('surface');
    expect(result.candidates[0]?.label).toBe('Terminal 1');
    expect(result.candidates[0]?.detail).toContain('0 viewers');
    expect(result.candidates[0]?.detail).toContain('owner unrecorded');
    expect(result.contextLabel).toBe('% session surfaces');
    expect(result.notice).toContain('does not record who opened a terminal');
  });

  it('says the session has no addressable terminal rather than offering an empty list silently', async () => {
    const provider = createSurfacesProvider({
      daemon: daemonA,
      scope: scopeA,
      listTerminals: async () => listing([]),
    });

    const result = await provider.candidates(context('%', ''));

    expect(result.candidates).toEqual([]);
    expect(result.notice).toContain('no open terminal to address');
  });

  it('never offers another session terminals as this session surfaces', async () => {
    const provider = createSurfacesProvider({
      daemon: daemonA,
      scope: scopeA,
      listTerminals: async () => listing([TERMINAL], 'another/session'),
    });

    const result = await provider.candidates(context('%', ''));

    expect(result.candidates).toEqual([]);
  });

  it('lists once per token and forgets the listing after a send', async () => {
    let calls = 0;
    const provider = createSurfacesProvider({
      daemon: daemonA,
      scope: scopeA,
      listTerminals: async () => {
        calls += 1;
        return listing([TERMINAL]);
      },
    });

    await provider.candidates(context('%', ''));
    await provider.candidates(context('%', 'term'));
    expect(calls).toBe(1);

    provider.reset?.();
    await provider.candidates(context('%', ''));
    expect(calls).toBe(2);
  });

  it('surfaces a listing failure to the caller instead of answering with an empty session', async () => {
    const provider = createSurfacesProvider({
      daemon: daemonA,
      scope: scopeA,
      listTerminals: async () => {
        throw new Error('daemon unreachable');
      },
    });

    await expect(provider.candidates(context('%', ''))).rejects.toThrow('daemon unreachable');
  });

  it('refuses an already-aborted request and one aborted while listing', async () => {
    const aborted = new AbortController();
    aborted.abort();
    const provider = createSurfacesProvider({
      daemon: daemonA,
      scope: scopeA,
      listTerminals: async () => listing([TERMINAL]),
    });

    await expect(provider.candidates(context('%', '', aborted.signal))).rejects.toThrow();

    const midflight = new AbortController();
    const during = createSurfacesProvider({
      daemon: daemonA,
      scope: scopeA,
      listTerminals: async () => {
        midflight.abort();
        return listing([TERMINAL]);
      },
    });
    await expect(during.candidates(context('%', '', midflight.signal))).rejects.toThrow();
  });
});
