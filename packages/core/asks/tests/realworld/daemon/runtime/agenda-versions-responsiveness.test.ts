import { it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { FileAgendaVersionStore } from '../../../../daemon/adapters/agenda/worker-agenda-versions.ts';
import { LoadSafeWorker } from '../../../src/adapters/runtime/load-safe-worker.ts';
import { applyAgendaCommandToSession } from '../../../../daemon/lib/agenda/state-machine.ts';

const AT = '2026-11-03T10:00:00.000Z';
const SESSION = 'archive-responsive';
const raised = applyAgendaCommandToSession(null, SESSION, {
  action: 'raise',
  at: AT,
  actor: { kind: 'agent', sessionId: SESSION, name: 'Ada' },
  request: {
    source: 'agent-raised',
    sourceRef: null,
    subject: 'Which region?',
    why: 'Release waits.',
    context: 'Ready.',
    premise: 'Release ready.',
    howToResolve: 'Answer.',
    ask: { kind: 'open-question' },
  },
});
if (!raised.ok || raised.ledger.entries[0] === undefined) throw new Error('no fixture');
const ENTRY = raised.ledger.entries[0];

/** Sample the main loop across IO and its last timer turn, including the first open/import. */
async function responsive(work: () => Promise<void>): Promise<{ ticks: number; longest: number }> {
  let ticks = 0;
  let longest = 0;
  let previous = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - previous - 10);
    previous = now;
    ticks++;
  }, 10);
  try {
    await work();
    await Bun.sleep(30);
    return { ticks, longest };
  } finally {
    clearInterval(timer);
  }
}

it('awaits slow SQLite commits while the main loop remains responsive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agenda-commit-responsive-'));
  const store = new FileAgendaVersionStore(() => root, {
    spawn: () =>
      new LoadSafeWorker(new URL('../../integration/support/slow-agenda-versions.worker.ts', import.meta.url), {
        type: 'module',
      }),
  });
  try {
    const measured = await responsive(() =>
      store.record(SESSION, [{ entry: ENTRY, at: AT, by: 'ferret', change: 'created' }]),
    );
    should(measured.ticks).be.above(50);
    should(measured.longest).be.below(200);
    should((await store.list(SESSION, 'A1')).map(row => row.version)).deepEqual([1]);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
