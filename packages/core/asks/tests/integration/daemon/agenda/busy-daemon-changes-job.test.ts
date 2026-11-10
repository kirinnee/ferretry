import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StatePort } from '@ferretry/kernel/contract';
import type { AskDraft, EntryId, SourceKey } from '../../../../contract/index.ts';
import { StateAgendaFiles } from '../../../../daemon/adapters/agenda/state-agenda-files.ts';
import { AGENDA_FILES, emptyAgendaLedger } from '../../../../daemon/lib/agenda/index.ts';
import { agendaLedgerDocument } from '../../../../daemon/lib/agenda/state-machine.ts';
import { AGENDA_STATE_FILES } from '../../../../daemon/lib/state.ts';
import { AgendaPendingChangesFiles } from '../../../../manifest.ts';
import { agendaFilePath, asksStateAt } from '../../../support/daemon/agenda-state.ts';
import { asksHalf } from '../../../support/daemon/asks-half.ts';

/**
 * THE `changes` JOB, run as the kernel runs it, from the Asks half's own build over a REAL state folder (so the real
 * version store is there and the change outbox exists) holding 300 generated ferret ledgers. Counted at the state
 * seam: a tick of the job lists no ledger and reads none, and a change that is still pending is delivered by the
 * very next tick. The old job listed and read every ledger every second.
 */
const AT = '2026-11-09T10:00:00.000Z';
const LEDGERS = 300;
const TICKS = 20;
const names = Array.from({ length: LEDGERS }, (_, i) => `b${i}`);

const ledgerDef = (AGENDA_STATE_FILES as Readonly<Record<string, unknown>>)[AGENDA_FILES.ledger];
const OUTBOX = 'agenda-changes.pending.json';

const draft = (entry: string, ferret: string): AskDraft => ({
  source: 'ferret' as SourceKey,
  ref: {},
  entry: entry as EntryId,
  kind: 'yesno',
  subject: 'Ship it?',
  why: 'The release is ready.',
  raisedBy: { kind: 'ferret', ferret },
  ferret,
});

const halves: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(halves.splice(0).map(async half => await half.close()));
});

async function world() {
  const home = await mkdtemp(join(tmpdir(), 'busy-daemon-changes-'));
  const files = new StateAgendaFiles(asksStateAt(home));
  for (const name of names)
    await files.writeAtomic(name, AGENDA_FILES.ledger, agendaLedgerDocument(emptyAgendaLedger(name, AT)));
  const counts = { lists: 0, ledgerReads: 0 };
  // The write to a ferret's change outbox that lands the Nth time fails once: a disk that refuses the acknowledgement.
  const outbox = { writes: 0, failAt: 0 };
  const half = await asksHalf(
    {},
    {
      home,
      wrapState: real =>
        new Proxy(real, {
          get: (target, key, receiver) => {
            if (key === 'list')
              return async (...args: Parameters<StatePort['list']>) => {
                counts.lists += 1;
                return await target.list(...args);
              };
            if (key === 'read')
              return async (...args: Parameters<StatePort['read']>) => {
                if (args[0] === ledgerDef) counts.ledgerReads += 1;
                return await target.read(...args);
              };
            if (key === 'write')
              return async (...args: Parameters<StatePort['write']>) => {
                if (args[0] === AgendaPendingChangesFiles) {
                  outbox.writes += 1;
                  if (outbox.writes === outbox.failAt) throw new Error('the disk refused the write');
                }
                return await target.write(...args);
              };
            return Reflect.get(target, key, receiver) as unknown;
          },
        }),
    },
  );
  halves.push(half);
  const job = half.jobs.find(each => each.id === 'changes');
  if (job === undefined) throw new Error('Asks registers no changes job');
  const tick = async () => await job.run(new AbortController().signal);
  return { half, home, counts, outbox, tick };
}

describe('the changes job reads no ledger it has no reason to (G3)', () => {
  it('should list no ledger and read none over 20 idle ticks with 300 ledgers', async () => {
    // Arrange
    const w = await world();
    const lists = w.counts.lists;
    const reads = w.counts.ledgerReads;

    // Act
    for (let i = 0; i < TICKS; i += 1) await w.tick();

    // Assert: not one listing and not one ledger read, not 20 x 300
    expect(w.counts.lists - lists).toBe(0);
    expect(w.counts.ledgerReads - reads).toBe(0);
  });

  it('should deliver a change still pending in the outbox within one tick, reading no ledger', async () => {
    // Arrange: a raise whose acknowledgement the disk refuses once, so its change is kept in the outbox
    const w = await world();
    w.outbox.failAt = 2;
    await w.half.asks.raise(draft('e1', 'b7')).catch(() => undefined);
    const outboxFile = agendaFilePath(w.home, 'b7', OUTBOX);
    const kept = JSON.parse(await readFile(outboxFile, 'utf8')) as unknown[];
    expect(kept).toHaveLength(1);
    const published = w.half.events.length;
    const lists = w.counts.lists;
    const reads = w.counts.ledgerReads;

    // Act: ONE tick
    await w.tick();

    // Assert: the change was delivered again and acknowledged, and the tick listed and read no ledger
    expect(JSON.parse(await readFile(outboxFile, 'utf8')) as unknown[]).toEqual([]);
    expect(w.half.events.length).toBeGreaterThan(published);
    expect(w.counts.lists - lists).toBe(0);
    expect(w.counts.ledgerReads - reads).toBe(0);
  });
});
