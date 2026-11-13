import { PERSON_ORIGIN } from '../../../../contract/index.ts';
import { expect, test } from 'bun:test';
import { ok } from '@ferretry/std';
import type { FerretId, FerretsApi } from '../../../../contract/index.ts';
import { ferretsPort } from '../../../../daemon/lib/ferrets/port.ts';
import type { FerretsService } from '../../../../daemon/lib/ferrets/service.ts';

const F1 = 'f1' as FerretId;

/** A service that records what reached it; the port is what is under test, not the service. */
function spy(
  records: Readonly<Record<string, unknown>> = {},
  /** What the session documents say of a parent: its lineage, or an `Error` when they cannot be read. Default: not in it. */
  lineage: Readonly<Record<string, boolean | Error>> = {},
) {
  const reached: { readonly member: string; readonly args: readonly unknown[] }[] = [];
  const asked: string[] = [];
  const note =
    (member: string, answer: unknown) =>
    async (...args: unknown[]) => {
      reached.push({ member, args });
      return answer;
    };
  const service = {
    start: note('start', ok(F1)),
    resume: note('resume', ok(F1)),
    move: note('move', ok({})),
    systemCallsign: note('systemCallsign', 'warden-000001'),
    // The registry read the port makes of a parent: a record, `undefined` (unknown) or a throw (unreadable).
    get: async (id: string) => {
      const record = records[id];
      if (record instanceof Error) throw record;
      return record;
    },
    // The port-only document check: asked only for a parent the registry read shows to be ordinary.
    inWardenLineage: async (id: string) => {
      asked.push(id);
      const answer = lineage[id] ?? false;
      if (answer instanceof Error) throw answer;
      return answer;
    },
  } as unknown as FerretsService;
  return { service, reached, asked, port: (consumer: string): FerretsApi => ferretsPort(service, consumer) };
}

const REFUSED_RESUME = {
  ok: false,
  error: { code: 'refused', reason: 'only the Warden is recorded as the Warden' },
} as const;

test('KCB-S resume actor warden is refused from a non-warden consumer, and nothing is resumed', async () => {
  const w = spy();
  for (const consumer of ['board', 'lessons', 'usage', ''])
    expect(
      await w.port(consumer).resume(F1, 'carry on', { origin: PERSON_ORIGIN, automatic: true, actor: 'warden' }),
    ).toEqual(REFUSED_RESUME);
  expect(w.reached).toEqual([]);
});

test('KCB-S resume actor warden is accepted from the Warden, and a plain resume from anyone', async () => {
  const w = spy();
  expect(
    (await w.port('warden').resume(F1, 'carry on', { origin: PERSON_ORIGIN, automatic: true, actor: 'warden' })).ok,
  ).toBe(true);
  expect((await w.port('board').resume(F1, 'carry on', { origin: PERSON_ORIGIN, automatic: true })).ok).toBe(true);
  expect(w.reached.map(r => [r.member, r.args[2]])).toEqual([
    ['resume', { origin: PERSON_ORIGIN, automatic: true, actor: 'warden' }],
    ['resume', { origin: PERSON_ORIGIN, automatic: true }],
  ]);
});

test('KCB-S resume actor peer is forwarded from any consumer, unbound, while warden from the same consumer is refused', async () => {
  const w = spy();
  for (const consumer of ['board', 'lessons', 'warden'])
    expect((await w.port(consumer).resume(F1, 'carry on', { origin: PERSON_ORIGIN, actor: 'peer' })).ok).toBe(true);
  expect(w.reached.map(r => [r.member, r.args[2]])).toEqual([
    ['resume', { origin: PERSON_ORIGIN, actor: 'peer' }],
    ['resume', { origin: PERSON_ORIGIN, actor: 'peer' }],
    ['resume', { origin: PERSON_ORIGIN, actor: 'peer' }],
  ]);
  w.reached.length = 0;
  expect(await w.port('board').resume(F1, 'carry on', { origin: PERSON_ORIGIN, actor: 'warden' })).toEqual(
    REFUSED_RESUME,
  );
  expect(w.reached).toEqual([]);
});

test('KCB-S a start under the Warden label is refused from a non-warden consumer, and nothing is started', async () => {
  const w = spy();
  const refusal = {
    ok: false,
    error: { code: 'refused', reason: 'only the Warden starts a ferret under its own label' },
  } as const;
  for (const consumer of ['board', 'packs', 'lessons', ''])
    for (const label of ['fleet-warden', '  fleet-warden  '])
      expect(await w.port(consumer).start({ folder: '/work', by: 'owner', options: { label } }, PERSON_ORIGIN)).toEqual(
        refusal,
      );
  expect(w.reached).toEqual([]);

  expect(
    (await w.port('warden').start({ folder: '/work', by: 'owner', options: { label: 'fleet-warden' } }, PERSON_ORIGIN))
      .ok,
  ).toBe(true);
  expect(
    (await w.port('board').start({ folder: '/work', by: 'owner', options: { label: 'my-label' } }, PERSON_ORIGIN)).ok,
  ).toBe(true);
  expect(w.reached).toHaveLength(2);
});

const PARENT_REFUSAL = {
  ok: false,
  error: { code: 'refused', reason: 'only the Warden names a parent in its own tree' },
} as const;

test('J-0057 KCB-S a packs start with an ordinary parent is admitted, and the service gets that parent', async () => {
  const lead = 'lead' as FerretId;
  const w = spy({ lead: { id: lead, label: 'my-lead', provenance: { wardenLineage: false } }, bare: { id: 'bare' } });
  for (const consumer of ['packs', 'board', 'lessons', ''])
    expect((await w.port(consumer).start({ folder: '/work', by: 'ferret', parent: lead }, PERSON_ORIGIN)).ok).toBe(
      true,
    );
  expect(
    (await w.port('packs').start({ folder: '/work', by: 'pack', parent: 'bare' as FerretId }, PERSON_ORIGIN)).ok,
  ).toBe(true);
  expect(w.reached.map(r => (r.args[0] as { parent?: string }).parent)).toEqual([lead, lead, lead, lead, 'bare']);
});

test('KCB-S a start under a Warden-labelled or Warden-lineage parent is refused from a non-warden consumer, and nothing is started', async () => {
  const w = spy({
    labelled: { id: 'labelled', label: 'fleet-warden' },
    padded: { id: 'padded', label: '  fleet-warden  ' },
    stamped: { id: 'stamped', label: 'helper', provenance: { wardenLineage: true } },
  });
  for (const consumer of ['board', 'packs', 'lessons', ''])
    for (const parent of ['labelled', 'padded', 'stamped'] as const)
      expect(
        await w.port(consumer).start({ folder: '/work', by: 'owner', parent: parent as FerretId }, PERSON_ORIGIN),
      ).toEqual(PARENT_REFUSAL);
  expect(w.reached).toEqual([]);

  for (const parent of ['labelled', 'stamped'] as const)
    expect(
      (await w.port('warden').start({ folder: '/work', by: 'owner', parent: parent as FerretId }, PERSON_ORIGIN)).ok,
    ).toBe(true);
  expect(w.reached.map(r => (r.args[0] as { parent?: string }).parent)).toEqual(['labelled', 'stamped']);
});

test('KCB-S a start under a parent that cannot be read is refused from a non-warden consumer (fail closed), and nothing is started', async () => {
  const w = spy({ broken: new Error('registry unavailable') });
  for (const parent of ['broken', 'unknown'] as const)
    expect(
      await w.port('packs').start({ folder: '/work', by: 'pack', parent: parent as FerretId }, PERSON_ORIGIN),
    ).toEqual(PARENT_REFUSAL);
  expect(w.reached).toEqual([]);
});

test('KCB-S B1 a start under a parent the session documents put in the Warden’s lineage is refused from a non-warden consumer, and nothing is started', async () => {
  // The registry summary is ordinary (as production's always is: it does not carry the stamp); the documents say otherwise.
  const w = spy(
    { stamped: { id: 'stamped', label: 'helper' }, plain: { id: 'plain', label: 'my-lead' } },
    { stamped: true },
  );
  for (const consumer of ['board', 'packs', 'lessons', ''])
    expect(
      await w.port(consumer).start({ folder: '/work', by: 'owner', parent: 'stamped' as FerretId }, PERSON_ORIGIN),
    ).toEqual(PARENT_REFUSAL);
  expect(w.reached).toEqual([]);
  expect(w.asked).toEqual(['stamped', 'stamped', 'stamped', 'stamped']);

  // The Warden asks nobody and starts; an ordinary parent is admitted after the same check says no.
  w.asked.length = 0;
  expect(
    (await w.port('warden').start({ folder: '/work', by: 'owner', parent: 'stamped' as FerretId }, PERSON_ORIGIN)).ok,
  ).toBe(true);
  expect(w.asked).toEqual([]);
  expect(
    (await w.port('packs').start({ folder: '/work', by: 'pack', parent: 'plain' as FerretId }, PERSON_ORIGIN)).ok,
  ).toBe(true);
  expect(w.asked).toEqual(['plain']);
});

test('KCB-S B1 a start under a parent whose session documents cannot be read is refused from a non-warden consumer (fail closed), and nothing is started', async () => {
  const w = spy({ torn: { id: 'torn', label: 'helper' } }, { torn: new Error('damaged ancestor') });
  expect(
    await w.port('packs').start({ folder: '/work', by: 'pack', parent: 'torn' as FerretId }, PERSON_ORIGIN),
  ).toEqual(PARENT_REFUSAL);
  expect(w.reached).toEqual([]);
  expect(w.asked).toEqual(['torn']);
});

test('KCB-S a start and a move forward a rebuilt copy, so a getter cannot answer the check and the service differently', async () => {
  const w = spy();
  let reads = 0;
  const label = () => (++reads === 1 ? 'my-label' : 'fleet-warden');
  const options = {
    get label() {
      return label();
    },
  };
  const asked = { folder: '/work', by: 'owner' as const, options };
  expect((await w.port('board').start(asked, PERSON_ORIGIN)).ok).toBe(true);
  const sent = w.reached[0]!.args[0] as { options: { label: string } };
  expect(sent).not.toBe(asked);
  expect(sent.options).not.toBe(options);
  expect(sent.options.label).toBe('my-label');
  expect(sent.options.label).toBe('my-label');

  let moveReads = 0;
  const moveOptions = {
    origin: PERSON_ORIGIN,
    get movedBy() {
      return ++moveReads === 1 ? 'owner' : 'warden';
    },
  };
  expect((await w.port('board').move!(F1, 'codex-two', moveOptions)).ok).toBe(true);
  const moved = w.reached[1]!.args[2] as { movedBy: string };
  expect(moved).not.toBe(moveOptions);
  expect(moved.movedBy).toBe('owner');
  expect(moved.movedBy).toBe('owner');
});

test('KCB-S a start reads options once, so a getter on options itself cannot answer the check and the service differently', async () => {
  const w = spy();
  // Answers its first object once, then a different one: a second read would see the Warden's label (or nothing).
  const first = { label: 'my-label' };
  let reads = 0;
  const asked = {
    folder: '/work',
    by: 'owner' as const,
    get options() {
      return ++reads === 1 ? first : { label: 'fleet-warden' };
    },
  };
  expect((await w.port('board').start(asked, PERSON_ORIGIN)).ok).toBe(true);
  const sent = w.reached[0]!.args[0] as { options: { label: string } };
  expect(reads).toBe(1);
  expect(sent.options).not.toBe(first);
  expect(sent.options.label).toBe('my-label');

  // First answer an object, then undefined: the forwarded options are still a copy of the first, never the caller's own.
  let reads2 = 0;
  const vanishing = {
    folder: '/work',
    by: 'owner' as const,
    get options() {
      return ++reads2 === 1 ? first : undefined;
    },
  };
  expect((await w.port('board').start(vanishing, PERSON_ORIGIN)).ok).toBe(true);
  const sent2 = w.reached[1]!.args[0] as { options: { label: string } };
  expect(reads2).toBe(1);
  expect(sent2.options).not.toBe(first);
  expect(sent2.options).toEqual(first);
});

test('KCB-S move actor warden and movedBy warden are refused from a non-warden consumer, and nothing is moved', async () => {
  const w = spy();
  const board = w.port('board');
  const answers = [
    await board.move!(F1, 'codex-two', { origin: PERSON_ORIGIN, actor: 'warden' }),
    await board.move!(F1, 'codex-two', { origin: PERSON_ORIGIN, movedBy: 'warden' }),
    await board.move!(F1, 'codex-two', { origin: PERSON_ORIGIN, actor: 'warden', movedBy: 'warden', note: 'x' }),
  ];
  for (const answer of answers) expect(answer).toEqual(REFUSED_RESUME);
  expect(w.reached).toEqual([]);
});

test('KCB-S move by the Warden reaches the service, and another consumer’s own attribution (owner, session) still does', async () => {
  const w = spy();
  await w.port('warden').move!(F1, 'codex-two', { origin: PERSON_ORIGIN, actor: 'warden', movedBy: 'warden' });
  await w.port('board').move!(F1, 'codex-two', { origin: PERSON_ORIGIN, movedBy: 'session:lead' });
  await w.port('board').move!(F1, 'codex-two', { origin: PERSON_ORIGIN });
  expect(w.reached.map(r => r.member)).toEqual(['move', 'move', 'move']);
});

test('KCB-S2 F2 (row 17) a move names who moved it only as owner, session:<ferret id> or warden; any other spelling is refused, nothing is moved', async () => {
  const w = spy();
  const odd = [
    'Warden',
    'warden ',
    ' owner',
    'OWNER',
    'session:',
    'session: f1',
    'session:a/b',
    'session:f1 x',
    'x',
    '',
  ];
  for (const consumer of ['board', 'warden'])
    for (const movedBy of odd)
      expect(await w.port(consumer).move!(F1, 'codex-two', { origin: PERSON_ORIGIN, movedBy })).toEqual({
        ok: false,
        error: { code: 'refused', reason: 'a move names who moved it as owner, session:<ferret id> or warden' },
      });
  expect(w.reached).toEqual([]);

  // A caller that casts past `movedBy?: string` gets the same fixed refusal, never a throw and never a pass.
  const cast = [42, { startsWith: () => true, slice: () => 'abc' }, new String('owner')];
  for (const consumer of ['board', 'warden'])
    for (const movedBy of cast)
      expect(
        await w.port(consumer).move!(F1, 'codex-two', { origin: PERSON_ORIGIN, movedBy: movedBy as unknown as string }),
      ).toEqual({
        ok: false,
        error: { code: 'refused', reason: 'a move names who moved it as owner, session:<ferret id> or warden' },
      });
  expect(w.reached).toEqual([]);

  // The three spellings go through; 'warden' only from the Warden (unchanged).
  expect((await w.port('board').move!(F1, 'codex-two', { origin: PERSON_ORIGIN, movedBy: 'owner' })).ok).toBe(true);
  expect(
    (await w.port('board').move!(F1, 'codex-two', { origin: PERSON_ORIGIN, movedBy: 'session:mw7bp88g-50e00159' })).ok,
  ).toBe(true);
  expect((await w.port('warden').move!(F1, 'codex-two', { origin: PERSON_ORIGIN, movedBy: 'warden' })).ok).toBe(true);
  expect(w.reached.map(r => (r.args[2] as { movedBy: string }).movedBy)).toEqual([
    'owner',
    'session:mw7bp88g-50e00159',
    'warden',
  ]);
});

test('KCB-S3 F3 (row 18) the refusal of a callsign prefix does not quote the prefix the caller supplied', async () => {
  const w = spy();
  const hostile = 'SECRET-looking <b>text' as unknown as 'warden';
  const error = await w.port('board').systemCallsign!(hostile).then(
    () => undefined,
    (thrown: unknown) => thrown as Error,
  );
  expect(error).toMatchObject({ status: 403, code: 'forbidden' });
  expect(error?.message).not.toContain('SECRET');
  expect(error?.message).toBe('the board plugin may not draw that kind of callsign');
});

test('ci-lane-s F1 (row 55) a start through the port as a non-warden consumer is admitted as outside the Warden’s tree, and the Warden’s own start is not', async () => {
  const w = spy({ lead: { id: 'lead', label: 'my-lead' } });
  const ordinary = { folder: '/work', by: 'ferret' as const, parent: 'lead' as FerretId };
  for (const consumer of ['packs', 'board', 'lessons', '']) {
    w.reached.length = 0;
    expect((await w.port(consumer).start(ordinary, PERSON_ORIGIN)).ok).toBe(true);
    // the start is also admitted as such when it names no parent (a label alone could mark the tree)
    expect((await w.port(consumer).start({ folder: '/work', by: 'owner' }, PERSON_ORIGIN)).ok).toBe(true);
    expect(w.reached.map(r => r.args[2])).toEqual([{ notInWardenTree: true }, { notInWardenTree: true }]);
    expect(w.reached.map(r => r.args[1])).toEqual([PERSON_ORIGIN, PERSON_ORIGIN]);
  }
  w.reached.length = 0;
  expect((await w.port('warden').start(ordinary, PERSON_ORIGIN)).ok).toBe(true);
  expect(w.reached.map(r => r.args[2])).toEqual([undefined]);
});

test('KCB-S systemCallsign draws only the prefix of the consumer’s own kind', async () => {
  const w = spy();
  expect(await w.port('warden').systemCallsign!('warden')).toBe('warden-000001');
  expect(await w.port('lessons').systemCallsign!('learning')).toBe('warden-000001');
  expect(await w.port('packs').systemCallsign!('pack')).toBe('warden-000001');
  expect(w.reached).toHaveLength(3);
  w.reached.length = 0;

  const crossed: readonly (readonly [string, 'warden' | 'learning' | 'pack'])[] = [
    ['warden', 'learning'],
    ['warden', 'pack'],
    ['lessons', 'warden'],
    ['lessons', 'pack'],
    ['packs', 'warden'],
    ['packs', 'learning'],
    ['board', 'warden'],
    ['board', 'learning'],
    ['board', 'pack'],
  ];
  for (const [consumer, prefix] of crossed)
    await expect(w.port(consumer).systemCallsign!(prefix)).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  expect(w.reached).toEqual([]);
});

test('KCB-S a start by warden, pack or board is accepted only from that plugin; owner and ferret from any', async () => {
  const w = spy();
  const request = (by: 'owner' | 'ferret' | 'pack' | 'board' | 'warden') => ({ folder: '/work', by });

  const bound = [
    ['warden', 'warden'],
    ['packs', 'pack'],
    ['board', 'board'],
  ] as const;
  for (const [plugin, by] of bound) {
    expect((await w.port(plugin).start(request(by), PERSON_ORIGIN)).ok).toBe(true);
    for (const other of ['board', 'packs', 'warden', 'lessons'].filter(id => id !== plugin))
      expect(await w.port(other).start(request(by), PERSON_ORIGIN)).toMatchObject({
        ok: false,
        error: { code: 'refused' },
      });
  }
  expect(w.reached).toHaveLength(bound.length);
  w.reached.length = 0;

  for (const consumer of ['board', 'lessons', 'warden'])
    for (const by of ['owner', 'ferret'] as const)
      expect((await w.port(consumer).start(request(by), PERSON_ORIGIN)).ok).toBe(true);
  expect(w.reached).toHaveLength(6);
});
