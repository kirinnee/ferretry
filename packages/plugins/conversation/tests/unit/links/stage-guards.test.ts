import { describe, expect, test } from 'bun:test';
import type { FerretId } from '@ferretry/core-ferrets/contract';
import type { Instant } from '@ferretry/std';
import { err, ok } from '@ferretry/std';
import { ConversationIndex, type IndexSource } from '../../../daemon/links/lib/conversation-index.ts';
import { LinkService } from '../../../daemon/links/lib/service.ts';
import { claudeRecord, MemoryHistory, memorySqlite, PARSERS } from '../../support/history-tree.ts';

/**
 * "Continue a past conversation" stages a transcript the owner's computer holds (E-254, E-256): it asks the keep ledger
 * first, so one conversation is never copied twice for two ferrets, and it copies the owner's COMPUTER row, never a
 * newer ferret-home row that happens to share the id.
 */
const ID = '3b1a4a52-0000-4000-8000-0000000000e2';
const PATH = `projects/-work-app/${ID}.jsonl`;
const text = (said: string, at: string): string => `${claudeRecord('user', said, at)}\n`;

const build = async (
  options: {
    ferretHome?: boolean;
    pool?: boolean;
    computer?: boolean;
    owned?: boolean;
    copyGate?: () => Promise<void>;
    ownerSnapshot?: (owners: ReadonlyMap<string, FerretId>) => Promise<ReadonlyMap<string, FerretId>>;
  } = {},
) => {
  const computer = new MemoryHistory();
  computer.set(PATH, text('the owner’s own computer copy', '2026-02-01T09:00:00.000Z'), 1_000);
  const sources: IndexSource[] =
    options.computer === false
      ? []
      : [{ harness: 'claude-code', parser: 'claude', kind: 'computer', label: 'owner', files: computer }];
  if (options.ferretHome === true) {
    const home = new MemoryHistory();
    home.set(PATH, text('a newer ferret-home copy', '2026-03-01T09:00:00.000Z'), 9_000_000_000_000);
    sources.push({ harness: 'claude-code', parser: 'claude', kind: 'ferret-home', label: 'scout', files: home });
  }
  if (options.pool === true) {
    const pool = new MemoryHistory();
    pool.set(PATH, text('newer pooled copy', '2026-04-01T09:00:00.000Z'), 9_000_000_000_001);
    sources.push({ harness: 'claude-code', parser: 'claude', kind: 'pool', label: 'pool', files: pool });
  }
  const owners = new Map(options.owned === true ? [[`claude-code:${ID}`, 'stopped-scout' as FerretId]] : []);
  const index = new ConversationIndex({
    sqlite: () => memorySqlite(),
    sources: async () => sources,
    ferretNames: async () => new Map(),
    parsers: PARSERS,
    nowMs: () => 0,
  });
  await index.refresh();
  const links: Array<{ id: string; harness: string; ferret: FerretId; linkedAt: Instant; copied?: true }> = [];
  const copies: Array<{ id: string; kind: string; label: string }> = [];
  const service = new LinkService({
    index,
    owners: async () => (options.ownerSnapshot === undefined ? owners : await options.ownerSnapshot(owners)),
    previewer: { preview: async () => undefined },
    ledger: {
      read: async () => ({ format: 1 as const, links }),
      add: async link => {
        links.push(link);
      },
    },
    keeper: {
      keep: async input => ok({ ferret: 'scout' as FerretId, name: input.name, state: 'stopped' as const }),
    },
    copier: {
      copy: async ({ id, location }) => {
        await options.copyGate?.();
        copies.push({ id, kind: location.kind, label: location.label });
        if (options.pool === true && location.kind === 'computer') return err({ reason: 'computer file unavailable' });
        return ok(undefined);
      },
    },
    now: () => '2026-02-02T00:00:00.000Z' as Instant,
  });
  return { service, copies, links, owners, index, computer };
};

describe('stage consults the keep ledger and the right source', () => {
  test('E-254 a conversation a ferret already keeps is not copied again: the owner and reason come back', async () => {
    const { service, copies, links } = await build();
    const kept = await service.keep({
      harness: 'claude-code',
      runtime: 'default',
      conversations: [{ id: ID, start: false }],
    });
    expect(kept.kept).toHaveLength(1);
    expect(copies).toHaveLength(1);
    const staged = await service.stage('claude-code', ID);
    expect(staged).toEqual(err({ code: 'failed', reason: `Ferret ${links[0]?.ferret} already keeps it.` }));
    expect(copies, 'the copier ran once, for the keep, and never again for the stage').toHaveLength(1);
  });

  test('E-256 the selected newer pool row stages even when the older computer copy is unavailable', async () => {
    const { service, copies } = await build({ pool: true });
    const listed = await service.list({ source: 'synced' });
    const selected = listed.conversations[0];
    expect(selected?.keptIn).toBe('ferretry');
    const staged = await service.stage('claude-code', ID, selected?.source);
    expect(staged.ok).toBe(true);
    expect(copies).toEqual([{ id: ID, kind: 'pool', label: 'pool' }]);
  });

  test('E-254 a stopped registry owner refuses a stale picker even without a keep-ledger entry', async () => {
    const { service, copies } = await build({ pool: true, computer: false, owned: true });
    expect(await service.stage('claude-code', ID)).toEqual(
      err({ code: 'failed', reason: 'Ferret stopped-scout already keeps it.' }),
    );
    expect(copies).toHaveLength(0);
  });

  test('E-254 concurrent stages reserve the history until the whole start settles', async () => {
    const copying = Promise.withResolvers<void>();
    const finishCopy = Promise.withResolvers<void>();
    const { service, copies, owners } = await build({
      copyGate: async () => {
        copying.resolve();
        await finishCopy.promise;
      },
    });
    const first = service.stage('claude-code', ID);
    await copying.promise;
    // The second request arrives while the first is still inside its copier, before either has an owner record.
    const second = service.stage('claude-code', ID);
    finishCopy.resolve();
    const results = await Promise.all([first, second]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(copies).toHaveLength(1);
    const winner = results.find(result => result.ok);
    if (winner?.ok !== true) throw new Error('one stage must win');
    owners.set(`claude-code:${ID}`, 'new-scout' as FerretId);
    winner.value.release();
    expect((await service.stage('claude-code', ID)).ok).toBe(false);
  });

  test('E-254 a failed start releases its reservation so the owner can retry', async () => {
    const { service } = await build();
    const first = await service.stage('claude-code', ID);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('stage failed');
    first.value.release();
    expect((await service.stage('claude-code', ID)).ok).toBe(true);
  });

  test('R2-1 an active start cannot disappear while a competing stage holds a stale owner snapshot', async () => {
    const snapshotTaken = Promise.withResolvers<void>();
    const finishSnapshot = Promise.withResolvers<void>();
    let reads = 0;
    let pause = true;
    const { service, copies, owners } = await build({
      ownerSnapshot: async owners => {
        const snapshot = new Map(owners);
        if (++reads === 2 && pause) {
          snapshotTaken.resolve();
          await finishSnapshot.promise;
        }
        return snapshot;
      },
    });
    const first = await service.stage('claude-code', ID);
    if (!first.ok) throw new Error('first stage must succeed');
    const second = service.stage('claude-code', ID);
    // The old implementation takes an empty snapshot and suspends here. A safe implementation refuses before reading it.
    await Promise.race([snapshotTaken.promise, second.then(() => undefined)]);
    owners.set(`claude-code:${ID}`, 'recorded-scout' as FerretId);
    first.value.release();
    pause = false;
    finishSnapshot.resolve();
    expect((await second).ok).toBe(false);
    expect(copies).toHaveLength(1);
    expect(await service.stage('claude-code', ID)).toEqual(
      err({ code: 'failed', reason: 'Ferret recorded-scout already keeps it.' }),
    );
  });

  test('E-254 keeping cannot take a history reserved by a continuation; release permits a retry', async () => {
    const { service, copies, links } = await build();
    const staged = await service.stage('claude-code', ID);
    if (!staged.ok) throw new Error('stage failed');
    const request = { harness: 'claude-code', runtime: 'default', conversations: [{ id: ID, start: false }] };
    expect(await service.keep(request)).toEqual({
      kept: [],
      refused: [{ id: ID, code: 'already_kept', reason: 'That conversation is already being continued.' }],
    });
    expect(copies).toHaveLength(1);
    expect(links).toHaveLength(0);
    staged.value.release();
    expect((await service.keep(request)).kept).toHaveLength(1);
    expect(copies).toHaveLength(2);
    expect(links).toHaveLength(1);
  });

  test('E-256 a changed selected row is refused without falling back to another copy', async () => {
    const { service, copies, index, computer } = await build({ ferretHome: true });
    const row = (await service.list({ source: 'computer' })).conversations[0];
    expect(row?.source?.kind).toBe('computer');
    computer.set(PATH, text('changed since the picker listed it', '2026-05-01T09:00:00.000Z'), 20_000);
    await index.refresh();
    expect((await service.stage('claude-code', ID, row?.source)).ok).toBe(false);
    expect(copies).toHaveLength(0);
  });
});
