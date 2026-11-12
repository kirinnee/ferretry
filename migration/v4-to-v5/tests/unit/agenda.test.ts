import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { agendaStep } from '../../src/steps/agenda.ts';
import { STEPS } from '../../src/steps/index.ts';
import {
  type AgendaLedger,
  agendaLedgerDocument,
  applyAgendaCommand,
  emptyAgendaLedger,
} from '../../src/v4/agenda/engine/state-machine.ts';
import { VERSION_TABLES } from '../../src/v4/agenda/read.ts';
import { AT, fixture } from './ferret-fixture.ts';

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});

const REPO = resolve(import.meta.dir, '../../../..');
const at = (minute: number) => `2026-11-01T00:${String(minute).padStart(2, '0')}:00.000Z`;
type Json = Record<string, unknown>;

/** A real v4 board, made by v4's own (vendored) engine: A1 replied to (resting), A2 closed done. */
function v4Board(ferret = 'f1', extraActive = 0): AgendaLedger {
  let ledger = emptyAgendaLedger(ferret, AT);
  const apply = (command: Parameters<typeof applyAgendaCommand>[1]) => {
    const mutation = applyAgendaCommand(ledger, command);
    if (!mutation.ok) throw new Error(mutation.error.message);
    ledger = mutation.ledger;
  };
  const raise = (subject: string, minute: number, human = false) =>
    apply({
      action: 'raise',
      actor: human ? { kind: 'human' } : { kind: 'agent', sessionId: ferret, name: ferret },
      at: at(minute),
      request: {
        source: 'agent-raised',
        sourceRef: null,
        subject,
        why: 'FAKE why',
        howToResolve: 'FAKE answer',
        premise: 'FAKE premise',
        context: 'FAKE context',
        ask: { kind: 'open-question' },
      },
    });
  raise('FAKE first', 0);
  raise('FAKE second', 1);
  apply({ action: 'resolve', actor: { kind: 'human' }, id: 'A2' as never, note: 'FAKE done', at: at(2) });
  apply({ action: 'reply', actor: { kind: 'human' }, id: 'A1' as never, note: 'FAKE reply', at: at(3) } as never);
  for (let index = 0; index < extraActive; index++) raise(`FAKE filler ${index}`, 4 + index, index >= 9);
  return ledger;
}

const GATE = {
  cardId: 'card1',
  laneId: 'lane1',
  laneName: 'FAKE lane',
  entry: 1,
  projectId: 'project1',
  options: [{ id: 'done', label: 'Done', outcome: 'next' }],
};

const document = (ledger: AgendaLedger): Json => JSON.parse(agendaLedgerDocument(ledger)) as Json;
const entries = (value: Json) => value.entries as { lifecycle: string; item: Json }[];
const item = (value: Json, id: string) => entries(value).find(entry => entry.item.id === id);

async function putText(path: string, text: string | Uint8Array) {
  const target = join(f.from, path);
  await mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
  await writeFile(target, text, { mode: 0o600 });
}

/** A v4 version archive at `user_version` 2 (or 1), holding the given snapshots. */
function archive(path: string, snapshots: Json[], userVersion = 2) {
  const db = new Database(path, { create: true });
  for (const sql of VERSION_TABLES) if (userVersion === 2 || !sql.includes('mutations')) db.run(sql);
  for (const snapshot of snapshots)
    db.run('INSERT INTO versions VALUES (?, ?, ?)', [
      snapshot.version as number,
      JSON.stringify(snapshot),
      JSON.stringify({
        version: snapshot.version,
        at: snapshot.at,
        by: snapshot.by,
        change: snapshot.change,
        lifecycle: snapshot.lifecycle,
      }),
    ]);
  db.run(`PRAGMA user_version = ${userVersion}`);
  db.close();
}

const out = (ferret: string, name: string) => join(f.to, 'state/asks/ferrets', ferret, name);
const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as Json;

/** v5's REAL readers, run in a subprocess that imports nothing from this tool: the bytes must read back. */
async function readWithV5(ferrets: string[]): Promise<Json> {
  const script = join(f.root, 'verify-v5.ts');
  await writeFile(
    script,
    `
const [repo, home, ...ferrets] = process.argv.slice(2);
const { parseAgendaLedger } = await import(repo + '/packages/core/asks/daemon/lib/agenda/state-machine.ts');
const { AgendaArchiveRecordSchema } = await import(repo + '/packages/core/asks/daemon/lib/agenda/archive.ts');
const { AgendaVersionSchema } = await import(repo + '/packages/core/asks/daemon/lib/protocol/agenda-versions.ts');
const { Database } = await import('bun:sqlite');
const { existsSync, readFileSync, readdirSync } = await import('node:fs');
const result = {};
for (const ferret of ferrets) {
  const dir = home + '/state/asks/ferrets/' + ferret;
  const ledger = parseAgendaLedger(JSON.parse(readFileSync(dir + '/agenda.json', 'utf8')), ferret);
  const history = existsSync(dir + '/agenda-history.jsonl') ? readFileSync(dir + '/agenda-history.jsonl') : Buffer.alloc(0);
  const committed = history.subarray(0, ledger?.archive?.bytes ?? 0).toString('utf8');
  const records = committed === '' ? [] : committed.slice(0, -1).split('\\n').map(line => AgendaArchiveRecordSchema.parse(JSON.parse(line)));
  result[ferret] = {
    read: ledger !== null,
    unreadable: ledger?.unreadable?.length ?? 0,
    entries: ledger?.entries.length ?? 0,
    historyMatchesCursor: (ledger?.archive?.bytes ?? 0) === history.length && (ledger?.archive?.count ?? 0) === records.length,
  };
}
const versions = home + '/state/asks/versions';
for (const name of existsSync(versions) ? readdirSync(versions) : []) {
  const db = new Database(versions + '/' + name, { readonly: true });
  const format = db.query('PRAGMA user_version').get().user_version;
  const rows = db.query('SELECT snapshot FROM versions').all();
  rows.forEach(row => AgendaVersionSchema.parse(JSON.parse(row.snapshot)));
  const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => row.name);
  result[name] = { format, rows: rows.length, tables };
  db.close();
}
console.log(JSON.stringify(result));
`,
  );
  const child = Bun.spawn(['bun', script, REPO, f.to, ...ferrets], { cwd: REPO, stdout: 'pipe', stderr: 'pipe' });
  const [text, error] = [await new Response(child.stdout).text(), await new Response(child.stderr).text()];
  if ((await child.exited) !== 0) throw new Error(error);
  return JSON.parse(text) as Json;
}

test('is registered in place of the pending asks step', () => {
  expect(STEPS.find(step => step.id === 'asks')).toBe(agendaStep);
});

test('a version-4 board: version 1, gate fields dropped, replied close done, cursor recomputed, v5 reads it', async () => {
  // 20 open asks: v4's read has no room to reopen A3's replied close, so it stays closed.
  const ledger = v4Board('f1', 19);
  const v4 = document(ledger);
  const a1 = item(v4, 'A1');
  if (a1 === undefined) throw new Error('fixture');
  a1.item.gateAttached = GATE;
  a1.item.gateAttachedChangedAt = at(5);
  const a2 = item(v4, 'A2');
  if (a2 === undefined) throw new Error('fixture');
  const replied = { ...a2, item: { ...a2.item, id: 'A22', disposition: 'replied' } };
  entries(v4).push(replied);
  v4.nextId = 23;
  // History: an owner-history record and a version record of a replied close.
  const lines = [
    JSON.stringify({ kind: 'owner-history', id: 'A1', entry: { at: at(3), kind: 'replied', note: 'FAKE old words' } }),
    JSON.stringify({ kind: 'version', id: 'A22', item: replied.item }),
  ];
  const history = `${lines.join('\n')}\n`;
  v4.archive = { bytes: Buffer.byteLength(history), count: 2 };
  await putText('state/sessions/f1/agenda.json', `${JSON.stringify(v4, null, 2)}\n`);
  await putText('state/sessions/f1/agenda-history.jsonl', history);
  await putText('state/sessions/f1/agenda-changes.pending.json', '[]');
  const replies = `${JSON.stringify({ v: 1, sessionId: 'f1', pending: [{ id: 'A1', message: 'FAKE held', at: at(6) }], sending: [], delivered: [] }, null, 2)}\n`;
  await putText('state/sessions/f1/agenda-replies.json', replies);
  const seen = `${JSON.stringify({ device1: { A1: 2 } }, null, 2)}\n`;
  await putText('state/sessions/f1/agenda-seen.json', seen);
  await putText('state/sessions/f1/attention.json.migrated', 'FAKE-RETIRED');

  const report = await agendaStep.run(f.ctx());
  expect(report.status).toBe('converted');
  const kept = Object.fromEntries(report.kept.map(entry => [entry.what, entry.count]));
  expect(kept['agenda boards (ferrets and the machine agenda)']).toBe(1);
  expect(kept['boards upgraded from an older v4 shape with v4’s own reader']).toBe(0);
  expect(kept['replied closes carried as done']).toBe(1);
  expect(kept['deprecated gate fields dropped']).toBeGreaterThan(0);
  expect(kept['entries v5 sets aside as unreadable (kept byte for byte)']).toBe(0);
  expect(kept['retired pre-rename agenda files not carried']).toBe(1);
  expect(kept['held answers and batches']).toBe(1);

  const v5 = await readJson(out('f1', 'agenda.json'));
  expect(v5.version).toBe(1);
  expect(Object.keys(v5)).toEqual([
    'sessionId',
    'nextId',
    'entries',
    'conversations',
    'updatedAt',
    'archive',
    'version',
  ]);
  expect(JSON.stringify(v5)).not.toContain('gateAttached');
  expect(entries(v5).some(entry => 'gate' in entry.item || 'gateAttachedChangedAt' in entry.item)).toBe(false);
  expect(item(v5, 'A22')?.item.disposition).toBe('done');
  expect(item(v5, 'A1')?.item.parked).toEqual({ reason: 'replied', at: at(3) });
  // v4's read lifted the bare gate into a card ask; v5 keeps the card ask, not the mirror.
  expect((item(v5, 'A1')?.item.cardAsks as { gate: Json }[] | undefined)?.[0]?.gate).toEqual(GATE);
  expect(entries(v5)).toHaveLength(22);
  // History: the replied version record is now done, the owner-history line is byte-identical.
  const newHistory = await readFile(out('f1', 'agenda-history.jsonl'), 'utf8');
  const newLines = newHistory.slice(0, -1).split('\n');
  expect(newLines[0]).toBe(lines[0]);
  expect((JSON.parse(newLines[1] ?? '{}') as { item: Json }).item.disposition).toBe('done');
  expect(v5.archive).toEqual({ bytes: Buffer.byteLength(newHistory), count: 2 });
  // Held answers and seen marks: byte for byte.
  expect(await readFile(out('f1', 'agenda-replies.json'), 'utf8')).toBe(replies);
  expect(await readFile(out('f1', 'agenda-seen.json'), 'utf8')).toBe(seen);
  expect((await stat(out('f1', 'agenda.json'))).mode & 0o777).toBe(0o600);

  const read = await readWithV5(['f1']);
  expect(read.f1).toEqual({ read: true, unreadable: 0, entries: 22, historyMatchesCursor: true });
});

test('an unversioned board goes through v4’s own read-time upgrade first', async () => {
  const legacy = document(v4Board());
  delete legacy.version;
  delete legacy.conversations;
  for (const entry of entries(legacy))
    for (const key of ['stage', 'stages', 'resting', 'conversation', 'conversationCount', 'conversationLastAt'])
      delete entry.item[key];
  // An older daemon kept its sidecar without a cursor: its complete lines are adopted.
  const old = `${JSON.stringify({ kind: 'owner-history', id: 'A1', entry: { at: at(1), kind: 'discuss', note: 'FAKE earlier' } })}\n`;
  await putText('state/sessions/f1/agenda.json', `${JSON.stringify(legacy, null, 2)}\n`);
  await putText('state/sessions/f1/agenda-history.jsonl', old);
  const report = await agendaStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.kept.find(entry => entry.what.startsWith('boards upgraded'))?.count).toBe(1);
  const v5 = await readJson(out('f1', 'agenda.json'));
  expect(v5.version).toBe(1);
  const a1 = item(v5, 'A1')?.item;
  // v4's toChannel: a replied park rests (marked migrated), every item names a stage, threads are seeded.
  expect(a1?.resting).toMatchObject({ sub: 'waiting-on-ferret', migrated: true });
  expect(a1?.stage).toBe('question');
  expect((v5.conversations as Json).A1).toBeDefined();
  expect((await readFile(out('f1', 'agenda-history.jsonl'), 'utf8')).startsWith(old)).toBe(true);
  expect((await readWithV5(['f1'])).f1).toMatchObject({ read: true, unreadable: 0, historyMatchesCursor: true });
});

test('version archives are copied, brought to v5 format 1, and the v4 file is never touched', async () => {
  const v4 = document(v4Board());
  await putText('state/sessions/f1/agenda.json', `${JSON.stringify(v4, null, 2)}\n`);
  const a2 = item(v4, 'A2');
  if (a2 === undefined) throw new Error('fixture');
  const versionsDir = join(f.from, 'state/sessions/f1/agenda-versions');
  await mkdir(versionsDir, { recursive: true });
  const replied = {
    version: 1,
    at: at(2),
    by: 'owner',
    change: 'replied',
    lifecycle: 'addressed',
    item: { ...a2.item, disposition: 'replied' },
  };
  archive(join(versionsDir, 'A2.sqlite'), [replied]);
  const a1 = item(v4, 'A1');
  if (a1 === undefined) throw new Error('fixture');
  const created = { version: 1, at: at(0), by: 'ferret', change: 'created', lifecycle: 'active', item: a1.item };
  archive(join(versionsDir, 'A1.sqlite'), [created], 1);
  // A draft archive with no SQLite file yet: imported once, as v4's open did.
  await writeFile(
    join(versionsDir, 'A3.jsonl'),
    `${JSON.stringify({ snapshot: { ...created, item: { ...a1.item, id: 'A3' } } })}\n`,
  );
  const before = await readFile(join(versionsDir, 'A2.sqlite'));

  const report = await agendaStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.kept.find(entry => entry.what === 'version archives')?.count).toBe(3);
  expect(report.kept.find(entry => entry.what.startsWith('version snapshots'))?.count).toBe(1);
  expect(await readFile(join(versionsDir, 'A2.sqlite'))).toEqual(before);
  expect((await readdir(join(f.to, 'state/asks/versions'))).sort()).toEqual([
    'f1~A1.sqlite',
    'f1~A2.sqlite',
    'f1~A3.sqlite',
  ]);
  const read = await readWithV5(['f1']);
  const tables = ['mutations', 'version_words', 'versions', 'words'];
  expect(read['f1~A1.sqlite']).toEqual({ format: 1, rows: 1, tables });
  expect(read['f1~A2.sqlite']).toEqual({ format: 1, rows: 1, tables });
  expect(read['f1~A3.sqlite']).toEqual({ format: 1, rows: 1, tables });
});

test('an unfinished v4 commit fails the step, naming the file and never its content', async () => {
  await putText('state/sessions/f1/agenda.json', `${JSON.stringify(document(v4Board()), null, 2)}\n`);
  for (const [name, text] of [
    ['agenda-versions.pending.json', '{"FAKE-SECRET":1}'],
    ['agenda-history.jsonl.pending', '{"bytes":0,"FAKE-SECRET":1}'],
    ['agenda-changes.pending.json', '[{"FAKE-SECRET":1}]'],
  ] as const) {
    await putText(`state/sessions/f1/${name}`, text);
    const report = await agendaStep.run(f.ctx(true));
    expect(report.status).toBe('failed');
    expect(report.note).toContain(`state/sessions/f1/${name}`);
    expect(JSON.stringify(report)).not.toContain('FAKE-SECRET');
    await Bun.file(join(f.from, `state/sessions/f1/${name}`)).delete();
  }
  expect((await agendaStep.run(f.ctx(true))).status).toBe('converted');
});

test('a ledger of another ferret fails without reporting its values', async () => {
  const other = document(v4Board('someone-else'));
  await putText('state/sessions/f1/agenda.json', JSON.stringify({ ...other, nextId: 'FAKE-SECRET' }));
  const report = await agendaStep.run(f.ctx());
  expect(report.status).toBe('failed');
  expect(JSON.stringify(report)).not.toContain('FAKE-SECRET');
});

test('the machine agenda, a never-renamed attention.json, damaged files set aside, notifications to buzzes and seen', async () => {
  await putText(
    'state/machine-agenda/agenda.json',
    `${JSON.stringify(document(v4Board('machine-agenda')), null, 2)}\n`,
  );
  // f2 was never renamed: v4 read attention.json when agenda.json was absent.
  await putText('state/sessions/f2/attention.json', `${JSON.stringify(document(v4Board('f2')), null, 2)}\n`);
  await putText('state/sessions/f2/attention-replies.json', 'FAKE-DAMAGED');
  await putText('state/sessions/f2/agenda-seen.json.corrupt-1', 'FAKE-CORRUPT');
  const card = document(v4Board('f3'));
  const a1 = item(card, 'A1');
  if (a1 === undefined) throw new Error('fixture');
  a1.item.gateAttached = GATE; // v4's read lifts it into a card ask
  await putText('state/sessions/f3/agenda.json', `${JSON.stringify(card, null, 2)}\n`);
  const sent = { kind: 'agenda', interactive: false, title: 'FAKE buzz', body: 'FAKE' };
  const notification = (extra: Json) =>
    JSON.stringify({
      v: 1,
      phase: 'requested',
      at: at(7),
      origin: 'agenda',
      attribution: 'x',
      sessionId: 'f2',
      agendaId: 'A1',
      sent,
      enrolled: 2,
      ...extra,
    });
  await putText(
    'state/notifications.jsonl',
    [
      notification({ key: 'agenda:f2:A1:ping', ping: true }),
      notification({ key: 'agenda:f2:A1:ping2', ping: true, at: at(8) }),
      notification({ key: 'agenda:f2:A1:deadline', deadline: true }),
      notification({ key: 'agenda:f3:A1', sessionId: 'f3', at: at(10) }),
      JSON.stringify({
        v: 1,
        phase: 'requested',
        key: 'clear:1',
        at: at(9),
        origin: 'agenda-clear',
        sessionId: 'f2',
        opened: 'A1',
        covers: [],
        tags: ['t'],
        enrolled: 0,
      }),
      JSON.stringify({ v: 1, phase: 'outcome', key: 'agenda:f2:A1', at: at(9), delivered: 1, failed: 0 }),
      'FAKE-TORN-LINE',
    ].join('\n'),
  );

  const report = await agendaStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.kept.find(entry => entry.what.startsWith('agenda boards'))?.count).toBe(3);
  expect((await readJson(out('machine-agenda', 'agenda.json'))).sessionId).toBe('machine-agenda');
  expect((await readJson(out('f2', 'agenda.json'))).version).toBe(1);
  expect(await readFile(join(f.to, 'state/asks/set-aside/f2~agenda-replies.json.damaged-v4'), 'utf8')).toBe(
    'FAKE-DAMAGED',
  );
  expect(await readFile(join(f.to, 'state/asks/set-aside/f2~agenda-seen.json.corrupt-1'), 'utf8')).toBe('FAKE-CORRUPT');
  const buzzes = (await readFile(join(f.to, 'state/agenda/buzzes.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as Json);
  expect(buzzes).toEqual([
    {
      format: 1,
      key: 'ask:f2:A1',
      at: at(7),
      kind: 'notice',
      ferret: 'f2',
      ask: 'A1',
      title: 'FAKE buzz',
      enrolled: 2,
    },
    {
      format: 1,
      key: 'ask:f3:A1',
      at: at(10),
      kind: 'card-ask',
      ferret: 'f3',
      ask: 'A1',
      title: 'FAKE buzz',
      enrolled: 2,
    },
  ]);
  expect(await readJson(join(f.to, 'state/agenda/seen.json'))).toEqual({ format: 1, seen: { f2: { A1: at(9) } } });
  expect(report.kept.find(entry => entry.what.startsWith('unreadable notification'))?.count).toBe(1);
  const read = await readWithV5(['machine-agenda', 'f2', 'f3']);
  for (const ferret of ['machine-agenda', 'f2', 'f3'])
    expect(read[ferret]).toMatchObject({ read: true, unreadable: 0 });
});

test('a home with no agenda converts to nothing, and a dry run writes nothing', async () => {
  expect((await agendaStep.run(f.ctx())).status).toBe('converted');
  await putText('state/sessions/f1/agenda.json', `${JSON.stringify(document(v4Board()), null, 2)}\n`);
  const versionsDir = join(f.from, 'state/sessions/f1/agenda-versions');
  await mkdir(versionsDir, { recursive: true });
  archive(join(versionsDir, 'A1.sqlite'), []);
  const report = await agendaStep.run(f.ctx(true));
  expect(report.status).toBe('converted');
  expect(report.note).toBe('dry run: nothing written');
  expect(await stat(join(f.to, 'state/asks')).catch(() => undefined)).toBeUndefined();
});

/**
 * Audit A fix 8: what v5's REAL ferret-read classifier (`core/asks/daemon/lib/routes/ferret-reads.ts`, run in a
 * subprocess that imports nothing from this tool) answers for every migrated item, live, resolved and archived.
 */
async function coversWithV5(ferret: string): Promise<Record<string, Record<string, string>>> {
  const script = join(f.root, 'covers-v5.ts');
  await writeFile(
    script,
    `
const [repo, home, ferret] = process.argv.slice(2);
const { coverOf } = await import(repo + '/packages/core/asks/daemon/lib/routes/ferret-reads.ts');
const { Database } = await import('bun:sqlite');
const { existsSync, readFileSync, readdirSync } = await import('node:fs');
const reach = { mayTouch: async (caller, target) => caller === target, startedByWarden: async () => false };
const ledger = JSON.parse(readFileSync(home + '/state/asks/ferrets/' + ferret + '/agenda.json', 'utf8'));
const items = ledger.entries.map(entry => [entry.lifecycle + ' ' + entry.item.id, entry.item]);
const versions = home + '/state/asks/versions';
for (const name of existsSync(versions) ? readdirSync(versions) : []) {
  const db = new Database(versions + '/' + name, { readonly: true });
  for (const row of db.query('SELECT snapshot FROM versions').all()) items.push(['archived ' + name, JSON.parse(row.snapshot).item]);
  db.close();
}
const result = {};
for (const [label, item] of items) {
  result[label] = {
    ownerLineage: await coverOf(reach, ferret, ferret, item, async () => undefined),
    foreignLineage: await coverOf(reach, 'foreign', ferret, item, async () => undefined),
  };
}
console.log(JSON.stringify(result));
`,
  );
  const child = Bun.spawn(['bun', script, REPO, f.to, ferret], { cwd: REPO, stdout: 'pipe', stderr: 'pipe' });
  const [text, error] = [await new Response(child.stdout).text(), await new Response(child.stderr).text()];
  if ((await child.exited) !== 0) throw new Error(error);
  return JSON.parse(text) as Record<string, Record<string, string>>;
}

test('migrated v4 Warden notices — live, resolved and archived — are the Warden’s to a ferret reading them in v5', async () => {
  // A real v4 board: the v4 engine raises each notice as the daemon, in v4's own raw grammar.
  let ledger = emptyAgendaLedger('f1', AT);
  const apply = (command: Parameters<typeof applyAgendaCommand>[1]) => {
    const mutation = applyAgendaCommand(ledger, command);
    if (!mutation.ok) throw new Error(mutation.error.message);
    ledger = mutation.ledger;
  };
  const notice = (sourceRef: string, minute: number) =>
    apply({
      action: 'raise',
      actor: { kind: 'daemon', cause: 'warden-escalation' },
      at: at(minute),
      request: {
        source: 'question',
        sourceRef,
        subject: 'FAKE warden subject',
        why: 'FAKE investigator reason',
        howToResolve: 'FAKE investigator remedy',
        context: 'FAKE investigator context',
        notice: true,
      },
    } as never);
  notice('warden:orphans', 0);
  notice('warden-auto-move', 1);
  apply({ action: 'resolve', actor: { kind: 'human' }, id: 'A2' as never, note: 'FAKE done', at: at(2) });
  const v4 = document(ledger);
  await putText('state/sessions/f1/agenda.json', `${JSON.stringify(v4, null, 2)}\n`);
  // A third notice that left the board: only its archived version remains.
  const a1 = item(v4, 'A1');
  if (a1 === undefined) throw new Error('fixture');
  const versionsDir = join(f.from, 'state/sessions/f1/agenda-versions');
  await mkdir(versionsDir, { recursive: true });
  archive(join(versionsDir, 'A9.sqlite'), [
    { version: 1, at: at(0), by: 'daemon', change: 'created', lifecycle: 'active', item: { ...a1.item, id: 'A9' } },
  ]);

  expect((await agendaStep.run(f.ctx())).status).toBe('converted');

  // The migration keeps the raw grammar (the classifier, not the migration, is what covers it).
  const v5 = await readJson(out('f1', 'agenda.json'));
  expect(item(v5, 'A1')?.item.sourceRef).toBe('warden:orphans');
  expect(item(v5, 'A2')?.item.sourceRef).toBe('warden-auto-move');
  expect(item(v5, 'A1')?.item.raisedBy).toBe('daemon');
  const covers = await coversWithV5('f1');
  expect(Object.keys(covers).sort()).toEqual(['active A1', 'addressed A2', 'archived f1~A9.sqlite']);
  for (const [label, cover] of Object.entries(covers))
    expect([label, cover]).toEqual([label, { ownerLineage: 'project', foreignLineage: 'omit' }]);
});
