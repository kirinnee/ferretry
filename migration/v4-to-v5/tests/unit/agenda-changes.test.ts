/**
 * v4's `agenda-changes.pending.json` is a QUEUE of agenda-change notices (delivered at a ferret's next turn end), not an
 * in-flight write. The converter carries it into v5's own queue, which v5's REAL outbox reader is run against below.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { agendaStep } from '../../src/steps/agenda.ts';
import {
  type AgendaLedger,
  agendaLedgerDocument,
  applyAgendaCommand,
  emptyAgendaLedger,
} from '../../src/v4/agenda/engine/state-machine.ts';
import { AT, fixture } from './ferret-fixture.ts';

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});

const REPO = resolve(import.meta.dir, '../../../..');
type Json = Record<string, unknown>;
const at = (minute: number) => `2026-11-01T00:${String(minute).padStart(2, '0')}:00.000Z`;

async function putText(path: string, text: string) {
  const target = join(f.from, path);
  await mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
  await writeFile(target, text, { mode: 0o600 });
}

/** A v4 board with one open ask, plus the change events v4's own engine queued for it (as v4 persisted them). */
function board(ferret: string) {
  let ledger: AgendaLedger = emptyAgendaLedger(ferret, AT);
  const effects: Json[] = [];
  const apply = (command: Parameters<typeof applyAgendaCommand>[1], id: string) => {
    const mutation = applyAgendaCommand(ledger, command);
    if (!mutation.ok) throw new Error(mutation.error.message);
    ledger = mutation.ledger;
    effects.push({
      id,
      event: {
        change: mutation.change,
        actor: command.actor,
        via: 'conversation',
        snapshot: mutation.snapshot,
        ...(mutation.item === undefined ? {} : { item: mutation.item }),
        ...(mutation.addressed === undefined ? {} : { addressed: mutation.addressed }),
      },
    });
  };
  apply(
    {
      action: 'raise',
      actor: { kind: 'agent', sessionId: ferret, name: ferret },
      at: at(0),
      request: {
        source: 'agent-raised',
        sourceRef: null,
        subject: 'FAKE subject',
        why: 'FAKE why',
        howToResolve: 'FAKE answer',
        premise: 'FAKE premise',
        context: 'FAKE context',
        ask: { kind: 'open-question' },
      },
    },
    'e1',
  );
  apply({ action: 'resolve', actor: { kind: 'human' }, id: 'A1' as never, note: 'FAKE done', at: at(1) }, 'e2');
  return { ledger, effects };
}

/** v5's REAL outbox reader (its strict envelope schema) over a converted queue. */
async function readWithV5(ferret: string): Promise<number> {
  const script = join(f.root, 'verify-changes.ts');
  await writeFile(
    script,
    `
const [repo, file] = process.argv.slice(2);
const { AgendaChangeEffectSchema } = await import(repo + '/packages/core/asks/daemon/adapters/agenda/file-agenda-change-outbox.ts');
const { z } = await import('zod');
const { readFileSync } = await import('node:fs');
console.log(z.array(AgendaChangeEffectSchema).parse(JSON.parse(readFileSync(file, 'utf8'))).length);
`,
  );
  const child = Bun.spawn(
    ['bun', script, REPO, join(f.to, 'state/asks/ferrets', ferret, 'agenda-changes.pending.json')],
    {
      cwd: REPO,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [text, error] = [await new Response(child.stdout).text(), await new Response(child.stderr).text()];
  if ((await child.exited) !== 0) throw new Error(error);
  return Number(text.trim());
}

test('a queue of undelivered agenda changes is carried to v5, not refused', async () => {
  const { ledger, effects } = board('f1');
  await putText('state/sessions/f1/agenda.json', agendaLedgerDocument(ledger));
  // A parked change (v4 gave up after 5 attempts) and a v4-only gate field in an item: both must read in v5.
  effects[0]!.retry = { attempts: 5, nextAttemptAt: 1, error: 'FAKE-ERROR' };
  const first = effects[0]!.event as { item: Json; snapshot: { items: Json[] } };
  first.item.gateAttached = { FAKE: true };
  first.snapshot.items[0]!.gate = { FAKE: true };
  await putText('state/sessions/f1/agenda-changes.pending.json', JSON.stringify(effects));

  const report = await agendaStep.run(f.ctx());
  expect(report.status).toBe('converted');
  const kept = Object.fromEntries(report.kept.map(entry => [entry.what, entry.count]));
  expect(kept['agenda-change queues carried (v5 delivers them at its first drain)']).toBe(1);
  expect(kept['queued agenda changes carried']).toBe(2);

  expect(await readWithV5('f1')).toBe(2);
  const carried = JSON.parse(
    await readFile(join(f.to, 'state/asks/ferrets/f1/agenda-changes.pending.json'), 'utf8'),
  ) as Json[];
  expect(carried.map(effect => effect.id)).toEqual(['e1', 'e2']);
  expect(JSON.stringify(carried)).not.toContain('FAKE-ERROR');
  expect(JSON.stringify(carried)).not.toContain('gateAttached');
  expect(JSON.stringify(carried)).not.toContain('"gate"');
});

test('an empty queue is still not carried', async () => {
  const { ledger } = board('f1');
  await putText('state/sessions/f1/agenda.json', agendaLedgerDocument(ledger));
  await putText('state/sessions/f1/agenda-changes.pending.json', '[]');
  expect((await agendaStep.run(f.ctx())).status).toBe('converted');
  expect(await readdir(join(f.to, 'state/asks/ferrets/f1'))).not.toContain('agenda-changes.pending.json');
});

test('a queue v5 cannot read is set aside whole and the ferret is named; nothing is dropped silently, no content is reported', async () => {
  const { ledger } = board('f1');
  await putText('state/sessions/f1/agenda.json', agendaLedgerDocument(ledger));
  const text = '[{"FAKE-SECRET":1}]';
  await putText('state/sessions/f1/agenda-changes.pending.json', text);
  const report = await agendaStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(JSON.stringify(report)).not.toContain('FAKE-SECRET');
  const entry = report.kept.find(each => each.what.startsWith('agenda-change queues v5 cannot read'));
  expect(entry?.count).toBe(1);
  expect(entry?.what).toContain('f1');
  expect(await readFile(join(f.to, 'state/asks/set-aside/f1~agenda-changes.pending.json.unreadable-v4'), 'utf8')).toBe(
    text,
  );
  expect(await readdir(join(f.to, 'state/asks/ferrets/f1'))).not.toContain('agenda-changes.pending.json');
});
