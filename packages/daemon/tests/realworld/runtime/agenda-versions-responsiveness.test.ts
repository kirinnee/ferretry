import { it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { FileAgendaVersionStore } from '../../../src/adapters/agenda/worker-agenda-versions.ts';
import { LoadSafeWorker } from '../../../src/adapters/runtime/load-safe-worker.ts';
import { applyAgendaCommandToSession } from '../../../src/lib/agenda/state-machine.ts';

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

it('imports 100 legacy versions of repeated 1.1 MB words without holding the main loop past 200 ms', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agenda-import-responsive-'));
  const store = new FileAgendaVersionStore(() => root);
  try {
    const directory = join(root, 'agenda-versions');
    await mkdir(directory);
    const conversation = [{ at: AT, by: 'owner', via: 'chat-log', text: 'x'.repeat(1_100_000) }];
    // Write one line at a time; fixture construction is outside the measured window.
    for (let version = 1; version <= 100; version++) {
      const snapshot = { version, at: AT, by: 'owner', change: 'edited', lifecycle: ENTRY.lifecycle, item: ENTRY.item };
      await writeFile(join(directory, 'A1.jsonl'), `${JSON.stringify({ snapshot, conversation })}\n`, { flag: 'a' });
    }
    const measured = await responsive(async () => {
      should(await store.list(SESSION, 'A1')).have.length(100);
      should((await store.conversation(SESSION, 'A1', 100))?.[0]?.text).equal(conversation[0]?.text);
    });
    should(measured.ticks).be.above(0);
    should(measured.longest).be.below(200);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

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
