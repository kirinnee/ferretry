// Perf tier: asserts a speed budget (the longest synchronous stretch); the outcome depends on the machine.
import { afterAll, beforeAll, describe, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { SqliteAgendaVersionStore } from '../../../daemon/adapters/agenda/file-agenda-versions.ts';
import { applyAgendaCommandToSession } from '../../../daemon/lib/agenda/state-machine.ts';
import type { AgendaEntry } from '../../../daemon/lib/agenda/state-machine.ts';
import type { AgendaVersionDraft } from '../../../daemon/lib/agenda/versions.ts';
import type { AgendaConversationEntry } from '../../../daemon/lib/protocol/agenda.ts';
import { asksStateAt } from '../../support/daemon/agenda-state.ts';

/**
 * THE DAEMON MUST NOT STALL ON THE AGENDA'S VERSION ARCHIVES. On a real-size home one `record()` of a ledger's drafts
 * (an old board's items kept as 'carried', then archived) held the event loop for 3.99 s: each draft opens its own
 * `<ferret>~<id>.sqlite` (create four tables, switch to WAL, commit, checkpoint on close), about 25 ms apiece, and the
 * loop yielded only after the LAST one. The budget is no single synchronous stretch over 250 ms, measured by a
 * loop-lag probe over fake data in a temp home. The correctness half lives in the unit and integration tiers.
 */
const BUDGET_MS = 250;
const TEST_TIMEOUT_MS = 120_000;
const SESSION = 'session-1';
const AT = '2026-07-30T10:00:00Z';
const ITEMS = 160;
const THREAD = 1000;

/** The turn the daemon's kernel clock gives (`clock.sleep(0)`), as a test without the kernel has it. */
const nextTurn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

const entryAt = (n: number): AgendaEntry => {
  const raised = applyAgendaCommandToSession(null, SESSION, {
    action: 'raise',
    actor: { kind: 'agent', sessionId: SESSION, name: 'Ada' },
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

describe('Agenda version archives never stall the event loop', () => {
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'agenda-versions-stall-'));
  });
  afterAll(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test(
    `should record a ${ITEMS}-item ledger of carried and archived drafts with no stretch over ${BUDGET_MS} ms`,
    async () => {
      // Arrange
      const store = new SqliteAgendaVersionStore(asksStateAt(home), nextTurn);
      const drafts: AgendaVersionDraft[] = Array.from({ length: ITEMS }, (_, index) => {
        const entry = entryAt(index + 1);
        return {
          entry,
          before: entry,
          beforeConversation: thread(20, `before ${index}`),
          conversation: thread(20, `after ${index}`),
          at: AT,
          by: 'daemon' as const,
          change: 'archived',
        };
      });

      // Act
      const stall = await longestStall(async () => await store.record(SESSION, drafts));

      // Assert
      should((await readdir(join(home, 'state', 'asks', 'versions'))).filter(name => name.endsWith('.sqlite'))).length(
        ITEMS,
      );
      should(stall).be.below(BUDGET_MS);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    `should record one item holding a ${THREAD}-word thread with no stretch over ${BUDGET_MS} ms`,
    async () => {
      // Arrange
      const store = new SqliteAgendaVersionStore(asksStateAt(home), nextTurn);
      const entry = entryAt(ITEMS + 1);
      const draft: AgendaVersionDraft = {
        entry,
        before: entry,
        beforeConversation: thread(THREAD, 'before'),
        conversation: thread(THREAD, 'after'),
        at: AT,
        by: 'daemon',
        change: 'archived',
      };

      // Act
      const stall = await longestStall(async () => await store.record(SESSION, [draft]));

      // Assert
      should((await store.list(SESSION, entry.item.id)).length).equal(2);
      should(stall).be.below(BUDGET_MS);
    },
    TEST_TIMEOUT_MS,
  );
});
