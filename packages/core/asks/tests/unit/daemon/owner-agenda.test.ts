import { afterEach, expect, test } from 'bun:test';
import { AskBoardSnapshotSchema, AskOwnerActionError } from '../../../contract/index.ts';
import { asksHalf } from '../../support/daemon/asks-half.ts';

const opened: Awaited<ReturnType<typeof asksHalf>>[] = [];
afterEach(async () => {
  for (const half of opened.splice(0)) await half.close();
});
async function world() {
  const half = await asksHalf();
  opened.push(half);
  const ref = await half.asks.raise({
    kind: 'yesno',
    source: 'daemon',
    entry: 'machine-result',
    ref: {},
    subject: 'Build finished',
    why: 'The result is ready.',
    raisedBy: { kind: 'daemon' },
    ferret: 'machine-agenda',
  });
  return { half, ref };
}

test('R-0044 full snapshots preserve open and parked boards and return an empty requested board', async () => {
  const { half, ref } = await world();
  await half.asks.ownerAction({ action: 'snooze', ref, until: '2026-11-08T12:00:00.000Z' as never });
  const snapshots = await half.asks.snapshots();
  expect(snapshots).toHaveLength(1);
  const snapshot = AskBoardSnapshotSchema.parse(JSON.parse(JSON.stringify(snapshots[0])));
  expect(snapshot.items[0]).toMatchObject({ subject: 'Build finished', parked: { reason: 'snoozed' } });
  expect(snapshot.count).toBe(1);
  expect((await half.asks.snapshots({ ferret: 'empty-board' }))[0]).toMatchObject({
    sessionId: 'empty-board',
    items: [],
    resolved: [],
    count: 0,
  });
});

test('R-0305 owner snooze and unsnooze retain the item and its original place', async () => {
  const { half, ref } = await world();
  const snoozed = await half.asks.ownerAction({ action: 'snooze', ref, until: '2026-11-08T12:00:00.000Z' as never });
  expect(snoozed.items[0]).toMatchObject({ parked: { reason: 'snoozed', until: '2026-11-08T12:00:00.000Z' } });
  const awake = await half.asks.ownerAction({ action: 'unsnooze', ref });
  expect(awake.items[0]?.parked).toBeUndefined();
  expect(awake.items[0]?.waitingSince).toBe(snoozed.items[0]?.waitingSince);
  expect(awake.items[0]?.id).toBe(ref.id);
});

for (const action of ['dismiss', 'resolve'] as const) {
  test(`R-0305 ${action} uses the owner actor and retains its note`, async () => {
    const { half, ref } = await world();
    const snapshot = AskBoardSnapshotSchema.parse(
      await half.asks.ownerAction({ action, ref, note: 'Checked by the owner.' }),
    );
    expect(snapshot.items).toEqual([]);
    expect(snapshot.resolved[0]).toMatchObject({
      id: ref.id,
      resolvedBy: 'human',
      resolvedBySession: null,
      resolutionNote: 'Checked by the owner.',
      disposition: action === 'dismiss' ? 'dismissed' : 'done',
    });
  });
}

test('R-0305 owner action preserves the engine refusal for missing items and past snoozes', async () => {
  const { half, ref } = await world();
  await expect(
    half.asks.ownerAction({ action: 'dismiss', ref: { ...ref, id: 'A999' as never } }),
  ).rejects.toBeInstanceOf(AskOwnerActionError);
  await expect(
    half.asks.ownerAction({ action: 'snooze', ref, until: '2020-01-01T00:00:00.000Z' as never }),
  ).rejects.toMatchObject({ code: 'invalid' });
  expect((await half.asks.snapshots({ ferret: ref.ferret }))[0]?.items).toHaveLength(1);
});

test('G40 the machine owner seam cannot answer another board as the owner', async () => {
  const { half, ref } = await world();
  await expect(half.asks.ownerAction({ action: 'resolve', ref: { ...ref, ferret: 'f1' } })).rejects.toMatchObject({
    code: 'forbidden',
  });
  expect((await half.asks.snapshots({ ferret: ref.ferret }))[0]?.items).toHaveLength(1);
});
