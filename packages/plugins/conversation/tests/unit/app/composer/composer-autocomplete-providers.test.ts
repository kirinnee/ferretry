/**
 * The composer's menus over the `reference.catalog` hook (lead decision Q6). Every family is read from
 * `GET /v1/ferrets/:ferretId/references?prefix=`, so these suites drive the providers with catalog answers rather than
 * with each owner's own route; the ranking, insertion and refusal rules are today's, case for case.
 */
import { describe, expect, it } from 'bun:test';
import { parseReferenceToken } from '@ferretry/app';
import type { ReferenceCatalogEntry, ReferenceCatalogPrefix } from '../../../../contract/index.ts';
import {
  type ComposerProviderContext,
  type ComposerTrigger,
  type ComposerTriggerMatch,
  composerSuggestionSwitches,
  rankComposerCandidates,
} from '../../../../app/composer/composer-autocomplete.ts';
import {
  type ComposerAutocompleteProvidersOptions,
  createComposerAutocompleteProviders,
  createDirectReferenceProviders,
  createFilesProvider,
  createReferencesProvider,
  createSkillSigilProvider,
  createSkillsProvider,
  createSurfacesProvider,
  isTaskMenuLabel,
  MAX_FILE_REFERENCE_QUERY_LENGTH,
  splitFileQuery,
  splitFileReferenceQuery,
} from '../../../../app/composer/composer-autocomplete-providers.ts';
import { daemonConnection, daemonFerretScope } from '../../../../app/composer/seam.ts';
import { type FakeCall, fakeClient } from './fake-client.ts';

const daemonA = daemonConnection('daemon-a');
const daemonB = daemonConnection('daemon-b');
const scopeA = daemonFerretScope(daemonA, 'same-ferret');
const scopeB = daemonFerretScope(daemonB, 'same-ferret');

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

type Catalogs = Partial<Record<ReferenceCatalogPrefix, readonly ReferenceCatalogEntry[] | ((q?: string) => unknown)>>;

/** A daemon whose providers answer `catalogs`; a prefix not listed is one nobody provides. */
const catalogClient = (catalogs: Catalogs) =>
  fakeClient((call: FakeCall) => {
    const prefix = call.query.prefix as ReferenceCatalogPrefix;
    const supplied = catalogs[prefix];
    const entries = typeof supplied === 'function' ? supplied(call.query.q) : supplied;
    return { ferret: call.params.ferretId, prefix, provided: supplied !== undefined, entries: entries ?? [] };
  });

const optionsOf = (
  catalogs: Catalogs,
  extra: Partial<ComposerAutocompleteProvidersOptions> = {},
): ComposerAutocompleteProvidersOptions & { readonly calls: FakeCall[] } => {
  const { client, calls } = catalogClient(catalogs);
  return { daemon: daemonA, scope: scopeA, client, calls, ...extra };
};

const NO_CARDS: readonly ReferenceCatalogEntry[] = [];

const replacements = (result: { readonly candidates: readonly { readonly replacement: string }[] }): string[] =>
  result.candidates.map(candidate => candidate.replacement);

const entry = (token: string, patch: Partial<ReferenceCatalogEntry> = {}): ReferenceCatalogEntry => ({
  token,
  label: '',
  ...patch,
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
      selector: { suffix: ':12:4', complete: true, valid: true, unsupported: 'column' },
    });
    expect(splitFileReferenceQuery('src/App.tsx:20-12').selector.valid).toBe(false);
    expect(splitFileReferenceQuery('src/App.tsx:12-').selector.complete).toBe(false);
  });

  it('reads the @ catalog for the directory, caches it, resets, and exposes refusals honestly', async () => {
    const options = optionsOf({
      '@': () => [
        entry('src/components/'),
        entry('src/app.ts'),
        entry('src/.env', { closed: true, detail: 'not served — denylisted (secrets policy)' }),
        entry('src/outside', { closed: true, detail: 'symlink leaves this ferret’s folder — not served' }),
      ],
    });
    const provider = createFilesProvider(options);
    const ranged = await provider.candidates(context('@', 'src/app.ts:12-20'));

    expect(options.calls.map(call => [call.route, call.params.ferretId, call.query])).toEqual([
      ['GET /v1/ferrets/:ferretId/references', 'same-ferret', { prefix: '@', q: 'src' }],
    ]);
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

    const incomplete = await provider.candidates(context('@', 'src/app.ts:12-'));
    expect(incomplete.candidates[1]).toMatchObject({
      label: 'app.ts:12-',
      replacement: '@src/app.ts:12-',
      append: 'none',
      disabled: false,
    });

    await provider.candidates(context('@', 'src/ap'));
    expect(options.calls).toHaveLength(1);
    provider.reset?.();
    await provider.candidates(context('@', 'src/ap'));
    expect(options.calls).toHaveLength(2);
  });

  it('offers only the direct children of the directory a provider answered for', async () => {
    const provider = createFilesProvider(
      optionsOf({ '@': () => [entry('src/a.ts'), entry('src/deep/b.ts'), entry('c.ts')] }),
    );
    expect(replacements(await provider.candidates(context('@', 'src/')))).toEqual(['@src/a.ts']);
  });

  it('does not collide when two daemons reuse the same ferret id and path', async () => {
    const a = catalogClient({ '@': [entry('same.ts')] });
    const b = catalogClient({ '@': [entry('same.ts')] });
    const providerA = createFilesProvider({ daemon: daemonA, scope: scopeA, client: a.client });
    const providerB = createFilesProvider({ daemon: daemonB, scope: scopeB, client: b.client });
    const [resultA, resultB] = await Promise.all([
      providerA.candidates(context('@', 'same')),
      providerB.candidates(context('@', 'same')),
    ]);
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
    expect(resultA.candidates[0]?.id).not.toBe(resultB.candidates[0]?.id);
    expect(resultA.candidates[0]?.replacement).toBe('@same.ts');
    expect(resultB.candidates[0]?.replacement).toBe('@same.ts');
  });

  it('shows unrepresentable paths without injecting ambiguous reference tokens', async () => {
    const provider = createFilesProvider(
      optionsOf({
        '@': ['app.ts', 'a+b.ts', 'a#1.md', '日本語.md', 'report 2026.md', 'a:12', '@notes.md', 'draft.'].map(name =>
          entry(name),
        ),
      }),
    );
    const result = await provider.candidates(context('@', ''));
    const refused = 'cannot be inserted as @file — this path has no unambiguous reference token';

    expect(result.candidates[0]).toMatchObject({
      label: 'app.ts',
      replacement: '@app.ts',
      append: 'space',
      disabled: false,
    });
    expect(result.candidates.slice(1, 4)).toMatchObject([
      { label: 'a+b.ts', replacement: '@a+b.ts', disabled: false },
      { label: 'a#1.md', replacement: '@a#1.md', disabled: false },
      { label: '日本語.md', replacement: '@日本語.md', disabled: false },
    ]);
    expect(result.candidates.slice(4)).toMatchObject([
      { label: 'report 2026.md', replacement: '@report 2026.md', disabled: true, disabledReason: refused },
      { label: 'a:12', replacement: '@a:12', disabled: true, disabledReason: refused },
      { label: '@notes.md', replacement: '@@notes.md', disabled: true, disabledReason: refused },
      { label: 'draft.', replacement: '@draft.', disabled: true, disabledReason: refused },
    ]);
    for (const candidate of result.candidates.filter(candidate => candidate.kind === 'file' && !candidate.disabled))
      expect(parseReferenceToken(candidate.replacement)).toMatchObject({ kind: 'file', path: candidate.label });
  });

  it('preserves ordinary and trailing-dot directory navigation while refusing dead prefixes', async () => {
    const provider = createFilesProvider(
      optionsOf({ '@': ['components/', 'v1./', 'report 2026/', 'a:12/'].map(name => entry(`src/${name}`)) }),
    );
    const refused = 'cannot be inserted as @file — this path has no unambiguous reference token';
    expect((await provider.candidates(context('@', 'src/'))).candidates).toMatchObject([
      { label: 'components', replacement: '@src/components/', append: 'none', disabled: false },
      { label: 'v1.', replacement: '@src/v1./', append: 'none', disabled: false },
      { label: 'report 2026', replacement: '@src/report 2026/', disabled: true, disabledReason: refused },
      { label: 'a:12', replacement: '@src/a:12/', disabled: true, disabledReason: refused },
    ]);
  });

  it('refuses the advertised-but-noncanonical column selector explicitly', async () => {
    const provider = createFilesProvider(optionsOf({ '@': [entry('app.ts')] }));
    expect((await provider.candidates(context('@', 'app.ts:12:4'))).candidates[0]).toMatchObject({
      replacement: '@app.ts:12:4',
      disabled: true,
      disabledReason: 'column selection is not part of the @file grammar',
    });
  });

  it('bounds enormous path queries before parsing, caching, or reading', async () => {
    const options = optionsOf({ '@': [] });
    const provider = createFilesProvider(options);
    const result = await provider.candidates(context('@', 'a'.repeat(MAX_FILE_REFERENCE_QUERY_LENGTH + 1)));
    expect(options.calls).toHaveLength(0);
    expect(result).toEqual({
      candidates: [],
      filterQuery: '',
      contextLabel: '@ file path',
      notice: 'File reference queries are limited to 4,096 characters; shorten the path before searching.',
    });
    await provider.candidates(context('@', 'a'.repeat(MAX_FILE_REFERENCE_QUERY_LENGTH)));
    await provider.candidates(context('@', 'short'));
    expect(options.calls).toHaveLength(1);
  });

  it('says so when a directory fills the 2,000-file bound, and not before', async () => {
    const files = (count: number) => Array.from({ length: count }, (_, i) => entry(`f${i}.ts`));
    const full = await createFilesProvider(optionsOf({ '@': files(2_000) })).candidates(context('@', ''));
    expect(full.notice).toContain('2,000 entries shown — enter a directory or refine this segment.');
    const part = await createFilesProvider(optionsOf({ '@': files(200) })).candidates(context('@', ''));
    expect(part.notice ?? '').not.toContain('entries shown');
  });

  it('a ferret whose files nobody provides offers no rows and no error', async () => {
    const result = await createFilesProvider(optionsOf({})).candidates(context('@', ''));
    expect(result.candidates).toEqual([]);
    expect(result.contextLabel).toBe('@ ferret root');
  });
});

describe('composer skills: / and $', () => {
  const SKILLS = [
    entry('floop', { detail: 'Review until every lens is satisfied.' }),
    entry('Babysit-PR', { detail: 'Watch a PR to green.' }),
  ];

  it('/ answers built-ins at once and merges the ferret’s skills, inserting /name on Claude', async () => {
    const options = optionsOf({ '/': SKILLS });
    const provider = createSkillsProvider(options);
    expect(provider.initialCandidates?.(context('/', ''))).toMatchObject({
      candidates: [{ kind: 'command', replacement: '/compact' }],
      notice: 'Loading installed skills…',
    });
    const result = await provider.candidates(context('/', ''));
    expect(replacements(result)).toEqual(['/compact', '/Babysit-PR', '/floop']);
    expect(result.contextLabel).toBe('Claude · inserts /name');
    expect(options.calls.map(call => call.query.prefix)).toEqual(['/']);
    expect(provider.initialCandidates?.(context('/', ''))).toMatchObject({ contextLabel: 'Claude · inserts /name' });
  });

  it('inserts the Codex form when the ferret runs Codex, on both sigils', async () => {
    const options = optionsOf({ '/': SKILLS, $: SKILLS }, { harness: 'codex' });
    expect(replacements(await createSkillsProvider(options).candidates(context('/', '')))).toEqual([
      '/compact',
      '$Babysit-PR',
      '$floop',
    ]);
    const sigil = await createSkillSigilProvider(options).candidates(context('$', ''));
    expect(replacements(sigil)).toEqual(['$Babysit-PR', '$floop']);
    expect(sigil.contextLabel).toBe('$ skills · Codex · inserts $name');
  });

  it('$ has nothing to show until its catalog is read, and offers skills only', async () => {
    const provider = createSkillSigilProvider(optionsOf({ $: SKILLS }));
    expect(provider.initialCandidates?.(context('$', ''))).toBeUndefined();
    expect(
      (await provider.candidates(context('$', ''))).candidates.every(candidate => candidate.kind === 'skill'),
    ).toBe(true);
  });

  it('reads a host-owned catalog from the host, never asking the daemon behind it', async () => {
    const options = optionsOf({ '/': SKILLS }, { hostedPrefixes: ['/'], getCatalog: () => [entry('lesson')] });
    expect(replacements(await createSkillsProvider(options).candidates(context('/', '')))).toEqual([
      '/compact',
      '/lesson',
    ]);
    expect(options.calls).toEqual([]);
  });

  it('says a host-owned catalog not read yet is unproved, never an empty catalog and never a second read', async () => {
    const options = optionsOf({ '/': SKILLS }, { hostedPrefixes: ['/', '$'], getCatalog: () => undefined });
    const slash = await createSkillsProvider(options).candidates(context('/', ''));
    expect(replacements(slash)).toEqual(['/compact']);
    expect(slash.notice).toContain('have not been read for this ferret yet');
    const sigil = await createSkillSigilProvider(options).candidates(context('$', ''));
    expect(sigil).toMatchObject({ candidates: [], contextLabel: '$ skills' });
    expect(options.calls).toEqual([]);
  });

  it('waits for the host read in flight before answering', async () => {
    let held: readonly ReferenceCatalogEntry[] | undefined;
    const options = optionsOf(
      {},
      {
        hostedPrefixes: ['/'],
        getCatalog: () => held,
        waitForCatalog: () =>
          new Promise<void>(resolve =>
            setTimeout(() => {
              held = [entry('floop')];
              resolve();
            }, 1),
          ),
      },
    );
    expect(replacements(await createSkillsProvider(options).candidates(context('/', '')))).toEqual([
      '/compact',
      '/floop',
    ]);
  });

  it('keeps built-ins and says why when the catalog cannot be read', async () => {
    const { client } = fakeClient(() => {
      throw new Error('skills offline');
    });
    const slash = await createSkillsProvider({ daemon: daemonA, scope: scopeA, client }).candidates(context('/', ''));
    expect(replacements(slash)).toEqual(['/compact']);
    expect(slash.notice).toBe('Installed skills unavailable: skills offline. Built-in commands still work.');
    const sigil = await createSkillSigilProvider({ daemon: daemonA, scope: scopeA, client }).candidates(
      context('$', ''),
    );
    expect(sigil.notice).toContain('Installed skills unavailable: skills offline.');
  });

  it('refuses a catalog row that is not a skill name, and a closed one', async () => {
    const provider = createSkillsProvider(
      optionsOf({ '/': [entry('two words'), entry('gone', { closed: true }), entry('ok')] }),
    );
    expect(replacements(await provider.candidates(context('/', '')))).toEqual(['/compact', '/ok']);
  });

  it('propagates an abort rather than reporting a failure the reader caused', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('closed', 'AbortError'));
    await expect(
      createSkillsProvider(optionsOf({ '/': SKILLS })).candidates(context('/', '', controller.signal)),
    ).rejects.toThrow('closed');
  });
});

describe('composer reference families', () => {
  const AGENTS = [
    entry('zelda', { label: 'relay work', detail: 'claude' }),
    entry('mona', { label: 'old run', closed: true }),
    entry('kai', { label: 'docs' }),
    entry('Not A Name'),
  ];
  const AGENDA = [
    entry('A3', { label: 'Choose a renderer', detail: 'question' }),
    entry('A4', { label: 'done', closed: true }),
  ];
  const TASKS = [
    entry('F12', { label: 'Ship autocomplete', detail: 'Build · zelda' }),
    entry('F2', { label: 'Old card', detail: 'Done', closed: true }),
    entry('F7', { label: 'Write the docs', detail: 'Plan · unassigned', aliases: ['handbook'] }),
  ];

  it('projects agents, asks and cards into canonical authored text, live agents first', async () => {
    const provider = createReferencesProvider(optionsOf({ ':': AGENTS, '!': AGENDA, '&': TASKS }));
    const agents = await provider.candidates(referenceContext(2, ''));
    expect(replacements(agents)).toEqual([':zelda', ':kai', ':mona']);
    expect(agents.candidates[2]).toMatchObject({ badge: 'finished' });
    expect(agents.limit).toBe(8);
    expect(replacements(await provider.candidates(referenceContext(3, '')))).toEqual(['!A3']);
    const tasks = await provider.candidates(referenceContext(4, ''));
    expect(replacements(tasks)).toEqual(['&F12', '&F7']);
    expect(tasks.candidates[0]).toMatchObject({ label: '&F12', detail: 'Ship autocomplete · Build · zelda' });
    expect(tasks.limit).toBe(50);
  });

  it('hides closed cards until the reader types one id exactly', async () => {
    const provider = createReferencesProvider(optionsOf({ '&': TASKS }));
    expect(replacements(await provider.candidates(referenceContext(4, 'f2')))).toContain('&F2');
    expect(replacements(await provider.candidates(referenceContext(4, 'F')))).not.toContain('&F2');
  });

  it('finds a card by a word only its aliases carry', async () => {
    const result = await createReferencesProvider(optionsOf({ '&': TASKS })).candidates(
      referenceContext(4, 'handbook'),
    );
    expect(rankComposerCandidates(result.candidates, 'handbook', result.limit).map(c => c.replacement)).toEqual([
      '&F7',
    ]);
  });

  it('a prefix nobody provides offers no suggestions and no error', async () => {
    const options = optionsOf({});
    const provider = createReferencesProvider(options);
    for (const tier of [2, 3, 4]) {
      const result = await provider.candidates(referenceContext(tier, ''));
      expect(result.candidates).toEqual([]);
      expect(result.notice).toBeUndefined();
    }
    for (const direct of createDirectReferenceProviders(options)) {
      const result = await direct.candidates(context(direct.trigger, ''));
      expect(result.candidates).toEqual([]);
      expect(result.notice).toBeUndefined();
    }
  });

  it('says a family it could not read is not read, and the reference can still be typed', async () => {
    const { client } = fakeClient(() => {
      throw new Error('board offline');
    });
    const result = await createReferencesProvider({ daemon: daemonA, scope: scopeA, client }).candidates(
      referenceContext(4, ''),
    );
    expect(result.candidates).toEqual([]);
    expect(result.notice).toBe('Not read for this ferret: board offline. A reference can still be typed.');
  });

  it('teaches the tiers when the reader over-types @', async () => {
    const provider = createReferencesProvider(optionsOf({}));
    const result = provider.initialCandidates?.(referenceContext(5, ''));
    expect(result).toMatchObject({ candidates: [], contextLabel: '@@@@@ has no reference family' });
    expect(result?.notice).toContain('use %');
  });

  it('reports a family not read yet as unknown rather than as an empty fact', async () => {
    const provider = createReferencesProvider(optionsOf({ '!': AGENDA }));
    expect(provider.initialCandidates?.(referenceContext(3, ''))).toBeUndefined();
    await provider.candidates(referenceContext(3, ''));
    expect(provider.initialCandidates?.(referenceContext(3, ''))).toMatchObject({ contextLabel: 'Agenda' });
  });

  it('opens each family from its own sigil, from the very same read as the ladder', async () => {
    const options = optionsOf({ ':': AGENTS, '!': AGENDA, '&': TASKS });
    const providers = createComposerAutocompleteProviders(options);
    const ladder = providers.find(provider => provider.trigger === '@');
    const byTrigger = (trigger: ComposerTrigger) => providers.find(provider => provider.trigger === trigger);
    await ladder?.candidates(referenceContext(3, ''));
    const direct = await byTrigger('!')?.candidates(context('!', ''));
    expect(direct?.contextLabel).toBe('! open agenda items');
    expect(replacements(direct ?? { candidates: [] })).toEqual(['!A3']);
    expect(replacements((await byTrigger('&')?.candidates(context('&', ''))) ?? { candidates: [] })).toEqual([
      '&F12',
      '&F7',
    ]);
    expect(replacements((await byTrigger(':')?.candidates(context(':', ''))) ?? { candidates: [] })).toEqual([
      ':zelda',
      ':kai',
      ':mona',
    ]);
    expect(options.calls.map(call => call.query.prefix).sort()).toEqual(['!', '&', ':']);
  });

  it('publishes a stable snapshot per family, and a new one only when that family moves', () => {
    let agenda: readonly ReferenceCatalogEntry[] = AGENDA;
    const options = optionsOf(
      {},
      { hostedPrefixes: ['!', '&'], getCatalog: prefix => (prefix === '!' ? agenda : NO_CARDS) },
    );
    const ladder = createReferencesProvider(options);
    const [, attention] = createDirectReferenceProviders(options);
    const first = ladder.snapshotKey;
    expect(ladder.snapshotKey).toBe(first);
    expect(attention?.snapshotKey).toBe(AGENDA);
    agenda = [...AGENDA];
    expect(ladder.snapshotKey).not.toBe(first);
    expect(attention?.snapshotKey).toBe(agenda);
  });

  it('answers shouldOpen from the switches, per family', () => {
    const symbols = composerSuggestionSwitches('symbols', true);
    const ladder = createReferencesProvider(optionsOf({}, { suggestions: symbols }));
    const directs = createDirectReferenceProviders(optionsOf({}, { suggestions: symbols }));
    expect(ladder.shouldOpen?.(match('@', '', 1))).toBe(true);
    expect(ladder.shouldOpen?.(match('@', '', 3))).toBe(false);
    expect(directs.every(provider => provider.shouldOpen?.(match(provider.trigger, '')) === true)).toBe(true);
    const ladderOnly = createDirectReferenceProviders(
      optionsOf({}, { suggestions: composerSuggestionSwitches('ladder', true) }),
    );
    expect(ladderOnly.some(provider => provider.shouldOpen?.(match(provider.trigger, '')) === true)).toBe(false);
  });

  it('builds one provider per trigger, refusing crossed scopes at the boundary', () => {
    const providers = createComposerAutocompleteProviders(optionsOf({}));
    expect(providers.map(provider => provider.trigger)).toEqual(['/', '$', '@', ':', '!', '&', '%']);
    expect(() => createComposerAutocompleteProviders({ daemon: daemonB, scope: scopeA })).toThrow(
      'composer scope must belong to the requested daemon',
    );
  });

  it('names the task menus the "Include agent tasks" switch applies to', () => {
    expect(isTaskMenuLabel('Tasks')).toBe(true);
    expect(isTaskMenuLabel('& tasks')).toBe(true);
    expect(isTaskMenuLabel('Agenda')).toBe(false);
    expect(isTaskMenuLabel(undefined)).toBe(false);
  });
});

describe('composer ferret surfaces', () => {
  it('offers each open terminal and page as its canonical token, with what its owner says about it', async () => {
    const options = optionsOf({
      '%terminal': [
        entry('t1', { label: 'build shell', detail: '1 viewer · opened by you' }),
        entry('t2', { label: 'gone', closed: true }),
      ],
      '%browser': [entry('p1', { label: 'Docs', detail: 'unrecorded' })],
    });
    const result = await createSurfacesProvider(options).candidates(context('%', ''));
    expect(result.candidates).toMatchObject([
      {
        label: 'build shell',
        replacement: '%terminal:t1',
        detail: '%terminal:t1 · 1 viewer · opened by you',
        badge: 'terminal',
      },
      { label: 'Docs', replacement: '%browser:p1', badge: 'browser' },
    ]);
    expect(result.notice).toContain('Ownership is what the daemon recorded');
  });

  it('says the ferret has no addressable surface rather than offering an empty list silently', async () => {
    const result = await createSurfacesProvider(optionsOf({})).candidates(context('%', ''));
    expect(result.candidates).toEqual([]);
    expect(result.notice).toBe('This ferret has no open terminal to address yet. Open one from the Terminal pane.');
  });

  it('reads once per menu and forgets the listing after a send', async () => {
    const options = optionsOf({ '%terminal': [entry('t1', { label: 'shell' })] });
    const provider = createSurfacesProvider(options);
    await provider.candidates(context('%', ''));
    await provider.candidates(context('%', 'sh'));
    expect(options.calls).toHaveLength(2);
    provider.reset?.();
    await provider.candidates(context('%', ''));
    expect(options.calls).toHaveLength(4);
  });

  it('surfaces a failure to the caller when no surface could be read', async () => {
    const { client } = fakeClient(() => {
      throw new Error('terminals offline');
    });
    await expect(
      createSurfacesProvider({ daemon: daemonA, scope: scopeA, client }).candidates(context('%', '')),
    ).rejects.toThrow('terminals offline');
  });

  it('refuses an already-aborted request', async () => {
    const controller = new AbortController();
    controller.abort(new Error('closed'));
    await expect(createSurfacesProvider(optionsOf({})).candidates(context('%', '', controller.signal))).rejects.toThrow(
      'closed',
    );
  });
});
