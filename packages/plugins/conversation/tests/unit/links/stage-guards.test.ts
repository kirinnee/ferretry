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

const build = async (options: { ferretHome?: boolean } = {}) => {
  const computer = new MemoryHistory();
  computer.set(PATH, text('the owner’s own computer copy', '2026-02-01T09:00:00.000Z'), 1_000);
  const sources: IndexSource[] = [
    { harness: 'claude-code', parser: 'claude', kind: 'computer', label: 'owner', files: computer },
  ];
  if (options.ferretHome === true) {
    const home = new MemoryHistory();
    home.set(PATH, text('a newer ferret-home copy', '2026-03-01T09:00:00.000Z'), 9_000_000_000_000);
    sources.push({ harness: 'claude-code', parser: 'claude', kind: 'ferret-home', label: 'scout', files: home });
  }
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
        copies.push({ id, kind: location.kind, label: location.label });
        return ok(undefined);
      },
    },
    now: () => '2026-02-02T00:00:00.000Z' as Instant,
  });
  return { service, copies, links };
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

  test('E-256 a newer ferret-home row sharing the id does not replace the owner’s computer row', async () => {
    const { service, copies } = await build({ ferretHome: true });
    expect(await service.stage('claude-code', ID)).toEqual(ok(undefined));
    expect(copies).toEqual([{ id: ID, kind: 'computer', label: 'owner' }]);
  });
});
