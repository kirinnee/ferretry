import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineConfig } from '../../../contract/index.ts';
import { createConfigFiles } from '../../../host/config/service.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';
import { captureLog, HOME, manualClock } from './support.ts';

/**
 * `ConfigPort.writeAsCaller` through the real writer. The judge here is scripted: it answers the owner question (an
 * input with `secretAdd`) from `owner` and every other question from `other`, so these tests pin what the WRITER does
 * with the answers. Which caller is the owner is Gate's, tested where Gate's judge is (`core/gate`, writeAsCaller).
 */
const FAKE_VALUE = 'FAKE-VALUE-7c1e9b-not-a-real-secret';

const mcpDef = defineConfig({
  collection: 'mcp',
  name: /^[a-z]{1,20}$/,
  schema: z.strictObject({
    env: z.record(z.string(), z.string()).default({}),
    note: z.string().optional(),
    limit: z.number().int().default(10),
  }),
  axis: 'configure',
  loosens: (before, after) => (after.limit > (before?.limit ?? 10) ? ['raises the limit'] : []),
});

type Asked = {
  readonly plugin: string;
  readonly path: string;
  readonly removal: boolean;
  readonly sentences: readonly string[];
  readonly secretAdd?: true;
};

function harness(verdicts: { owner: boolean; other: boolean }) {
  const fs = createMemoryHostFs();
  const log = captureLog();
  const asked: Asked[] = [];
  const files = createConfigFiles({
    home: HOME,
    fs,
    clock: manualClock(),
    log,
    binary: 'fy',
    defs: [{ plugin: 'mcp', def: mcpDef }],
    judge: input => (asked.push(input), input.secretAdd === true ? verdicts.owner : verdicts.other),
  });
  return { fs, log, asked, files, path: (relative: string) => `${HOME}/config/${relative}` };
}

const ADD = 'env:\n  TOKEN: ${secret:ACME_TOKEN}\n';

describe('writeAsCaller: a secret reference the edit adds goes into effect only when the ambient call is the owner', () => {
  test('writeAsCaller the owner: the added reference is in effect, the file written, nothing held', async () => {
    const h = harness({ owner: true, other: false });
    await h.files.reload();
    const outcome = await h.files.port('mcp').writeAsCaller(mcpDef, 'acme', ADD);
    expect(outcome.kind).toBe('written');
    expect(h.files.port('mcp').collection(mcpDef).get('acme')).toEqual({
      env: { TOKEN: '${secret:ACME_TOKEN}' },
      limit: 10,
    });
    expect(h.files.held()).toEqual([]);
    expect(h.asked.map(({ secretAdd, removal }) => ({ secretAdd, removal }))).toEqual([
      { secretAdd: true, removal: false },
    ]);
    expect(h.asked[0]?.sentences).toEqual([
      'names the secret ACME_TOKEN, which only the owner may add to a configuration',
    ]);
  });

  test('writeAsCaller anyone else: the same edit is written and HELD, the tighter version stays in effect', async () => {
    const h = harness({ owner: false, other: true });
    await h.files.reload();
    const outcome = await h.files.port('mcp').writeAsCaller(mcpDef, 'acme', ADD);
    expect(outcome.kind).toBe('held');
    expect(h.files.port('mcp').collection(mcpDef).get('acme')).toBeUndefined();
    expect(h.files.held().map(edit => edit.path)).toEqual(['mcp/acme.yaml']);
  });

  test('writeAsCaller a judge that throws holds it', async () => {
    const fs = createMemoryHostFs();
    const files = createConfigFiles({
      home: HOME,
      fs,
      clock: manualClock(),
      log: captureLog(),
      binary: 'fy',
      defs: [{ plugin: 'mcp', def: mcpDef }],
      judge: () => {
        throw new Error('the judge failed');
      },
    });
    await files.reload();
    expect((await files.port('mcp').writeAsCaller(mcpDef, 'acme', ADD)).kind).toBe('held');
  });

  test('writeAsCaller with no judge at all holds it', async () => {
    const files = createConfigFiles({
      home: HOME,
      fs: createMemoryHostFs(),
      clock: manualClock(),
      log: captureLog(),
      binary: 'fy',
      defs: [{ plugin: 'mcp', def: mcpDef }],
    });
    await files.reload();
    expect((await files.port('mcp').writeAsCaller(mcpDef, 'acme', ADD)).kind).toBe('held');
  });

  test('writeAsCaller a plain write of the same edit stays held even when the owner would say yes', async () => {
    const h = harness({ owner: true, other: true });
    await h.files.reload();
    expect((await h.files.port('mcp').write(mcpDef, 'acme', ADD)).kind).toBe('held');
    expect(h.asked.some(input => input.secretAdd === true)).toBe(false);
  });

  test('writeAsCaller writeAsOwner of the same edit stays held too: only writeAsCaller asks the owner question', async () => {
    const h = harness({ owner: true, other: true });
    await h.files.reload();
    const outcome = await h.files
      .port('mcp')
      .writeAsOwner(mcpDef, 'acme', { patch: { env: { TOKEN: '${secret:ACME_TOKEN}' } } });
    expect(outcome.kind).toBe('held');
    expect(h.asked.some(input => input.secretAdd === true)).toBe(false);
  });

  test('writeAsCaller an owner who adds a secret AND loosens something else still needs the plain judge for the loosening', async () => {
    const a = harness({ owner: true, other: false });
    await a.files.reload();
    expect((await a.files.port('mcp').writeAsCaller(mcpDef, 'acme', `${ADD}limit: 50\n`)).kind).toBe('held');
    const b = harness({ owner: true, other: true });
    await b.files.reload();
    const outcome = await b.files.port('mcp').writeAsCaller(mcpDef, 'acme', `${ADD}limit: 50\n`);
    expect(outcome).toMatchObject({ kind: 'written' });
    expect(b.files.port('mcp').collection(mcpDef).get('acme')).toMatchObject({ limit: 50 });
    // the plain judge was asked only about what the file itself loosens, never the secret sentence
    const plain = b.asked.filter(input => input.secretAdd !== true);
    expect(plain.map(input => input.sentences)).toEqual([['raises the limit']]);
  });

  test('writeAsCaller an edit that adds no reference never asks the owner question', async () => {
    const h = harness({ owner: false, other: false });
    await h.files.reload();
    const outcome = await h.files.port('mcp').writeAsCaller(mcpDef, 'acme', 'note: hello\n');
    expect(outcome.kind).toBe('written');
    expect(h.asked).toEqual([]);
  });

  test('writeAsCaller a reference already in effect is not an addition: no question, written', async () => {
    const h = harness({ owner: true, other: false });
    await h.files.reload();
    expect((await h.files.port('mcp').writeAsCaller(mcpDef, 'acme', ADD)).kind).toBe('written');
    h.asked.length = 0;
    const again = await h.files.port('mcp').writeAsCaller(mcpDef, 'acme', `${ADD}note: more\n`);
    expect(again.kind).toBe('written');
    expect(h.asked).toEqual([]);
  });
});

describe('writeAsCaller: nothing a plugin passes can switch the hold off', () => {
  test('writeAsCaller option injection: asOwner, byPlugin, byAgent, confirmedLoosening and judge fields change nothing', async () => {
    const h = harness({ owner: false, other: true });
    await h.files.reload();
    const injected = {
      asOwner: true,
      owner: true,
      byPlugin: false,
      byAgent: false,
      confirmedLoosening: true,
      judgeSecretAdds: () => true,
      judge: () => true,
      secretAdd: true,
    } as unknown as { readonly ifMatch?: string };
    const outcome = await h.files.port('mcp').writeAsCaller(mcpDef, 'acme', ADD, injected);
    expect(outcome.kind).toBe('held');
    expect(h.files.port('mcp').collection(mcpDef).get('acme')).toBeUndefined();
  });

  test('writeAsCaller an edit object carrying owner-looking fields is read as a patch and nothing more', async () => {
    const h = harness({ owner: false, other: true });
    await h.files.reload();
    const edit = { patch: { env: { TOKEN: '${secret:ACME_TOKEN}' } }, asOwner: true } as unknown as {
      readonly patch: Record<string, unknown>;
    };
    expect((await h.files.port('mcp').writeAsCaller(mcpDef, 'acme', edit)).kind).toBe('held');
  });
});

describe('writeAsCaller is judged exactly as write for every edit that adds no reference', () => {
  const CASES: readonly { readonly label: string; readonly start?: string; readonly edit: string }[] = [
    { label: 'a plain tightening write', edit: 'note: a\n' },
    { label: 'a loosening', start: 'limit: 5\n', edit: 'limit: 50\n' },
    { label: 'a tightening', start: 'limit: 50\n', edit: 'limit: 5\n' },
    { label: 'a schema refusal', edit: 'limit: many\n' },
    { label: 'unreadable YAML', edit: 'limit: [\n' },
    { label: 'a raw secret', edit: `note: ${FAKE_VALUE}\nenv:\n  K: sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKE\n` },
    { label: 'an unchanged file', start: 'note: same\n', edit: 'note: same\n' },
  ];
  for (const { label, start, edit } of CASES) {
    for (const verdict of [true, false]) {
      test(`writeAsCaller diff: ${label}, judge ${verdict} — the same outcome and the same file as write`, async () => {
        const viaWrite = harness({ owner: verdict, other: verdict });
        const viaCaller = harness({ owner: verdict, other: verdict });
        for (const h of [viaWrite, viaCaller]) {
          await h.files.reload();
          if (start !== undefined) await h.files.port('mcp').write(mcpDef, 'acme', start, { ifMatch: 'absent' });
        }
        const a = await viaWrite.files.port('mcp').write(mcpDef, 'acme', edit);
        const b = await viaCaller.files.port('mcp').writeAsCaller(mcpDef, 'acme', edit);
        expect(b).toEqual(a);
        expect(viaCaller.fs.snapshot().get(viaCaller.path('mcp/acme.yaml'))).toBe(
          viaWrite.fs.snapshot().get(viaWrite.path('mcp/acme.yaml')),
        );
      });
    }
  }

  test('writeAsCaller a bad name and an undeclared def are answered as write answers them', async () => {
    const h = harness({ owner: true, other: true });
    await h.files.reload();
    const other = defineConfig({
      file: 'other.yaml',
      schema: z.strictObject({}),
      axis: 'configure',
      loosens: () => [],
    });
    expect(await h.files.port('mcp').writeAsCaller(mcpDef, 'Bad Name', 'note: a\n')).toEqual(
      await h.files.port('mcp').write(mcpDef, 'Bad Name', 'note: a\n'),
    );
    expect(await h.files.port('mcp').writeAsCaller(other, undefined, '')).toEqual(
      await h.files.port('mcp').write(other, undefined, ''),
    );
  });

  test('writeAsCaller ifMatch: a stale etag is a conflict, a current one lands, as in write', async () => {
    const h = harness({ owner: true, other: true });
    await h.files.reload();
    const port = h.files.port('mcp');
    const first = await port.writeAsCaller(mcpDef, 'acme', 'note: a\n', { ifMatch: 'absent' });
    expect(first.kind).toBe('written');
    const stale = await port.writeAsCaller(mcpDef, 'acme', 'note: b\n', { ifMatch: 'absent' });
    expect(stale.kind).toBe('conflict');
    const etag = await port.etag(mcpDef, 'acme');
    const current = await port.writeAsCaller(mcpDef, 'acme', ADD, { ifMatch: etag });
    expect(current.kind).toBe('written');
    // the add pinned to a file that has since moved is a conflict, and the reference is not in effect
    const moved = await port.writeAsCaller(mcpDef, 'acme', `${ADD}note: c\n`, { ifMatch: etag });
    expect(moved.kind).toBe('conflict');
  });
});

describe('writeAsCaller: names and ids only in the log, never a value', () => {
  test('writeAsCaller the log names the file and the secret NAME, and holds no value of the edit', async () => {
    const h = harness({ owner: true, other: false });
    await h.files.reload();
    const edit = `env:\n  TOKEN: \${secret:ACME_TOKEN}\nnote: ${FAKE_VALUE}\n`;
    const outcome = await h.files.port('mcp').writeAsCaller(mcpDef, 'acme', edit);
    expect(outcome.kind).toBe('written');
    const said = h.log.lines.filter(line => line.includes('secret reference'));
    expect(said).toEqual(['info config mcp/acme.yaml: the owner put a secret reference into effect (ACME_TOKEN)']);
    expect(JSON.stringify([h.log.lines, outcome, h.asked])).not.toContain(FAKE_VALUE);
  });

  test('writeAsCaller a held add logs no owner-confirmation line, and no value anywhere', async () => {
    const h = harness({ owner: false, other: false });
    await h.files.reload();
    const edit = `env:\n  TOKEN: \${secret:ACME_TOKEN}\nnote: ${FAKE_VALUE}\n`;
    const outcome = await h.files.port('mcp').writeAsCaller(mcpDef, 'acme', edit);
    expect(outcome.kind).toBe('held');
    expect(h.log.lines.some(line => line.includes('the owner put a secret reference'))).toBe(false);
    expect(JSON.stringify([h.log.lines, outcome, h.asked])).not.toContain(FAKE_VALUE);
  });

  test('writeAsCaller a raw secret is refused as write refuses it, and its value is in no line or outcome', async () => {
    const h = harness({ owner: true, other: true });
    await h.files.reload();
    const raw = 'sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKEFAKE';
    const outcome = await h.files.port('mcp').writeAsCaller(mcpDef, 'acme', `env:\n  TOKEN: ${raw}\n`);
    expect(outcome.kind).toBe('refused');
    expect(JSON.stringify([h.log.lines, outcome, h.asked])).not.toContain(raw);
  });
});

describe('writeAsCaller C1: the owner question covers only what the caller’s edit adds to the text it edits', () => {
  const HELD = 'env:\n  EVIL: ${secret:GITHUB_TOKEN}\n';
  const ownerLines = (lines: readonly string[]) => lines.filter(line => line.includes('the owner put a secret'));

  test('writeAsCaller C1 a patch of one field over a held secret reference keeps the whole write held, whatever the owner would say', async () => {
    const h = harness({ owner: true, other: true });
    await h.files.reload();
    const port = h.files.port('mcp');
    expect((await port.write(mcpDef, 'acme', HELD)).kind).toBe('held');
    h.asked.length = 0;
    const outcome = await port.writeAsCaller(mcpDef, 'acme', { patch: { note: 'owner renamed it' } });
    expect(outcome.kind).toBe('held');
    expect(port.collection(mcpDef).get('acme')).toBeUndefined();
    // the owner was never asked about a reference the caller did not add
    expect(h.asked.filter(input => input.secretAdd === true)).toEqual([]);
    expect(ownerLines(h.log.lines)).toEqual([]);
  });

  test('writeAsCaller C1 the owner is asked about its OWN reference only, and a held one still holds the write', async () => {
    const h = harness({ owner: true, other: true });
    await h.files.reload();
    const port = h.files.port('mcp');
    await port.write(mcpDef, 'acme', HELD);
    h.asked.length = 0;
    const outcome = await port.writeAsCaller(mcpDef, 'acme', {
      patch: { env: { EVIL: '${secret:GITHUB_TOKEN}', OWN: '${secret:OWN_TOKEN}' } },
    });
    expect(outcome.kind).toBe('held');
    expect(port.collection(mcpDef).get('acme')).toBeUndefined();
    expect(ownerLines(h.log.lines)).toEqual([]);
  });

  test('writeAsCaller C1 an owner reference on top of a held NON-secret edit is asked alone and credited alone', async () => {
    const staged = harness({ owner: true, other: false });
    await staged.files.reload();
    expect((await staged.files.port('mcp').write(mcpDef, 'acme', 'limit: 99\n')).kind).toBe('held');
    staged.asked.length = 0;
    const outcome = await staged.files
      .port('mcp')
      .writeAsCaller(mcpDef, 'acme', { patch: { env: { OWN: '${secret:OWN_TOKEN}' } } });
    // the secret question was asked with the owner reference alone; the held limit is the plain judge's, as for write
    expect(staged.asked.filter(input => input.secretAdd === true).map(input => input.sentences)).toEqual([
      ['names the secret OWN_TOKEN, which only the owner may add to a configuration'],
    ]);
    expect(outcome.kind).toBe('held');
    expect(ownerLines(staged.log.lines)).toEqual([]);
  });

  test('writeAsCaller C1 the owner adds its own reference on a clean file: asked, written and credited', async () => {
    const h = harness({ owner: true, other: false });
    await h.files.reload();
    const outcome = await h.files
      .port('mcp')
      .writeAsCaller(mcpDef, 'acme', { patch: { env: { OWN: '${secret:OWN_TOKEN}' } } });
    expect(outcome.kind).toBe('written');
    expect(ownerLines(h.log.lines)).toEqual([
      'info config mcp/acme.yaml: the owner put a secret reference into effect (OWN_TOKEN)',
    ]);
  });

  test('writeAsCaller C1 a write whose file cannot be written logs no owner line and leaves no acknowledgement', async () => {
    const h = harness({ owner: true, other: false });
    await h.files.reload();
    h.fs.failNextWrite(new Error('the disk is full'));
    await expect(h.files.port('mcp').writeAsCaller(mcpDef, 'acme', ADD)).rejects.toThrow('the disk is full');
    expect(ownerLines(h.log.lines)).toEqual([]);
    // the file was never written, so a reload finds nothing in effect and nothing held
    await h.files.reload();
    expect(h.files.port('mcp').collection(mcpDef).get('acme')).toBeUndefined();
    expect(h.files.held()).toEqual([]);
  });
});
