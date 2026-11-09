import { afterEach, describe, expect, it } from 'bun:test';
import type { FerretId, StatePort } from '@ferretry/kernel/contract';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AskDraft } from '../../../../contract/index.ts';
import { asksPort } from '../../../../daemon/adapters/asks-port.ts';
import { FileAgendaLedgerRepository } from '../../../../daemon/adapters/agenda/file-agenda-ledger-repository.ts';
import { SqliteAgendaVersionStore } from '../../../../daemon/adapters/agenda/file-agenda-versions.ts';
import { StateAgendaFiles } from '../../../../daemon/adapters/agenda/state-agenda-files.ts';
import { AGENDA_FILES, AgendaService, emptyAgendaLedger } from '../../../../daemon/lib/agenda/index.ts';
import { agendaLedgerDocument } from '../../../../daemon/lib/agenda/state-machine.ts';
import { AgendaLedgerFiles, AGENDA_STATE_FILES } from '../../../../daemon/lib/state.ts';
import { asksStateAt } from '../../../support/daemon/agenda-state.ts';

/**
 * THE IDLE DAEMON'S READ STORM, counted at the file seam over a generated home of 300 ferret ledgers. Every case counts
 * the reads of ledger FILE CONTENTS the real ports make (a stat, a listing and a write are not reads), so a bound here is
 * a bound on disk work, with no clock in it: O(ledgers named), never O(ledgers x asks).
 */
const AT = '2026-11-09T10:00:00.000Z';
const LEDGERS = 300;
const names = Array.from({ length: LEDGERS }, (_, i) => `b${i}`);
const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map(async home => await rm(home, { recursive: true, force: true })));
});

async function home() {
  const dir = await mkdtemp(join(tmpdir(), 'busy-daemon-reads-'));
  homes.push(dir);
  const real = asksStateAt(dir);
  const counts = { ledgerReads: 0, otherReads: 0, lists: 0, versions: 0 };
  const ledgerDef = (AGENDA_STATE_FILES as Readonly<Record<string, unknown>>)[AGENDA_FILES.ledger];
  const state = new Proxy(real, {
    get: (target, key, receiver) => {
      if (key === 'read')
        return async (...args: Parameters<StatePort['read']>) => {
          if (args[0] === ledgerDef) counts.ledgerReads += 1;
          else counts.otherReads += 1;
          return await target.read(...args);
        };
      if (key === 'version')
        return async (...args: Parameters<StatePort['version']>) => {
          counts.versions += 1;
          return await target.version(...args);
        };
      if (key === 'list')
        return async (...args: Parameters<StatePort['list']>) => {
          counts.lists += 1;
          return await target.list(...args);
        };
      return Reflect.get(target, key, receiver) as unknown;
    },
  }) as StatePort;
  const files = new StateAgendaFiles(state);
  for (const name of names)
    await files.writeAtomic(name, AGENDA_FILES.ledger, agendaLedgerDocument(emptyAgendaLedger(name, AT)));
  // The daemon's own version store: without one the repository has no change outbox, and a drain case would pass
  // whatever the drain does.
  const versions = new SqliteAgendaVersionStore(state);
  const repository = new FileAgendaLedgerRepository(files, () => crypto.randomUUID(), versions, {
    now: () => 0,
    warn: () => undefined,
  });
  const agenda = new AgendaService(
    repository,
    { now: () => AT },
    { has: async () => true },
    { raised: async () => undefined },
  );
  const boards = { ferrets: async () => await state.list(AgendaLedgerFiles) };
  const api = asksPort(agenda, boards, () => 'unavailable');
  const since = () => {
    const mark = counts.ledgerReads;
    return () => counts.ledgerReads - mark;
  };
  return { agenda, api, counts, since, repository };
}

const draft = (entry: string, ferret = 'b7'): AskDraft => ({
  source: 'daemon',
  entry,
  ref: {},
  kind: 'yesno',
  subject: 'Release?',
  why: 'Ready',
  raisedBy: { kind: 'daemon' },
  ferret,
});

describe('the idle daemon reads the ledgers it needs, once', () => {
  it('should read one ledger file for open({ ferret }) out of 300', async () => {
    const w = await home();
    const reads = w.since();

    await w.api.open({ ferret: 'b7' as FerretId });

    expect(reads()).toBe(1);
  });

  it('should read every ledger once for open({}), and none the second time while no file changed', async () => {
    const w = await home();
    const first = w.since();
    await w.api.open({});
    expect(first()).toBe(LEDGERS);

    const second = w.since();
    await w.api.open({});
    await w.api.open({});

    expect(second()).toBe(0);
  });

  it('should read the ledgers once for the first raise and about one for the next, never 300 each', async () => {
    const w = await home();
    const firstReads = w.since();
    await w.api.raise(draft('e1'));
    expect(firstReads()).toBeLessThanOrEqual(LEDGERS + 2);

    const nextReads = w.since();
    const nextStats = w.counts.versions;
    for (let i = 2; i <= 6; i += 1) await w.api.raise(draft(`e${i}`));

    // five raises, each at most its own board: its reads, and the stats that tell a cached ledger is still current
    expect(nextReads()).toBeLessThanOrEqual(10);
    expect(w.counts.versions - nextStats).toBeLessThanOrEqual(60);
  });

  it('should list no ledger on an idle change drain, and only the ferret that holds an event after one', async () => {
    const w = await home();
    // A change outbox must exist (it needs the version store) and name nobody yet; with none, every drain assertion
    // below would hold for the wrong reason.
    expect(w.repository.changeOutbox?.pendingFerrets()).toEqual([]);
    const idle = w.since();
    await w.agenda.flushPending(() => undefined);
    expect(idle()).toBe(0);

    await w.api.raise(draft('e1', 'b9'));
    const drain = w.since();
    await w.agenda.flushPending(() => undefined);

    expect(drain()).toBeLessThanOrEqual(2);
  });
});
