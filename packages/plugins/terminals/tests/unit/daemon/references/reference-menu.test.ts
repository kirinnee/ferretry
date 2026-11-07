import { describe, expect, test } from 'bun:test';
import type { FerretId } from '@ferretry/kernel/contract';
import {
  REFERENCE_CATALOG_MAX_ENTRIES,
  ReferenceCatalogEntrySchema,
  type ReferenceCatalogInput,
  referenceCatalogLimit,
} from '@ferretry/plugin-conversation/contract';
import { instantFromEpochMs } from '@ferretry/std';
import { type TerminalView, type TerminalsApi } from '../../../../contract/index.ts';
import { TerminalsReferenceMenu } from '../../../../daemon/lib/reference-menu.ts';
import manifest from '../../../../manifest.ts';
import { FERRET, terminalsHalf } from '../../../support/daemon/half.ts';

const NOW = instantFromEpochMs(Date.parse('2026-11-07T10:00:00.000Z'));

const terminal = (overrides: Partial<TerminalView> & Pick<TerminalView, 'id'>): TerminalView => ({
  sessionId: FERRET,
  title: 'bash',
  state: 'running',
  cols: 80,
  rows: 24,
  viewers: 0,
  createdAt: NOW,
  lastActivityAt: NOW,
  idleDeadline: instantFromEpochMs(Date.parse('2026-11-07T11:00:00.000Z')),
  ...overrides,
});

const menu = (terminals: readonly TerminalView[]) =>
  new TerminalsReferenceMenu({ of: async () => terminals } satisfies Pick<TerminalsApi, 'of'>);

const ask = (query?: string): ReferenceCatalogInput => ({
  ferret: FERRET,
  ...(query === undefined ? {} : { query }),
  caller: {},
});

describe('terminals provides the %terminal reference menu (reference.catalog)', () => {
  test('a ferret’s terminals are offered in the order Terminals lists them: the key is the name (else the id), the label the title', async () => {
    const entries = await menu([
      terminal({ id: 'aaaaaaaaaaaa', name: 'dev', title: 'npm run dev' }),
      terminal({ id: 'bbbbbbbbbbbb', title: 'bash' }),
    ]).entries(ask());
    expect(entries.map(entry => [entry.token, entry.label])).toEqual([
      ['dev', 'npm run dev'],
      ['bbbbbbbbbbbb', 'bash'],
    ]);
    for (const entry of entries) expect(ReferenceCatalogEntrySchema.safeParse(entry).success).toBe(true);
  });

  test('the detail says the viewers and who opened it, and an unrecorded opener reads unrecorded, never a guess', async () => {
    const entries = await menu([
      terminal({ id: 'aaaaaaaaaaaa', viewers: 1, openedBy: { by: 'agent', sessionId: 's1' }, idleDeadline: undefined }),
      terminal({
        id: 'bbbbbbbbbbbb',
        viewers: 2,
        openedBy: { by: 'human', deviceId: 'dev-1' },
        idleDeadline: undefined,
      }),
      terminal({ id: 'cccccccccccc', openedBy: { by: 'local' } }),
      terminal({ id: 'dddddddddddd' }),
    ]).entries(ask());
    expect(entries.map(entry => entry.detail)).toEqual([
      '1 viewer · opened by an agent',
      '2 viewers · opened from a paired device',
      '0 viewers · opened on the daemon host',
      '0 viewers · owner unrecorded',
    ]);
  });

  test('no device id or session id leaves in an entry', async () => {
    const entries = await menu([
      terminal({ id: 'aaaaaaaaaaaa', openedBy: { by: 'human', deviceId: 'device-secret-id' } }),
      terminal({ id: 'bbbbbbbbbbbb', openedBy: { by: 'agent', sessionId: 'session-secret-id' } }),
    ]).entries(ask());
    const text = JSON.stringify(entries);
    expect(text).not.toContain('device-secret-id');
    expect(text).not.toContain('session-secret-id');
  });

  test('the query narrows by the key or the title, case ignored', async () => {
    const all = [
      terminal({ id: 'aaaaaaaaaaaa', name: 'dev', title: 'npm run dev' }),
      terminal({ id: 'bbbbbbbbbbbb', name: 'logs', title: 'tail -f server.log' }),
      terminal({ id: 'cccccccccccc', title: 'bash' }),
    ];
    const tokens = async (query: string) => (await menu(all).entries(ask(query))).map(entry => entry.token);
    expect(await tokens('DEV')).toEqual(['dev']);
    expect(await tokens('server')).toEqual(['logs']);
    expect(await tokens('cccc')).toEqual(['cccccccccccc']);
    expect(await tokens('  ')).toEqual(['dev', 'logs', 'cccccccccccc']);
    expect(await tokens('nothing')).toEqual([]);
  });

  test('a menu never passes the prefix’s limit', async () => {
    const many = Array.from({ length: REFERENCE_CATALOG_MAX_ENTRIES + 25 }, (_, index) =>
      terminal({ id: index.toString(16).padStart(12, '0') }),
    );
    expect(referenceCatalogLimit('%terminal')).toBe(REFERENCE_CATALOG_MAX_ENTRIES);
    expect(await menu(many).entries(ask())).toHaveLength(REFERENCE_CATALOG_MAX_ENTRIES);
  });

  test('no entry is closed: Terminals lists only running terminals', async () => {
    const entries = await menu([terminal({ id: 'aaaaaaaaaaaa' })]).entries(ask());
    expect(entries.some(entry => entry.closed !== undefined)).toBe(false);
  });

  test('a ferret with no terminal has an empty menu', async () => {
    expect(await menu([]).entries(ask())).toEqual([]);
  });

  test('the demand declared is exactly what the direct terminals route declares', () => {
    const direct = manifest.actions.routes.find(route => route.key === 'GET /v1/ferrets/:ferretId/terminals');
    expect(direct?.capability).toBeDefined();
    expect(direct?.capability).toEqual(menu([]).demand);
  });
});

describe('terminals with the real half', () => {
  test('a terminal the ferret opened is offered, and the menu is held under the one key Conversation asks', async () => {
    const half = await terminalsHalf();
    const opened = await half.host.tool('terminal_open', { name: 'dev' });
    expect(opened.isError).not.toBe(true);
    const entries = await half.referenceMenu().entries({ ferret: FERRET as FerretId, caller: {} });
    expect(entries.map(entry => entry.token)).toEqual(['dev']);
    for (const entry of entries) expect(ReferenceCatalogEntrySchema.safeParse(entry).success).toBe(true);
    await half.host.stop();
  });

  test('another ferret’s terminals are not offered', async () => {
    const half = await terminalsHalf();
    await half.host.tool('terminal_open', { name: 'dev' });
    expect(await half.referenceMenu().entries({ ferret: 'f-other' as FerretId, caller: {} })).toEqual([]);
    await half.host.stop();
  });

  test('with Conversation absent the plugin boots, still serves its own reads, and nothing asks the menu', async () => {
    const half = await terminalsHalf();
    expect(half.host.logs.filter(entry => entry.level === 'error')).toEqual([]);
    half.as('owner');
    const own = await half.host.request('GET', `/v1/ferrets/${FERRET}/terminals`);
    expect(own.status).toBe(200);
    // The only asker of the menu is Conversation's references route; with Conversation off the host holds no such route.
    const references = await half.host.request('GET', `/v1/ferrets/${FERRET}/references?prefix=%25terminal`);
    expect(references.status).toBe(404);
    await half.host.stop();
  });
});
