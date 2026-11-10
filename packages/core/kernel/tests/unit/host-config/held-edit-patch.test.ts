import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineConfig } from '../../../contract/index.ts';
import { createConfigFiles } from '../../../host/config/service.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';
import { captureLog, HOME, manualClock } from './support.ts';

/**
 * [kernel: config held-edit patch] A PATCH of a file with an edit held for the owner is made to BOTH versions: the one
 * in effect and the held text. The real writer, with a scripted judge: `ferret` answers the plain loosening question
 * (a ferret's staged edit is held), `owner` answers the secret-reference question, and `other` is flipped for the
 * owner's own loosening. Which caller is the owner is Gate's (tested in core/gate, write-as-caller).
 */
const capsDef = defineConfig({
  file: 'caps.yaml',
  schema: z.strictObject({
    capA: z.number().int().default(10),
    capB: z.number().int().default(10),
    note: z.string().optional(),
    env: z.record(z.string(), z.string()).default({}),
  }),
  axis: 'configure',
  loosens: (before, after) =>
    (['capA', 'capB'] as const).flatMap(key =>
      after[key] > (before?.[key] ?? 10) ? [`raises ${key} from ${before?.[key] ?? 10} to ${after[key]}`] : [],
    ),
});

const PATH = `${HOME}/config/caps.yaml`;
const START = 'capA: 5\ncapB: 5\n';
const FERRET_RAISE = 'capA: 50\ncapB: 5\n';
const OWN_REF = '${secret:OWN_TOKEN}';

function harness() {
  const fs = createMemoryHostFs();
  const log = captureLog();
  const verdicts = { other: false, owner: true };
  const asked: { sentences: readonly string[]; secretAdd?: true }[] = [];
  const files = createConfigFiles({
    home: HOME,
    fs,
    clock: manualClock(),
    log,
    binary: 'fy',
    defs: [{ plugin: 'caps', def: capsDef }],
    judge: input => (asked.push(input), input.secretAdd === true ? verdicts.owner : verdicts.other),
  });
  const port = files.port('caps');
  /** Both caps at 5 in effect, then a ferret's plain write raising capA: held (the judge says no). */
  const stage = async (held = FERRET_RAISE) => {
    await files.reload();
    verdicts.other = true;
    expect((await port.write(capsDef, undefined, START)).kind).toBe('written');
    verdicts.other = false;
    expect((await port.write(capsDef, undefined, held)).kind).toBe('held');
    asked.length = 0;
  };
  return { fs, files, port, asked, verdicts, log, stage, disk: () => String(fs.snapshot().get(PATH)) };
}

const ownerLines = (lines: readonly string[]) => lines.filter(line => line.includes('the owner put a secret'));

describe('held-edit patch: an owner patch of one field is made to the version in effect AND the held text', () => {
  test('held-edit patch: field A in effect, the ferret’s held B NOT in effect, held text = held + A and still held', async () => {
    const h = harness();
    await h.stage();
    const outcome = await h.port.writeAsCaller(capsDef, undefined, { patch: { note: 'owner note' } });
    expect(outcome.kind).toBe('written');
    if (outcome.kind === 'written') expect(outcome.stillHeld?.sentences).toEqual(['raises capA from 5 to 50']);
    expect(h.port.file(capsDef)).toEqual({ capA: 5, capB: 5, note: 'owner note', env: {} });
    expect(h.disk()).toContain('capA: 50');
    expect(h.disk()).toContain('note: owner note');
    expect(h.port.fileState(capsDef)).toEqual({
      state: 'held',
      inEffect: true,
      sentences: ['raises capA from 5 to 50'],
    });
    expect(h.files.held().map(edit => edit.path)).toEqual(['caps.yaml']);
    // nothing loosening was asked of the judge: the owner's note loosens nothing
    expect(h.asked).toEqual([]);
  });

  test('held-edit patch: the owner then confirms the held edit and B is in effect WITH the owner’s A change', async () => {
    const h = harness();
    await h.stage();
    await h.port.writeAsCaller(capsDef, undefined, { patch: { note: 'owner note' } });
    const [held] = h.files.held();
    expect(await h.files.confirm(held?.id as string)).toBe(true);
    expect(h.port.file(capsDef)).toEqual({ capA: 50, capB: 5, note: 'owner note', env: {} });
    expect(h.port.fileState(capsDef).state).toBe('valid');
  });

  test('held-edit patch: the owner’s own loosening of A is judged alone; yes puts A into effect, B stays held', async () => {
    const h = harness();
    await h.stage();
    h.verdicts.other = true;
    const outcome = await h.port.writeAsCaller(capsDef, undefined, { patch: { capB: 7 } });
    expect(h.asked.map(input => input.sentences)).toEqual([['raises capB from 5 to 7']]);
    expect(outcome).toMatchObject({ kind: 'written', loosened: ['raises capB from 5 to 7'] });
    expect(h.port.file(capsDef)).toMatchObject({ capA: 5, capB: 7 });
    expect(h.port.fileState(capsDef).state).toBe('held');
    expect(h.disk()).toContain('capA: 50');
  });

  test('held-edit patch: the owner’s loosening the judge refuses waits WITH the held text; nothing in effect changes', async () => {
    const h = harness();
    await h.stage();
    const outcome = await h.port.writeAsCaller(capsDef, undefined, { patch: { capB: 7 } });
    expect(outcome.kind).toBe('held');
    expect(h.port.file(capsDef)).toMatchObject({ capA: 5, capB: 5 });
    expect(h.disk()).toContain('capA: 50');
    expect(h.disk()).toContain('capB: 7');
  });

  test('held-edit patch: the owner saving the held value itself settles the hold', async () => {
    const h = harness();
    await h.stage();
    h.verdicts.other = true;
    const outcome = await h.port.writeAsCaller(capsDef, undefined, { patch: { capA: 50 } });
    expect(outcome.kind).toBe('written');
    expect(h.port.file(capsDef)).toMatchObject({ capA: 50 });
    expect(h.port.fileState(capsDef).state).toBe('valid');
    expect(h.files.held()).toEqual([]);
  });
});

describe('held-edit patch: the whole text is still the writer’s whole text', () => {
  test('held-edit patch: an owner write of the WHOLE file is the owner’s text; the held edit it does not state is gone', async () => {
    const h = harness();
    await h.stage();
    const outcome = await h.port.writeAsCaller(capsDef, undefined, 'capA: 5\ncapB: 4\nnote: whole\n');
    expect(outcome.kind).toBe('written');
    expect(h.disk()).toBe('capA: 5\ncapB: 4\nnote: whole\n');
    expect(h.port.file(capsDef)).toMatchObject({ capA: 5, capB: 4, note: 'whole' });
    expect(h.files.held()).toEqual([]);
  });

  test('held-edit patch: a whole text that restates the held loosening is judged as a loosening, held when refused', async () => {
    const h = harness();
    await h.stage();
    const outcome = await h.port.writeAsCaller(capsDef, undefined, 'capA: 50\ncapB: 5\nnote: whole\n');
    expect(outcome.kind).toBe('held');
    expect(h.port.file(capsDef)).toMatchObject({ capA: 5 });
  });
});

describe('held-edit patch: a held secret reference stays held (the secret rules)', () => {
  const HELD_BOTH = 'capA: 50\ncapB: 5\nenv:\n  EVIL: ${secret:GITHUB_TOKEN}\n';

  test('held-edit patch: a held loosening AND a held secret reference together: the owner’s one field puts neither into effect', async () => {
    const h = harness();
    await h.stage(HELD_BOTH);
    const outcome = await h.port.writeAsCaller(capsDef, undefined, { patch: { note: 'owner note' } });
    expect(outcome.kind).toBe('written');
    expect(h.port.file(capsDef)).toEqual({ capA: 5, capB: 5, note: 'owner note', env: {} });
    expect(h.disk()).toContain('GITHUB_TOKEN');
    expect(h.port.fileState(capsDef).state).toBe('held');
    expect(h.asked.filter(input => input.secretAdd === true)).toEqual([]);
    expect(ownerLines(h.log.lines)).toEqual([]);
  });

  test('held-edit patch: the owner’s patch naming the held reference itself is held whole, whatever the owner would say', async () => {
    const h = harness();
    await h.stage(HELD_BOTH);
    const outcome = await h.port.writeAsCaller(capsDef, undefined, {
      patch: { env: { EVIL: '${secret:GITHUB_TOKEN}', OWN: OWN_REF } },
    });
    expect(outcome.kind).toBe('held');
    expect(h.port.file(capsDef)).toEqual({ capA: 5, capB: 5, env: {} });
    expect(ownerLines(h.log.lines)).toEqual([]);
  });

  test('held-edit patch: the owner’s OWN reference over a held loosening is asked alone, in effect and credited alone', async () => {
    const h = harness();
    await h.stage();
    const outcome = await h.port.writeAsCaller(capsDef, undefined, { patch: { env: { OWN: OWN_REF } } });
    expect(h.asked.filter(input => input.secretAdd === true).map(input => input.sentences)).toEqual([
      ['names the secret OWN_TOKEN, which only the owner may add to a configuration'],
    ]);
    expect(outcome.kind).toBe('written');
    expect(h.port.file(capsDef)).toEqual({ capA: 5, capB: 5, env: { OWN: OWN_REF } });
    expect(h.port.fileState(capsDef).state).toBe('held');
    expect(ownerLines(h.log.lines)).toEqual([
      'info config caps.yaml: the owner put a secret reference into effect (OWN_TOKEN)',
    ]);
  });

  // [held-edit-r1 F1, followups row 60] the owner's credit line names ONLY the references the caller's own patch added.
  test('held-edit patch: the owner’s own Y beside a held X in the SAME top-level key: Y in effect and credited, X never', async () => {
    const h = harness();
    await h.stage('capA: 5\ncapB: 5\nenv:\n  EVIL: ${secret:FAKE_X}\n');
    const outcome = await h.port.writeAsCaller(capsDef, undefined, { patch: { env: { MINE: '${secret:FAKE_Y}' } } });
    expect(outcome.kind).toBe('written');
    expect(JSON.stringify(h.port.file(capsDef))).not.toContain('FAKE_X');
    expect(h.port.file(capsDef)).toEqual({ capA: 5, capB: 5, env: { MINE: '${secret:FAKE_Y}' } });
    expect(ownerLines(h.log.lines)).toEqual([
      'info config caps.yaml: the owner put a secret reference into effect (FAKE_Y)',
    ]);
  });

  test('held-edit patch: the owner’s own Y beside a held X that survives in another key: only Y is credited', async () => {
    const h = harness();
    await h.stage('capA: 5\ncapB: 5\nnote: ${secret:FAKE_X}\n');
    const outcome = await h.port.writeAsCaller(capsDef, undefined, { patch: { env: { MINE: '${secret:FAKE_Y}' } } });
    expect(outcome.kind).toBe('written');
    expect(JSON.stringify(h.port.file(capsDef))).not.toContain('FAKE_X');
    // the held version keeps its X (and gains the patch), and stays held
    expect(h.disk()).toContain('FAKE_X');
    expect(h.disk()).toContain('FAKE_Y');
    expect(h.port.fileState(capsDef).state).toBe('held');
    expect(ownerLines(h.log.lines)).toEqual([
      'info config caps.yaml: the owner put a secret reference into effect (FAKE_Y)',
    ]);
  });

  test('held-edit patch: the owner’s own Y beside a reference already in effect in another key: only Y is credited', async () => {
    const h = harness();
    await h.files.reload();
    h.verdicts.other = true;
    expect((await h.port.write(capsDef, undefined, START)).kind).toBe('written');
    // the owner puts FAKE_OLD into effect, then a ferret's WHOLE text (which does not name it) is held beside it
    expect((await h.port.writeAsCaller(capsDef, undefined, { patch: { note: '${secret:FAKE_OLD}' } })).kind).toBe(
      'written',
    );
    h.verdicts.other = false;
    expect((await h.port.write(capsDef, undefined, FERRET_RAISE)).kind).toBe('held');
    h.log.lines.length = 0;
    const outcome = await h.port.writeAsCaller(capsDef, undefined, { patch: { env: { MINE: '${secret:FAKE_Y}' } } });
    expect(outcome.kind).toBe('written');
    expect(h.port.file(capsDef)).toMatchObject({ note: '${secret:FAKE_OLD}', env: { MINE: '${secret:FAKE_Y}' } });
    expect(ownerLines(h.log.lines)).toEqual([
      'info config caps.yaml: the owner put a secret reference into effect (FAKE_Y)',
    ]);
  });

  // [held-edit-r2 F4, followups row 88] the PLAIN write is not the owner's: it never asks the owner question.
  test('held-edit patch: a PLAIN patch adding its own reference beside a held edit is held, whatever the owner would say, and asks no owner question', async () => {
    for (const other of [false, true]) {
      const h = harness();
      await h.stage();
      h.verdicts.owner = true;
      h.verdicts.other = other;
      const outcome = await h.port.write(capsDef, undefined, { patch: { env: { OWN: OWN_REF } } });
      expect({ other, kind: outcome.kind }).toEqual({ other, kind: 'held' });
      expect(h.port.file(capsDef)).toEqual({ capA: 5, capB: 5, env: {} });
      expect(h.asked.some(input => input.secretAdd === true)).toBe(false);
      expect(ownerLines(h.log.lines)).toEqual([]);
    }
  });

  test('held-edit patch: the owner’s own reference when the owner question says no is held, the held loosening beside it', async () => {
    const h = harness();
    await h.stage();
    h.verdicts.owner = false;
    const outcome = await h.port.writeAsCaller(capsDef, undefined, { patch: { env: { OWN: OWN_REF } } });
    expect(outcome.kind).toBe('held');
    expect(h.port.file(capsDef)).toEqual({ capA: 5, capB: 5, env: {} });
    expect(ownerLines(h.log.lines)).toEqual([]);
  });
});

describe('held-edit patch: what does not change', () => {
  test('held-edit patch: with no edit held, a patch by writeAsCaller is the plain write of that patch', async () => {
    const viaCaller = harness();
    const viaWrite = harness();
    for (const h of [viaCaller, viaWrite]) {
      await h.files.reload();
      h.verdicts.other = true;
      await h.port.write(capsDef, undefined, START);
    }
    const a = await viaCaller.port.writeAsCaller(capsDef, undefined, { patch: { note: 'n', capB: 3 } });
    const b = await viaWrite.port.write(capsDef, undefined, { patch: { note: 'n', capB: 3 } });
    expect(a).toEqual(b);
    expect(viaCaller.disk()).toBe(viaWrite.disk());
  });

  test('held-edit patch: a ferret’s PLAIN non-loosening patch beside a held edit is judged alone, goes into effect, and the held edit stays held', async () => {
    const h = harness();
    await h.stage();
    const outcome = await h.port.write(capsDef, undefined, { patch: { note: 'ferret note' } });
    expect(outcome.kind).toBe('written');
    expect(h.port.file(capsDef)).toEqual({ capA: 5, capB: 5, note: 'ferret note', env: {} });
    expect(h.disk()).toContain('capA: 50');
    expect(h.disk()).toContain('note: ferret note');
    expect(h.port.fileState(capsDef).state).toBe('held');
    expect(h.files.held().map(edit => edit.path)).toEqual(['caps.yaml']);
  });

  test('held-edit patch: a ferret’s PLAIN loosening patch beside a held edit is itself held, nothing goes into effect, the held edit stays held', async () => {
    const h = harness();
    await h.stage();
    const outcome = await h.port.write(capsDef, undefined, { patch: { capB: 40 } });
    expect(outcome.kind).toBe('held');
    expect(h.port.file(capsDef)).toEqual({ capA: 5, capB: 5, env: {} });
    expect(h.port.fileState(capsDef).state).toBe('held');
    expect(h.disk()).toContain('capA: 50');
    expect(h.disk()).toContain('capB: 40');
  });

  test('held-edit patch: a PLAIN patch under a confirming caller (host admin, proved device) never puts the held loosening into effect', async () => {
    const h = harness();
    await h.stage();
    h.verdicts.other = true;
    const outcome = await h.port.write(capsDef, undefined, { patch: { note: 'plain' } });
    expect(outcome.kind).toBe('written');
    expect(h.port.file(capsDef)).toEqual({ capA: 5, capB: 5, note: 'plain', env: {} });
    expect(h.port.fileState(capsDef).state).toBe('held');
    expect(h.disk()).toContain('capA: 50');
  });

  test('held-edit patch: the shared file writer (Gate’s, confirmedLoosening) patching one key never puts a held loosening into effect', async () => {
    const h = harness();
    await h.stage();
    const outcome = await h.files.writer().write(
      { plugin: 'caps', def: capsDef },
      { patch: { note: 'gate owner' } },
      {
        confirmedLoosening: true,
      },
    );
    expect(outcome.kind).toBe('written');
    expect(h.port.file(capsDef)).toEqual({ capA: 5, capB: 5, note: 'gate owner', env: {} });
    expect(h.files.held().map(edit => edit.path)).toEqual(['caps.yaml']);
    expect(h.disk()).toContain('capA: 50');
  });

  test('held-edit patch: a WHOLE text from a plain write replaces the held edit, as for any write', async () => {
    const h = harness();
    await h.stage();
    h.verdicts.other = true;
    const outcome = await h.port.write(capsDef, undefined, 'capA: 6\ncapB: 5\n');
    expect(outcome.kind).toBe('written');
    expect(h.port.file(capsDef)).toMatchObject({ capA: 6, capB: 5 });
    expect(h.files.held()).toEqual([]);
  });

  test('held-edit patch: the etag is the disk’s: the held text’s etag lands the patch, a stale one is a conflict', async () => {
    const h = harness();
    await h.stage();
    const heldEtag = await h.port.etag(capsDef);
    const stale = await h.port.writeAsCaller(capsDef, undefined, { patch: { note: 'x' } }, { ifMatch: 'absent' });
    expect(stale.kind).toBe('conflict');
    expect(h.disk()).not.toContain('note');
    const landed = await h.port.writeAsCaller(capsDef, undefined, { patch: { note: 'x' } }, { ifMatch: heldEtag });
    expect(landed.kind).toBe('written');
    // the answer's etag is the held text's now, so the next edit can pin to it
    if (landed.kind === 'written') expect(landed.etag).toBe(await h.port.etag(capsDef));
    const again = await h.port.writeAsCaller(capsDef, undefined, { patch: { note: 'y' } }, { ifMatch: heldEtag });
    expect(again.kind).toBe('conflict');
    expect(h.port.file(capsDef)).toMatchObject({ note: 'x' });
  });

  test('held-edit patch: a held removal has no text; the patch changes the version in effect and the removal stays held', async () => {
    const h = harness();
    await h.files.reload();
    h.verdicts.other = true;
    await h.port.write(capsDef, undefined, START);
    h.verdicts.other = false;
    await h.port.remove(capsDef, undefined);
    expect(h.port.fileState(capsDef).state).toBe('held');
    const outcome = await h.port.writeAsCaller(capsDef, undefined, { patch: { note: 'n' } });
    expect(outcome.kind).toBe('written');
    expect(h.port.file(capsDef)).toMatchObject({ capA: 5, capB: 5, note: 'n' });
  });
});

/** Fake only: a value past every length and entropy gate, no known shape. */
const FLAG_VALUE = 'Zk3pQ9vXw2LmN7rT';
const FLAG_NOTE = `note: "srv --token ${FLAG_VALUE}"\n`;

describe('held-edit patch: the write rule (CFG-LEAK-W) judges both versions, and never a confirmation', () => {
  test('CFG-LEAK-W a held-file patch that adds one is refused at the version in effect; nothing is written, the edit stays held', async () => {
    const h = harness();
    await h.stage();
    const before = h.disk();
    const outcome = await h.port.writeAsCaller(capsDef, undefined, { patch: { note: `srv --token ${FLAG_VALUE}` } });
    expect(outcome).toMatchObject({ kind: 'refused', reason: 'raw_secret' });
    expect(JSON.stringify(outcome)).not.toContain(FLAG_VALUE);
    expect(h.disk()).toBe(before);
    expect(h.files.held().map(edit => edit.path)).toEqual(['caps.yaml']);
  });

  test('CFG-LEAK-W a held-file patch judges the held version too: a pair only the version in effect holds is new to the held text', async () => {
    const h = harness();
    await h.files.reload();
    // In effect: a file that already holds the pair (hand-written before the rule). Held: a ferret's edit that drops it.
    h.fs.seed(PATH, `${START}${FLAG_NOTE}`);
    await h.files.reload();
    h.verdicts.other = false;
    expect((await h.port.write(capsDef, undefined, FERRET_RAISE)).kind).toBe('held');
    expect(h.port.file(capsDef)).toMatchObject({ note: `srv --token ${FLAG_VALUE}` });
    const before = h.disk();
    // The version in effect already holds the pair, so the patch adds nothing there; the held text has no such pair.
    const outcome = await h.port.writeAsCaller(capsDef, undefined, { patch: { note: `srv --token ${FLAG_VALUE}` } });
    expect(outcome).toMatchObject({ kind: 'refused', reason: 'raw_secret' });
    expect(h.disk()).toBe(before);
    expect(h.files.held().map(edit => edit.path)).toEqual(['caps.yaml']);
  });

  test('CFG-LEAK-W an edit held before the rule that carries one is confirmed unchanged, and a patch of another key of it is applied', async () => {
    const h = harness();
    await h.files.reload();
    h.verdicts.other = true;
    expect((await h.port.write(capsDef, undefined, START)).kind).toBe('written');
    h.verdicts.other = false;
    // Held before the rule shipped: a hand-written loosening that also carries a pair.
    h.fs.seed(PATH, `${FERRET_RAISE}${FLAG_NOTE}`);
    await h.files.reload();
    expect(h.port.fileState(capsDef).state).toBe('held');
    // A patch of another key passes at both versions: the pair is already in the held text, and the version in effect has none.
    const patch = await h.port.writeAsCaller(capsDef, undefined, { patch: { capB: 4 } });
    expect(patch.kind).toBe('written');
    expect(h.disk()).toContain(FLAG_VALUE);
    expect(h.port.fileState(capsDef).state).toBe('held');
    // Confirming puts the held text into effect as it is: confirm is not a write of new text, so the rule does not run.
    const [held] = h.files.held();
    expect(await h.files.confirm(held?.id as string)).toBe(true);
    expect(h.port.file(capsDef)).toMatchObject({ capA: 50, note: `srv --token ${FLAG_VALUE}` });
    expect(h.port.fileState(capsDef).state).toBe('valid');
  });
});
