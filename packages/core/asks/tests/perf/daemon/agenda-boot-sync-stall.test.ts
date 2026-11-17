// Perf tier: asserts a speed budget (the longest synchronous stretch); the outcome depends on the machine.
import { afterAll, beforeAll, describe, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ferretStanding } from '@ferretry/core-gate/contract/testing';
import type { FerretId } from '@ferretry/kernel/contract';
import { fixedClock, type DrivenClock } from '@ferretry/kernel/testing';
import should from 'should';
import {
  agendaLedgerDocument,
  applyAgendaCommandToSession,
  emptyAgendaLedger,
  type AgendaEntry,
  type AgendaLedger,
} from '../../../daemon/lib/agenda/state-machine.ts';
import type { AgendaConversationEntry } from '../../../daemon/lib/protocol/agenda.ts';
import { agendaFilePath } from '../../support/daemon/agenda-state.ts';
import { asksHalf } from '../../support/daemon/asks-half.ts';

/**
 * THE DAEMON MUST NOT STALL WHILE IT SYNCS THE AGENDA AFTER BOOT. A real-scale run held the loop 3.99 s once the daemon
 * was up, while it wrote 160 agenda version archives. Two paths run then, and each is measured here over fake data in a
 * temp home: the boot jobs (`recover` reads every ferret's board, the sweeps read them all again) over ~500 ferrets'
 * boards, and the FIRST change to a board that still carries cold threads from a converted home (it archives every one,
 * each into its own SQLite file). The budget is no single synchronous stretch over 250 ms, from a loop-lag probe.
 */
const BUDGET_MS = 250;
const TEST_TIMEOUT_MS = 180_000;
const AT = '2026-07-30T10:00:00Z';
const FERRETS = 500;
const FAT_FERRETS = 20;
const COLD_PER_FAT_FERRET = 8;
const FAT_BOARD_COLD = 160;
const THREAD = 20;

const BOARD = 'POST /v1/ferrets/:ferretId/agenda';
const RAISE = {
  action: 'add',
  title: 'Release unblock',
  subject: 'which base branch?',
  why: 'the ticket names two',
  premise: 'A ferret needs the owner.',
  context: 'The work waits on this answer.',
  howToResolve: 'name the branch to target',
  ask: { kind: 'multiple-choice', options: [{ label: 'main' }, { label: 'develop' }] },
} as const;

/** A kernel clock whose `sleep` gives the loop a real turn, as the daemon's does (`clock.sleep(0)`). */
const turnClock = (): DrivenClock => ({ ...fixedClock(), sleep: async () => await new Promise(r => setImmediate(r)) });

const entryOf = (ferret: string, n: number): AgendaEntry => {
  const raised = applyAgendaCommandToSession(null, ferret, {
    action: 'raise',
    actor: { kind: 'agent', sessionId: ferret, name: 'Ada' },
    request: {
      source: 'agent-raised',
      sourceRef: null,
      subject: `Which region do we deploy to? (${n})`,
      why: 'The release waits on the region.',
      context: 'The deploy changes the public service.',
      premise: 'A release is ready to go out.',
      howToResolve: 'Answer in words.',
      ask: { kind: 'open-question' },
    },
    at: AT,
  });
  if (!raised.ok) throw new Error(raised.error.message);
  const entry = raised.ledger.entries[0];
  if (entry === undefined) throw new Error('no entry');
  return { ...entry, item: { ...entry.item, id: `A${n}` } } as AgendaEntry;
};

const thread = (length: number, seed: string): AgendaConversationEntry[] =>
  Array.from({ length }, (_, index) => ({
    at: AT,
    by: index % 2 === 0 ? ('owner' as const) : ('ferret' as const),
    via: 'reply' as const,
    text: `${seed} word ${index}: ${'lorem ipsum dolor sit amet '.repeat(8)}`,
  }));

/** A board as a converted home leaves it: one live ask, and `cold` older ones held as carried entries with threads. */
const boardOf = (ferret: string, cold: number): AgendaLedger => {
  const live = entryOf(ferret, cold + 1);
  const ids = Array.from({ length: cold }, (_, index) => index + 1);
  return {
    ...emptyAgendaLedger(ferret, AT),
    nextId: cold + 2,
    entries: [live],
    ...(cold === 0
      ? {}
      : {
          conversations: Object.fromEntries(ids.map(n => [`A${n}`, thread(THREAD, `${ferret} ${n}`)])),
          carriedEntries: Object.fromEntries(ids.map(n => [`A${n}`, entryOf(ferret, n)])),
        }),
  };
};

/** The longest gap between two turns of the event loop while `work` runs, from a probe that re-arms on every turn. */
async function longestStall(work: () => Promise<void>): Promise<number> {
  let longest = 0;
  let last = performance.now();
  let running = true;
  const probe = (): void => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
    if (running) setImmediate(probe);
  };
  setImmediate(probe);
  await work();
  running = false;
  await new Promise<void>(resolve => setImmediate(resolve));
  return Math.max(longest, performance.now() - last);
}

describe('The agenda sync after boot never stalls the event loop', () => {
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'agenda-boot-stall-'));
  });
  afterAll(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const plant = async (ferret: string, board: AgendaLedger): Promise<void> => {
    await mkdir(join(home, 'state', 'asks', 'ferrets', ferret), { recursive: true });
    await Bun.write(agendaFilePath(home, ferret, 'agenda.json'), agendaLedgerDocument(board));
  };

  test(
    `should read ${FERRETS} ferrets' boards through the boot jobs with no stretch over ${BUDGET_MS} ms`,
    async () => {
      // Arrange
      for (let n = 0; n < FERRETS; n += 1)
        await plant(`ferret-${n}`, boardOf(`ferret-${n}`, n < FAT_FERRETS ? COLD_PER_FAT_FERRET : 0));
      const half = await asksHalf({}, { home, clock: turnClock(), resurfaceAfterMinutes: 1 });

      // Act
      const stall = await longestStall(async () => await half.start());

      // Assert
      const listed = await half.call('GET /v1/ferrets/:ferretId/agenda', { ferretId: 'ferret-499' });
      should(listed.json<{ items: unknown[] }>().items).length(1);
      should(stall).be.below(BUDGET_MS);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    `should take the first change to a board of ${FAT_BOARD_COLD} cold threads with no stretch over ${BUDGET_MS} ms`,
    async () => {
      // Arrange
      await plant('ferret-fat', boardOf('ferret-fat', FAT_BOARD_COLD));
      const half = await asksHalf({}, { home, clock: turnClock() });

      // Act
      const stall = await longestStall(async () => {
        const raised = await half.call(
          BOARD,
          { ferretId: 'ferret-fat' },
          RAISE,
          ferretStanding('ferret-fat' as FerretId),
        );
        should(raised.status).equal(200);
      });

      // Assert
      should(stall).be.below(BUDGET_MS);
    },
    TEST_TIMEOUT_MS,
  );
});
