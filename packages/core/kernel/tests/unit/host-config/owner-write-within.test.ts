import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineConfig } from '../../../contract/index.ts';
import { createConfigFiles } from '../../../host/config/service.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';
import { captureLog, HOME, manualClock } from './support.ts';

/**
 * `ConfigPort.writeAsOwner(..., { patch, within })`: a top-level mapping named in `within` merges one level deep in
 * BOTH versions, so a section saved beside a held edit keeps the held version's own sub-keys (the 2026-10-29 price
 * incident: a save of the daily caps put a held price correction, $2 → $0.042, back to $2).
 */
const caps = z
  .strictObject({ daily: z.number().default(10), price: z.number().default(2), weekly: z.number().optional() })
  .refine(value => value.weekly === undefined || value.daily <= value.weekly, 'the daily cap is above the weekly one');
const DEFAULTS = { enabled: true, caps: { daily: 10, price: 2 }, guard: { level: 'high' as const } };
const wardenDef = defineConfig({
  file: 'warden.yaml',
  schema: z.strictObject({
    enabled: z.boolean().default(true),
    caps: caps.default(DEFAULTS.caps),
    guard: z.strictObject({ level: z.enum(['low', 'high']).default('high') }).default(DEFAULTS.guard),
    note: z.string().optional(),
  }),
  axis: 'configure',
  // Never a value in a sentence: what widened, by name.
  loosens: (before, after) => {
    const was = before ?? DEFAULTS;
    return [
      ...(after.caps.daily > was.caps.daily ? ['raises the daily cap'] : []),
      ...(after.caps.price < was.caps.price ? ['lowers the price per minute'] : []),
      ...(after.guard.level === 'low' && was.guard.level === 'high' ? ['lowers the guard'] : []),
    ];
  },
});

const PATH = `${HOME}/config/warden.yaml`;
/** The line every written file starts with (the kernel adds it on a patch). */
const MODELINE = '# yaml-language-server: $schema=.schema/warden.json\n\n';
const IN_EFFECT = '# the owner’s caps\nenabled: true\ncaps:\n  daily: 5 # per day\n  price: 2\n';
/** The 2026-10-29 shape: a hand-made price correction (a loosening: a lower price spends sooner) waits for the owner. */
const HELD_PRICE = '# the owner’s caps\nenabled: true\ncaps:\n  daily: 5 # per day\n  price: 0.042\n';

function harness(verdict = true) {
  const fs = createMemoryHostFs();
  const log = captureLog();
  const asked: { plugin: string; path: string; removal: boolean; sentences: readonly string[] }[] = [];
  const files = createConfigFiles({
    home: HOME,
    fs,
    clock: manualClock(),
    log,
    binary: 'fy',
    defs: [{ plugin: 'warden', def: wardenDef }],
    judge: input => (asked.push(input), verdict),
  });
  const port = files.port('warden');
  const disk = () => String(fs.snapshot().get(PATH));
  /** Daily 5, price 2, in effect (the owner's own first write, so nothing is held). */
  const start = async (text = IN_EFFECT) => {
    await files.reload();
    expect((await port.write(wardenDef, undefined, text)).kind).toBe('written');
    asked.length = 0;
  };
  /** The price correction, edited by hand on the disk, held for the owner. */
  const holdPrice = async (text = HELD_PRICE) => {
    fs.seed(PATH, text);
    await files.reload();
    expect(port.fileState(wardenDef)).toEqual({
      state: 'held',
      inEffect: true,
      sentences: ['lowers the price per minute'],
    });
  };
  return { fs, log, files, port, asked, start, holdPrice, disk };
}

describe('writeAsOwner within: the price-incident shape (a section saved beside a held edit)', () => {
  test('a caps save keeps the held price: in effect at once, the held version keeps its own sub-key and stays held', async () => {
    const h = harness();
    await h.start();
    await h.holdPrice();
    const outcome = await h.port.writeAsOwner(wardenDef, undefined, {
      patch: { caps: { daily: 3 } },
      within: ['caps'],
    });
    expect(outcome).toMatchObject({
      kind: 'written',
      loosened: [],
      stillHeld: { sentences: ['lowers the price per minute'] },
    });
    // the version in effect: the owner's tightening, the price as confirmed
    expect(h.port.file(wardenDef)).toEqual({ ...DEFAULTS, caps: { daily: 3, price: 2 } });
    // the held version: the owner's change made to it too, the held price kept, comments kept
    expect(h.disk()).toBe(
      `${MODELINE}# the owner’s caps\nenabled: true\ncaps:\n  daily: 3 # per day\n  price: 0.042\n`,
    );
    expect(h.port.fileState(wardenDef).state).toBe('held');
    // a tightening never asks the judge
    expect(h.asked).toEqual([]);
    // confirming the held edit later puts BOTH into effect
    const held = h.files.held();
    expect(held).toHaveLength(1);
    expect(await h.files.confirm(held[0]?.id as string)).toBe(true);
    expect(h.port.file(wardenDef)).toEqual({ ...DEFAULTS, caps: { daily: 3, price: 0.042 } });
  });

  test('without within the same save replaces the section and the held price is lost (why within exists)', async () => {
    const h = harness();
    await h.start();
    await h.holdPrice();
    const outcome = await h.port.writeAsOwner(wardenDef, undefined, { patch: { caps: { daily: 3 } } });
    expect(outcome.kind).toBe('written');
    expect(h.disk()).not.toContain('0.042');
    expect(h.port.fileState(wardenDef).state).toBe('valid');
  });

  test('both versions merge, each into ITS OWN mapping: a sub-key only one version has is kept in that one', async () => {
    const h = harness();
    // in effect: a price of 3 the held version does not have; held: a price of 0.042 and a weekly cap
    await h.start('enabled: true\ncaps:\n  daily: 5\n  price: 3\n');
    await h.holdPrice('enabled: true\ncaps:\n  daily: 5\n  price: 0.042\n  weekly: 40\n');
    const outcome = await h.port.writeAsOwner(wardenDef, undefined, {
      patch: { caps: { daily: 4 }, enabled: false },
      within: ['caps'],
    });
    expect(outcome).toMatchObject({ kind: 'written', loosened: [] });
    expect(h.asked).toEqual([]);
    expect(h.port.file(wardenDef)).toEqual({ enabled: false, caps: { daily: 4, price: 3 }, guard: DEFAULTS.guard });
    expect(h.disk()).toBe(`${MODELINE}enabled: false\ncaps:\n  daily: 4\n  price: 0.042\n  weekly: 40\n`);
  });

  test('an `undefined` sub-key removes it from BOTH versions, and the held sub-keys stay', async () => {
    const h = harness();
    await h.start();
    await h.holdPrice('enabled: true\ncaps:\n  daily: 5\n  price: 0.042\n  weekly: 40\n');
    // in effect has no weekly: removing it there is a no-op, removing it from the held version is the owner's act
    const outcome = await h.port.writeAsOwner(wardenDef, undefined, {
      patch: { caps: { weekly: undefined } },
      within: ['caps'],
    });
    expect(outcome.kind).toBe('written');
    expect(h.disk()).toBe(`${MODELINE}enabled: true\ncaps:\n  daily: 5\n  price: 0.042\n`);
    expect(h.port.fileState(wardenDef).state).toBe('held');
  });
});

describe('writeAsOwner within: the judge, the loosening hold and the owner checks see the MERGED result', () => {
  test('the judge is asked ONLY about the owner’s own sub-key change, never the held price that rode along', async () => {
    const h = harness(true);
    await h.start();
    await h.holdPrice();
    const outcome = await h.port.writeAsOwner(wardenDef, undefined, {
      patch: { caps: { daily: 8 } },
      within: ['caps'],
    });
    expect(h.asked).toEqual([
      { plugin: 'warden', path: 'warden.yaml', removal: false, sentences: ['raises the daily cap'] },
    ]);
    expect(outcome).toMatchObject({ kind: 'written', loosened: ['raises the daily cap'] });
    expect(h.port.file(wardenDef)).toEqual({ ...DEFAULTS, caps: { daily: 8, price: 2 } });
    expect(h.port.fileState(wardenDef).state).toBe('held');
    expect(h.disk()).toContain('price: 0.042');
  });

  test('when the judge holds the owner’s loosening, the version in effect is untouched and both sub-keys wait', async () => {
    const h = harness(false);
    await h.start();
    await h.holdPrice();
    const outcome = await h.port.writeAsOwner(wardenDef, undefined, {
      patch: { caps: { daily: 8 } },
      within: ['caps'],
    });
    expect(outcome.kind).toBe('held');
    if (outcome.kind === 'held')
      expect(outcome.sentences.toSorted()).toEqual(['lowers the price per minute', 'raises the daily cap']);
    expect(h.port.file(wardenDef)).toEqual({ ...DEFAULTS, caps: { daily: 5, price: 2 } });
    expect(h.disk()).toContain('daily: 8');
    expect(h.disk()).toContain('price: 0.042');
    expect(h.asked).toHaveLength(1);
  });

  test('a merge is no way around a held loosening: the owner’s merged sub-key that loosens is judged and held', async () => {
    const h = harness(false);
    await h.start();
    await h.holdPrice();
    const outcome = await h.port.writeAsOwner(wardenDef, undefined, {
      patch: { caps: { price: 0.042 } },
      within: ['caps'],
    });
    expect(outcome.kind).toBe('held');
    expect(h.asked.map(item => item.sentences)).toEqual([['lowers the price per minute']]);
    expect(h.port.file(wardenDef)).toEqual({ ...DEFAULTS, caps: { daily: 5, price: 2 } });
  });

  test('with no edit held it is a write of the merged patch: sub-keys kept, comments kept, a loosening held', async () => {
    const h = harness(false);
    await h.start();
    const tightened = await h.port.writeAsOwner(wardenDef, undefined, {
      patch: { caps: { daily: 3 } },
      within: ['caps'],
    });
    expect(tightened.kind).toBe('written');
    expect(h.disk()).toBe(`${MODELINE}# the owner’s caps\nenabled: true\ncaps:\n  daily: 3 # per day\n  price: 2\n`);
    const loosened = await h.port.writeAsOwner(wardenDef, undefined, {
      patch: { caps: { price: 1 } },
      within: ['caps'],
    });
    expect(loosened.kind).toBe('held');
    expect(h.asked.map(item => item.sentences)).toEqual([['lowers the price per minute']]);
    expect(h.port.file(wardenDef)).toEqual({ ...DEFAULTS, caps: { daily: 3, price: 2 } });
    expect(h.disk()).toBe(`${MODELINE}# the owner’s caps\nenabled: true\ncaps:\n  daily: 3 # per day\n  price: 1\n`);
  });

  test('a plain write never merges, even handed a within: only the owner’s writeAsOwner reaches inside a section', async () => {
    const h = harness();
    await h.start();
    const edit = { patch: { caps: { daily: 3 } }, within: ['caps'] };
    expect((await h.port.write(wardenDef, undefined, edit)).kind).toBe('written');
    expect(h.disk()).not.toContain('price');
  });
});

describe('writeAsOwner within: refused whole, nothing written, no value in any answer or log', () => {
  /** Everything a refusal must leave as it was: the disk, the version in effect and the held edit. */
  const unchanged = (h: ReturnType<typeof harness>) => {
    const before = { disk: h.disk(), inEffect: h.port.file(wardenDef), held: h.files.held() };
    return () => {
      expect(h.disk()).toBe(before.disk);
      expect(h.port.file(wardenDef)).toEqual(before.inEffect);
      expect(h.files.held()).toEqual(before.held);
    };
  };

  test('a merged section the schema refuses (an unknown sub-key, a wrong type) writes neither version', async () => {
    const h = harness();
    await h.start();
    await h.holdPrice();
    const same = unchanged(h);
    const unknown = await h.port.writeAsOwner(wardenDef, undefined, {
      patch: { caps: { extra: 1 } },
      within: ['caps'],
    });
    expect(unknown).toMatchObject({ kind: 'refused', reason: 'schema' });
    same();
    const sentinel = 'SENTINEL-not-a-number-7f3a';
    const wrong = await h.port.writeAsOwner(wardenDef, undefined, {
      patch: { caps: { daily: sentinel } },
      within: ['caps'],
    });
    expect(wrong).toMatchObject({ kind: 'refused', reason: 'schema' });
    expect(JSON.stringify(wrong)).not.toContain(sentinel);
    expect(h.log.lines.join('\n')).not.toContain(sentinel);
    same();
  });

  test('a merge that is valid in effect but invalid in the HELD version is refused whole: all or none', async () => {
    const h = harness();
    await h.start();
    // the held version has a weekly cap of 4 the version in effect does not
    await h.holdPrice('enabled: true\ncaps:\n  daily: 3\n  price: 0.042\n  weekly: 4\n');
    const same = unchanged(h);
    // daily 4.5 is fine in effect (no weekly there) and above the held version's weekly cap
    const outcome = await h.port.writeAsOwner(wardenDef, undefined, {
      patch: { caps: { daily: 4.5 } },
      within: ['caps'],
    });
    expect(outcome).toMatchObject({ kind: 'refused', reason: 'schema' });
    same();
  });

  test('a raw secret inside a merged section is refused, and its value is in no answer and no log', async () => {
    const h = harness();
    await h.start();
    await h.holdPrice();
    const same = unchanged(h);
    const secret = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const outcome = await h.port.writeAsOwner(wardenDef, undefined, {
      patch: { caps: { daily: 1 }, note: secret },
      within: ['caps'],
    });
    expect(outcome.kind).toBe('refused');
    expect(JSON.stringify(outcome)).not.toContain(secret);
    expect(h.log.lines.join('\n')).not.toContain(secret);
    same();
  });

  test('a disk that moved since the last reload is a conflict, merged or not', async () => {
    const h = harness();
    await h.start();
    await h.holdPrice();
    h.fs.seed(PATH, 'enabled: true\ncaps:\n  daily: 9\n  price: 0.042\n');
    expect(
      await h.port.writeAsOwner(wardenDef, undefined, { patch: { caps: { daily: 1 } }, within: ['caps'] }),
    ).toEqual({ kind: 'conflict' });
    expect(h.disk()).toBe('enabled: true\ncaps:\n  daily: 9\n  price: 0.042\n');
  });
});

describe('writeAsOwner within: a merge writes no schema default into a section the file lacks', () => {
  const NO_CAPS = 'enabled: true\n';

  test('with no edit held: a save into an absent section is what a plain write of the same patch makes', async () => {
    const merged = harness();
    const plain = harness();
    await merged.start(NO_CAPS);
    await plain.start(NO_CAPS);
    const patch = { caps: { daily: 3 } };
    expect((await merged.port.writeAsOwner(wardenDef, undefined, { patch, within: ['caps'] })).kind).toBe('written');
    expect((await plain.port.write(wardenDef, undefined, { patch })).kind).toBe('written');
    expect(merged.disk()).toBe(plain.disk());
    expect(merged.disk()).not.toContain('price');
    expect(merged.port.file(wardenDef)?.caps).toEqual({ daily: 3, price: 2 });
  });

  test('with an edit held, BOTH versions: neither gets a default written into the section it lacks', async () => {
    const h = harness();
    await h.start(NO_CAPS);
    // the held version lowers the guard; neither version has a caps section
    h.fs.seed(PATH, 'enabled: true\nguard:\n  level: low\n');
    await h.files.reload();
    expect(h.port.fileState(wardenDef)).toMatchObject({ state: 'held', sentences: ['lowers the guard'] });
    const outcome = await h.port.writeAsOwner(wardenDef, undefined, {
      patch: { caps: { weekly: 20 } },
      within: ['caps'],
    });
    expect(outcome.kind).toBe('written');
    // the held version (the disk) gained the patch's sub-key only: no default price, no default daily
    expect(h.disk()).toContain('weekly: 20');
    expect(h.disk()).not.toContain('price');
    expect(h.disk()).not.toContain('daily');
    // the version in effect reads as the schema's defaults plus the sub-key
    expect(h.port.file(wardenDef)?.caps).toEqual({ daily: 10, price: 2, weekly: 20 });
  });
});

describe('writeAsOwner within: a `within` that is not a list is refused whole, never read as its letters', () => {
  test('a string `within` refuses and writes nothing, with or without an edit held', async () => {
    for (const held of [false, true]) {
      const h = harness();
      await h.start();
      if (held) await h.holdPrice();
      const before = { disk: h.disk(), inEffect: h.port.file(wardenDef), held: h.files.held() };
      const outcome = await h.port.writeAsOwner(wardenDef, undefined, {
        patch: { caps: { daily: 3 } },
        within: 'caps' as unknown as readonly string[],
      });
      expect(outcome).toMatchObject({ kind: 'refused', reason: 'schema' });
      expect(h.disk()).toBe(before.disk);
      expect(h.port.file(wardenDef)).toEqual(before.inEffect);
      expect(h.files.held()).toEqual(before.held);
    }
  });
});

describe('writeAsOwner without within: byte-identical to before (golden)', () => {
  test('with an edit held: both versions are exactly what the plain patch made of them', async () => {
    const h = harness();
    await h.start();
    await h.holdPrice();
    const outcome = await h.port.writeAsOwner(wardenDef, undefined, {
      patch: { caps: { daily: 3, price: 2 }, enabled: false },
    });
    expect(outcome.kind).toBe('written');
    expect(h.disk()).toBe(`${MODELINE}# the owner’s caps\nenabled: false\ncaps:\n  daily: 3 # per day\n  price: 2\n`);
    expect(h.port.file(wardenDef)).toEqual({ enabled: false, caps: { daily: 3, price: 2 }, guard: DEFAULTS.guard });
    // the whole section replaced the held version's too, as a plain patch always has: nothing is held any more
    expect(h.port.fileState(wardenDef).state).toBe('valid');
  });

  test('with no edit held: the same text a plain write of the same patch makes', async () => {
    const owner = harness();
    const plain = harness();
    await owner.start();
    await plain.start();
    const patch = { caps: { daily: 3 }, guard: { level: 'high' }, enabled: undefined };
    expect((await owner.port.writeAsOwner(wardenDef, undefined, { patch })).kind).toBe('written');
    expect((await plain.port.write(wardenDef, undefined, { patch })).kind).toBe('written');
    expect(owner.disk()).toBe(plain.disk());
    expect(owner.disk()).toBe(`${MODELINE}caps:\n  daily: 3 # per day\n`);
  });
});
