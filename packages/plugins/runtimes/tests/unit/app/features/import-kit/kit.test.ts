import { describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import { buildImportChange } from '../../../../../app/features/import-kit/change.ts';
import {
  IMPORT_KINDS,
  kindFound,
  kindGroups,
  kindItemIds,
  kindSkips,
} from '../../../../../app/features/import-kit/kinds.ts';
import { importChange, itemIds, skipList, toolModel } from '../../../../../app/features/import-kit/model.ts';
import {
  createScanStore,
  readSetupScanAhead,
  scanStoreFor,
  useHarnessScan,
} from '../../../../../app/features/import-kit/use-harness-scan.ts';
import type { RuntimesClient } from '../../../../../app/lib/client.ts';
import { type ImportItemId, ImportItemIdSchema } from '../../../../../contract/index.ts';
import { CLAUDE_FULL, CODEX_FULL, scanOf } from '../import-wizard/scans.ts';
import { interact, mount } from '../../../support/dom.ts';

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
    expect(scanStoreFor(one, 'run-1')).toBe(scanStoreFor(one, 'run-1'));
    expect(scanStoreFor(other, 'run-1')).not.toBe(scanStoreFor(one, 'run-1'));
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

  it('C59 O8-4 the scan read ahead (setup opening) is the first read of every store on that machine: one scan for both tools', async () => {
    const calls: string[] = [];
    const client = clientOf(calls, scanOf({ claude: CLAUDE_FULL, codex: CODEX_FULL }));
    readSetupScanAhead(client);
    // Asked again while it is young: still one read.
    readSetupScanAhead(client);
    const codexPages = createScanStore(client);
    const claudePages = createScanStore(client);
    await Promise.all([codexPages.scan(true, true), claudePages.scan(true, true)]);
    expect(codexPages.snapshot().kind).toBe('ready');
    expect(claudePages.snapshot().kind).toBe('ready');
    expect(calls.filter(route => route === 'GET /v1/runtimes/setup/scan')).toHaveLength(1);
    // A press, a re-read after a sign-in and the Settings re-import (no `ahead`) always ask the machine.
    await codexPages.scan(false);
    await claudePages.scan();
    await createScanStore(client).scan(true, false);
    expect(calls.filter(route => route === 'GET /v1/runtimes/setup/scan')).toHaveLength(4);
  });

  it('C59 O8-4 a read ahead that failed is ONE page’s failed read (with its retry); the next store asks the machine', async () => {
    const calls: string[] = [];
    let fail = true;
    const client = {
      call: async (route: string) => {
        calls.push(route);
        if (route !== 'GET /v1/runtimes/setup/scan') return { installed: { state: 'ok', version: '1.2.3' } };
        if (fail) throw new Error('This machine did not answer.');
        return scanOf({ claude: CLAUDE_FULL });
      },
    } as unknown as RuntimesClient;
    readSetupScanAhead(client);
    await new Promise(resolve => setTimeout(resolve, 0));
    fail = false;
    const first = createScanStore(client);
    await first.scan(true, true);
    expect(first.snapshot().kind).toBe('failed');
    const second = createScanStore(client);
    await second.scan(true, true);
    expect(second.snapshot().kind).toBe('ready');
    expect(calls.filter(route => route === 'GET /v1/runtimes/setup/scan')).toHaveLength(2);
  });

  it('C59 O8-4 each setup flow opening reads afresh (one in flight is shared), so a flow never shows an earlier read', async () => {
    const calls: string[] = [];
    const client = clientOf(calls, scanOf({ claude: CLAUDE_FULL }));
    readSetupScanAhead(client);
    readSetupScanAhead(client);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(calls.filter(route => route === 'GET /v1/runtimes/setup/scan')).toHaveLength(1);
    readSetupScanAhead(client);
    expect(calls.filter(route => route === 'GET /v1/runtimes/setup/scan')).toHaveLength(2);
  });

  it('an answer that is not a scan, read quietly, waits for a press instead of failing', async () => {
    const store = createScanStore(clientOf([], { needs: 'passkey' }));
    await store.scan(true);
    expect(store.snapshot().kind).toBe('confirm');
  });
});

describe('the model set is its own choice (r10 O8)', () => {
  it('the onboarding pages are independent: leaving Settings out does not leave the model set out', () => {
    const settingsPageSkips = kindSkips(claude, 'settings', new Set());
    expect(settingsPageSkips).toEqual(['claude-code:settings', 'claude-code:env']);
    const change = buildImportChange('claude-code', ['claude-code'], settingsPageSkips, 'work-claude');
    expect(change).toMatchObject({ skip: ['claude-code:settings', 'claude-code:env'] });
    expect((change as { skip: string[] }).skip).not.toContain('claude-code:model-set');
  });

  it('leaving the model set out on its own page skips only it', () => {
    const modelPageSkips = kindSkips(claude, 'model-set', new Set());
    expect(buildImportChange('claude-code', ['claude-code'], modelPageSkips, 'w')).toMatchObject({
      skip: ['claude-code:model-set'],
    });
  });

  it('the r9 wizard is unchanged: Settings left out takes the models those settings name with it, and only then', () => {
    expect(importChange(claude, new Set(['claude-code:settings']), 'w')).toMatchObject({
      skip: ['claude-code:settings', 'claude-code:model-set'],
    });
    expect(importChange(claude, new Set(['claude-code:mcp:notes']), 'w')).toMatchObject({
      skip: ['claude-code:mcp:notes'],
    });
    expect(importChange(codex, new Set(['codex:settings']), 'w')).toMatchObject({
      skip: ['codex:settings', 'codex:model-set'],
    });
  });
});

describe('the scan belongs to one run', () => {
  const countingClient = (calls: string[]): RuntimesClient =>
    ({
      call: async (route: string) => {
        calls.push(route);
        if (route === 'GET /v1/runtimes/setup/scan') return scanOf({ claude: CLAUDE_FULL });
        return { installed: { state: 'ok', version: '1.2.3' } };
      },
    }) as unknown as RuntimesClient;
  const scans = (calls: string[]): number => calls.filter(route => route === 'GET /v1/runtimes/setup/scan').length;

  it('a second run on the same client has its own store, which reads the machine again', async () => {
    const calls: string[] = [];
    const client = countingClient(calls);
    const first = scanStoreFor(client, 'run-1');
    await first.scan();
    expect(scans(calls)).toBe(1);
    // Same run: the same store, already read.
    expect(scanStoreFor(client, 'run-1')).toBe(first);
    expect(scanStoreFor(client, 'run-1').snapshot().kind).toBe('ready');
    // Next run: a fresh store that has read nothing, so its first page reads again.
    const second = scanStoreFor(client, 'run-2');
    expect(second).not.toBe(first);
    expect(second.snapshot().kind).toBe('idle');
    await second.scan();
    expect(scans(calls)).toBe(2);
  });

  it('a failure does not outlive its run', async () => {
    let failing = true;
    const client = {
      call: async (route: string) => {
        if (failing && route === 'GET /v1/runtimes/setup/scan') throw new Error('the daemon is down');
        if (route === 'GET /v1/runtimes/setup/scan') return scanOf({ claude: CLAUDE_FULL });
        return { installed: { state: 'ok', version: '1.2.3' } };
      },
    } as unknown as RuntimesClient;
    await scanStoreFor(client, 'run-1').scan();
    expect(scanStoreFor(client, 'run-1').snapshot().kind).toBe('failed');
    failing = false;
    const next = scanStoreFor(client, 'run-2');
    await next.scan();
    expect(next.snapshot().kind).toBe('ready');
  });

  it('useHarnessScan reads once for a run and again for the next', async () => {
    const calls: string[] = [];
    const client = countingClient(calls);
    const Probe = ({ run }: { readonly run: string }) => {
      const { model } = useHarnessScan(client, 'claude-code', run);
      return createElement('span', { 'data-model': model === null ? 'none' : model.harness });
    };
    const view = await mount(createElement(Probe, { run: 'run-1' }));
    await interact(() => new Promise(resolve => setTimeout(resolve, 20)));
    expect(view.container.querySelector('[data-model]')?.getAttribute('data-model')).toBe('claude-code');
    expect(scans(calls)).toBe(1);
    // A re-render in the same run reads nothing.
    await view.render(createElement(Probe, { run: 'run-1' }));
    expect(scans(calls)).toBe(1);
    // The next run, same client: it reads again.
    await view.render(createElement(Probe, { run: 'run-2' }));
    await interact(() => new Promise(resolve => setTimeout(resolve, 20)));
    expect(scans(calls)).toBe(2);
    await view.unmount();
  });
});
