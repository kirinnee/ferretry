import { expect, test } from 'bun:test';
import { ok } from '@ferretry/std';
import type { FerretId, FerretsApi } from '../../../../contract/index.ts';
import { ferretsPort } from '../../../../daemon/lib/ferrets/port.ts';
import type { FerretsService } from '../../../../daemon/lib/ferrets/service.ts';

const F1 = 'f1' as FerretId;

/** A service that records what reached it; the port is what is under test, not the service. */
function spy() {
  const reached: { readonly member: string; readonly args: readonly unknown[] }[] = [];
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
  } as unknown as FerretsService;
  return { service, reached, port: (consumer: string): FerretsApi => ferretsPort(service, consumer) };
}

const REFUSED_RESUME = {
  ok: false,
  error: { code: 'refused', reason: 'only the Warden is recorded as the Warden' },
} as const;

test('KCB-S resume actor warden is refused from a non-warden consumer, and nothing is resumed', async () => {
  const w = spy();
  for (const consumer of ['board', 'lessons', 'usage', ''])
    expect(await w.port(consumer).resume(F1, 'carry on', { automatic: true, actor: 'warden' })).toEqual(REFUSED_RESUME);
  expect(w.reached).toEqual([]);
});

test('KCB-S resume actor warden is accepted from the Warden, and a plain resume from anyone', async () => {
  const w = spy();
  expect((await w.port('warden').resume(F1, 'carry on', { automatic: true, actor: 'warden' })).ok).toBe(true);
  expect((await w.port('board').resume(F1, 'carry on', { automatic: true })).ok).toBe(true);
  expect(w.reached.map(r => [r.member, r.args[2]])).toEqual([
    ['resume', { automatic: true, actor: 'warden' }],
    ['resume', { automatic: true }],
  ]);
});

test('KCB-S resume actor peer is forwarded from any consumer, unbound, while warden from the same consumer is refused', async () => {
  const w = spy();
  for (const consumer of ['board', 'lessons', 'warden'])
    expect((await w.port(consumer).resume(F1, 'carry on', { actor: 'peer' })).ok).toBe(true);
  expect(w.reached.map(r => [r.member, r.args[2]])).toEqual([
    ['resume', { actor: 'peer' }],
    ['resume', { actor: 'peer' }],
    ['resume', { actor: 'peer' }],
  ]);
  w.reached.length = 0;
  expect(await w.port('board').resume(F1, 'carry on', { actor: 'warden' })).toEqual(REFUSED_RESUME);
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
      expect(await w.port(consumer).start({ folder: '/work', by: 'owner', options: { label } })).toEqual(refusal);
  expect(w.reached).toEqual([]);

  expect((await w.port('warden').start({ folder: '/work', by: 'owner', options: { label: 'fleet-warden' } })).ok).toBe(
    true,
  );
  expect((await w.port('board').start({ folder: '/work', by: 'owner', options: { label: 'my-label' } })).ok).toBe(true);
  expect(w.reached).toHaveLength(2);
});

test('KCB-S a start naming a parent is refused from a non-warden consumer, and nothing is started', async () => {
  const w = spy();
  const refusal = {
    ok: false,
    error: { code: 'refused', reason: 'only the Warden names a parent for a ferret it starts' },
  } as const;
  const parent = 'warden-tree-ferret' as FerretId;
  for (const consumer of ['board', 'packs', 'lessons', ''])
    expect(await w.port(consumer).start({ folder: '/work', by: 'owner', parent })).toEqual(refusal);
  expect(w.reached).toEqual([]);

  expect((await w.port('warden').start({ folder: '/work', by: 'owner', parent })).ok).toBe(true);
  expect(w.reached.map(r => [r.member, (r.args[0] as { parent?: string }).parent])).toEqual([['start', parent]]);
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
  expect((await w.port('board').start(asked)).ok).toBe(true);
  const sent = w.reached[0]!.args[0] as { options: { label: string } };
  expect(sent).not.toBe(asked);
  expect(sent.options).not.toBe(options);
  expect(sent.options.label).toBe('my-label');
  expect(sent.options.label).toBe('my-label');

  let moveReads = 0;
  const moveOptions = {
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
  expect((await w.port('board').start(asked)).ok).toBe(true);
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
  expect((await w.port('board').start(vanishing)).ok).toBe(true);
  const sent2 = w.reached[1]!.args[0] as { options: { label: string } };
  expect(reads2).toBe(1);
  expect(sent2.options).not.toBe(first);
  expect(sent2.options).toEqual(first);
});

test('KCB-S move actor warden and movedBy warden are refused from a non-warden consumer, and nothing is moved', async () => {
  const w = spy();
  const board = w.port('board');
  const answers = [
    await board.move!(F1, 'codex-two', { actor: 'warden' }),
    await board.move!(F1, 'codex-two', { movedBy: 'warden' }),
    await board.move!(F1, 'codex-two', { actor: 'warden', movedBy: 'warden', note: 'x' }),
  ];
  for (const answer of answers) expect(answer).toEqual(REFUSED_RESUME);
  expect(w.reached).toEqual([]);
});

test('KCB-S move by the Warden reaches the service, and another consumer’s own attribution (owner, session) still does', async () => {
  const w = spy();
  await w.port('warden').move!(F1, 'codex-two', { actor: 'warden', movedBy: 'warden' });
  await w.port('board').move!(F1, 'codex-two', { movedBy: 'session:lead' });
  await w.port('board').move!(F1, 'codex-two');
  expect(w.reached.map(r => r.member)).toEqual(['move', 'move', 'move']);
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
    expect((await w.port(plugin).start(request(by))).ok).toBe(true);
    for (const other of ['board', 'packs', 'warden', 'lessons'].filter(id => id !== plugin))
      expect(await w.port(other).start(request(by))).toMatchObject({ ok: false, error: { code: 'refused' } });
  }
  expect(w.reached).toHaveLength(bound.length);
  w.reached.length = 0;

  for (const consumer of ['board', 'lessons', 'warden'])
    for (const by of ['owner', 'ferret'] as const) expect((await w.port(consumer).start(request(by))).ok).toBe(true);
  expect(w.reached).toHaveLength(6);
});
