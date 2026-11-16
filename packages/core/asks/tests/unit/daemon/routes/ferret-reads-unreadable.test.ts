import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAgendaVersionStore } from '../../../../daemon/adapters/agenda/file-agenda-versions.ts';
import { type AgendaLedger, AgendaService } from '../../../../daemon/lib/agenda/index.ts';
import { applyAgendaCommandToSession } from '../../../../daemon/lib/agenda/state-machine.ts';
import type { FerretReach } from '../../../../daemon/lib/routes/ferret-reads.ts';
import { agendaRoutes } from '../../../../daemon/lib/routes/agenda.ts';
import { asksStateAt, versionArchivePath } from '../../../support/daemon/agenda-state.ts';
import { agentIn, device, FakeLedgerRepository, human, NO_HELD_REPLIES, routeDispatcher } from './support.ts';

/**
 * Audit A fix 9: an unreadable newest version is NOT an absent id. A cold item (it has left the board) whose newest kept
 * snapshot is corrupt, beside a readable older Warden snapshot, is withheld from a ferret on every route exactly as a hidden
 * item is: the item, the versions list, an explicit older version and the conversation all answer as an id never raised.
 * The version store is the REAL `SqliteAgendaVersionStore` over a temp home; the bad tail is planted in its file.
 */

const BOARD = 'stranger';
const AT = '2026-11-06T09:00:00.000Z';
const WORDS = ['FIXTURE cold reason', 'FIXTURE cold remedy', 'FIXTURE cold thread'];
const reach: FerretReach = {
  mayTouch: async (caller, target) => caller === target,
  startedByWarden: async () => false,
};
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map(async home => await rm(home, { recursive: true, force: true })));
});

/** A1 stays on the board; each `cold` id has left it and keeps only a readable Warden v1 and a corrupt v2. */
async function world(tail: 'snapshot' | 'summary') {
  const home = await mkdtemp(join(tmpdir(), 'ferret-reads-unreadable-'));
  homes.push(home);
  const store = new SqliteAgendaVersionStore(asksStateAt(home));
  const raised = applyAgendaCommandToSession(null, BOARD, {
    action: 'raise',
    actor: { kind: 'agent', sessionId: BOARD, name: 'Ada' },
    request: {
      source: 'agent-raised',
      sourceRef: null,
      subject: 'A plain ask',
      why: 'A plain reason',
      context: 'A plain context',
      premise: 'A premise',
      howToResolve: 'Answer in words.',
      ask: { kind: 'open-question' },
    },
    at: AT,
  });
  if (!raised.ok) throw new Error(raised.error.message);
  const board = raised.ledger.entries[0]!;
  const cold = {
    ...board,
    item: {
      ...board.item,
      id: 'A9',
      sourceRef: 'ask:daemon:warden.orphans',
      raisedBy: 'daemon' as const,
      raisedBySession: null,
      raisedByName: null,
      subject: 'Warden notice A9',
      why: WORDS[0]!,
      howToResolve: WORDS[1]!,
    },
  };
  await store.record(BOARD, [
    {
      entry: cold,
      at: AT,
      by: 'daemon',
      change: 'created',
      conversation: [{ by: 'owner', at: AT, text: WORDS[2]!, via: 'reply' }],
    } as never,
  ]);
  const db = new Database(versionArchivePath(home, BOARD, 'A9'));
  const goodSummary = JSON.stringify({ version: 2, at: AT, by: 'daemon', change: 'edited', lifecycle: 'active' });
  db.run('INSERT INTO versions VALUES (2, ?, ?)', [
    tail === 'snapshot' ? '{"not json' : '{}',
    tail === 'snapshot' ? goodSummary : '{"not json',
  ]);
  db.close();
  const service = new AgendaService(
    new FakeLedgerRepository({ ...raised.ledger, sessionId: BOARD } as unknown as AgendaLedger),
    { now: () => AT },
    { has: async id => id === BOARD },
    { raised: async () => undefined },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    store,
  );
  const dispatch = routeDispatcher(
    agendaRoutes(service, NO_HELD_REPLIES, { enrolledDevices: async () => 0 }, undefined, undefined, undefined, reach),
  );
  return {
    get: (id: string, suffix: string, caller = agentIn('lead'), query: readonly (readonly [string, string])[] = []) =>
      dispatch({ path: `/v1/ferrets/${BOARD}/agenda/${id}${suffix}`, headers: caller, query }),
  };
}

const ROUTES: readonly (readonly [string, string, readonly (readonly [string, string])[]])[] = [
  ['item', '', []],
  ['versions list', '/versions', []],
  ['explicit older version 1', '/versions/1', []],
  ['version 2', '/versions/2', []],
  ['conversation', '/conversation', []],
  ['conversation of older version 1', '/conversation', [['version', '1']]],
];

describe('an unreadable newest version is withheld from a ferret like a hidden item', () => {
  for (const tail of ['snapshot', 'summary'] as const) {
    test.each(ROUTES.map(row => row))(
      `corrupt ${tail} tail: %s answers as an id never raised`,
      async (_n, suffix, query) => {
        const w = await world(tail);
        const hidden = await w.get('A9', suffix, agentIn('lead'), query);
        const absent = await w.get('A77', suffix, agentIn('lead'), query);
        const shape = (id: string) => (r: typeof hidden) => ({
          status: r.status,
          body: r.body.replaceAll(id, '<ID>'),
        });
        expect(shape('A9')(hidden)).toEqual(shape('A77')(absent));
        for (const words of WORDS) expect(hidden.body).not.toContain(words);
      },
    );
  }

  test('the owner and a device still read it whole (unchanged)', async () => {
    const w = await world('snapshot');
    for (const caller of [human, device('phone')]) {
      expect((await w.get('A9', '/versions/1', caller)).body).toContain(WORDS[0]!);
      expect((await w.get('A9', '/conversation', caller, [['version', '1']])).body).toContain(WORDS[2]!);
      expect(JSON.parse((await w.get('A9', '/versions', caller)).body).versions).toHaveLength(2);
    }
  });
});
