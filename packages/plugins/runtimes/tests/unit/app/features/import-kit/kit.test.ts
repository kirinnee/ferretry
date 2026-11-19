import { describe, expect, it } from 'bun:test';
import { buildImportChange } from '../../../../../app/features/import-kit/change.ts';
import {
  IMPORT_KINDS,
  kindFound,
  kindGroups,
  kindItemIds,
  kindSkips,
} from '../../../../../app/features/import-kit/kinds.ts';
import { importChange, itemIds, skipList, toolModel } from '../../../../../app/features/import-kit/model.ts';
import { createScanStore, scanStoreFor } from '../../../../../app/features/import-kit/use-harness-scan.ts';
import type { RuntimesClient } from '../../../../../app/lib/client.ts';
import { type ImportItemId, ImportItemIdSchema } from '../../../../../contract/index.ts';
import { CLAUDE_FULL, CODEX_FULL, scanOf } from '../import-wizard/scans.ts';

const claude = toolModel('claude-code', scanOf({ claude: CLAUDE_FULL }), '2.1.0');
const codex = toolModel('codex', scanOf({ codex: CODEX_FULL }), '0.9.0');

describe('the import kit: what was found, one kind at a time', () => {
  it('every kind of Claude’s setup is its own page, and together the pages hold exactly what the r9 wizard lists (plus the model set)', () => {
    const perKind = Object.fromEntries(IMPORT_KINDS.map(kind => [kind, kindItemIds(claude, kind)]));
    expect(perKind).toEqual({
      settings: ['claude-code:settings', 'claude-code:env'],
      'model-set': ['claude-code:model-set'],
      instructions: ['claude-code:instructions'],
      skills: ['claude-code:skill:review', 'claude-code:skill:release-notes'],
      mcp: ['claude-code:mcp:notes', 'claude-code:mcp:issues'],
    });
    const wizard = new Set(itemIds(claude));
    const pages = new Set(Object.values(perKind).flat());
    // Everything the wizard offers is on a page; the only extra is the model set, which the daemon now lets a person leave out.
    expect([...wizard].filter(id => !pages.has(id))).toEqual([]);
    expect([...pages].filter(id => !wizard.has(id))).toEqual(['claude-code:model-set']);
  });

  it('Codex’s profiles are model-set choices, beside the model set the settings imply', () => {
    expect(kindItemIds(codex, 'model-set')).toEqual(['codex:model-set', 'codex:profile:fast', 'codex:profile:deep']);
    expect(kindGroups(codex, 'model-set').map(group => group.key)).toEqual(['modelSet', 'profile']);
    expect(kindGroups(codex, 'settings').map(group => group.key)).toEqual(['settings']);
  });

  it('every id a page offers is one the daemon’s grammar takes, and each says what it becomes', () => {
    for (const model of [claude, codex])
      for (const kind of IMPORT_KINDS)
        for (const group of kindGroups(model, kind))
          for (const item of group.items) {
            if (item.id !== null) expect(ImportItemIdSchema.safeParse(item.id).success).toBe(true);
            expect(item.becomes.length).toBeGreaterThan(0);
          }
  });

  it('a page with nothing found says so, so it can skip itself; no settings means no model set', () => {
    const empty = toolModel('claude-code', scanOf({ claude: {} }), null);
    for (const kind of IMPORT_KINDS) expect(kindFound(empty, kind)).toBe(false);
    const onlySkills = toolModel('claude-code', scanOf({ claude: { skills: ['review'] } }), null);
    expect(kindFound(onlySkills, 'skills')).toBe(true);
    expect(kindFound(onlySkills, 'model-set')).toBe(false);
    expect(kindFound(onlySkills, 'settings')).toBe(false);
  });

  it('hooks are never an item on any page', () => {
    for (const kind of IMPORT_KINDS) for (const id of kindItemIds(claude, kind)) expect(id).not.toContain('hook');
    expect(claude.leftAlone.hooks).toBe(3);
  });

  it('the skip list is the kind’s ids that are not ticked', () => {
    const ticked = new Set<ImportItemId>(['claude-code:mcp:notes']);
    expect(kindSkips(claude, 'mcp', ticked)).toEqual(['claude-code:mcp:issues']);
    expect(kindSkips(claude, 'mcp', new Set(kindItemIds(claude, 'mcp')))).toEqual([]);
  });
});

describe('buildImportChange equals the r9 wizard’s change for the same choices', () => {
  it('everything kept: no skip, only the runtime name', () => {
    expect(buildImportChange('claude-code', ['claude-code'], [], '  work-claude ')).toEqual({
      kind: 'setup.import',
      include: ['claude-code'],
      names: { 'claude-code': 'work-claude' },
    });
    expect(buildImportChange('claude-code', ['claude-code'], [], 'work-claude')).toEqual(
      importChange(claude, new Set(), 'work-claude'),
    );
  });

  it('the pages’ accumulated skips give the wizard’s change for the same unticked ids', () => {
    const left = new Set<ImportItemId>(['claude-code:mcp:issues', 'claude-code:env', 'claude-code:skill:review']);
    const fromPages = IMPORT_KINDS.flatMap(kind =>
      kindSkips(claude, kind, new Set(kindItemIds(claude, kind).filter(id => !left.has(id)))),
    );
    // The daemon reads `skip` as a set, so the order the pages and the wizard list it in does not matter.
    const sorted = (change: { skip?: readonly string[] }): readonly string[] => [...(change.skip ?? [])].sort();
    const pages = buildImportChange('claude-code', ['claude-code'], fromPages, 'work-claude');
    const wizard = importChange(claude, left, 'work-claude');
    expect(sorted(pages as { skip?: readonly string[] })).toEqual(sorted(wizard as { skip?: readonly string[] }));
    expect(pages).toMatchObject({ include: ['claude-code'], names: { 'claude-code': 'work-claude' } });
    expect(skipList(claude, left)).toEqual(expect.arrayContaining([...left]));
  });

  it('ticked token names and accepted updates ride along, empty ones are omitted', () => {
    expect(
      buildImportChange('claude-code', ['claude-code'], [], 'a', {
        tickedEnv: ['GH_TOKEN'],
        acceptedUpdates: ['mcp/notes'],
      }),
    ).toEqual({
      kind: 'setup.import',
      include: ['claude-code'],
      names: { 'claude-code': 'a' },
      tickedEnv: ['GH_TOKEN'],
      acceptedUpdates: ['mcp/notes'],
    });
  });

  it('drops repeats, an id the grammar refuses and an id of a harness that is not being imported', () => {
    const change = buildImportChange(
      'claude-code',
      ['claude-code'],
      [
        'claude-code:mcp:notes',
        'claude-code:mcp:notes',
        'codex:skill:review',
        'claude-code:hooks' as ImportItemId,
        'claude-code:model-set',
      ],
      'a',
    );
    expect(change).toMatchObject({ skip: ['claude-code:mcp:notes', 'claude-code:model-set'] });
  });

  it('the model-set id is accepted by the wire schema of setup.import', async () => {
    const { AccountChangeSchema } = await import('../../../../../contract/index.ts');
    const change = buildImportChange('codex', ['codex'], ['codex:model-set', 'codex:profile:fast'], 'c');
    expect(AccountChangeSchema.safeParse(change).success).toBe(true);
  });
});

describe('the scan is read once per client and shared', () => {
  const clientOf = (calls: string[], scan: unknown): RuntimesClient =>
    ({
      call: async (route: string) => {
        calls.push(route);
        if (route === 'GET /v1/runtimes/setup/scan') return scan;
        return { installed: { state: 'ok', version: '1.2.3' } };
      },
    }) as unknown as RuntimesClient;

  it('one store per client: two pages share it, another client has its own', () => {
    const one = clientOf([], scanOf({ claude: CLAUDE_FULL }));
    const other = clientOf([], scanOf({ claude: CLAUDE_FULL }));
    expect(scanStoreFor(one)).toBe(scanStoreFor(one));
    expect(scanStoreFor(other)).not.toBe(scanStoreFor(one));
  });

  it('reads the scan and both versions, and a re-read keeps what was read on screen', async () => {
    const calls: string[] = [];
    const store = createScanStore(clientOf(calls, scanOf({ claude: CLAUDE_FULL, codex: CODEX_FULL })));
    expect(store.snapshot().kind).toBe('idle');
    await store.scan();
    const first = store.snapshot();
    expect(first.kind).toBe('ready');
    if (first.kind === 'ready') expect(first.versions).toEqual({ 'claude-code': '1.2.3', codex: '1.2.3' });
    expect(calls.filter(route => route === 'GET /v1/runtimes/setup/scan')).toHaveLength(1);
    const seen: string[] = [];
    store.subscribe(() => seen.push(store.snapshot().kind));
    await store.scan();
    // No blank-out: it never went back to "reading" while the second answer was in flight.
    expect(seen).not.toContain('reading');
    expect(seen.at(-1)).toBe('ready');
  });

  it('an answer that is not a scan, read quietly, waits for a press instead of failing', async () => {
    const store = createScanStore(clientOf([], { needs: 'passkey' }));
    await store.scan(true);
    expect(store.snapshot().kind).toBe('confirm');
  });
});
